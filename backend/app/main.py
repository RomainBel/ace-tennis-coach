import json
import logging
import os
import re
import secrets
import sys
import time
import traceback
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, List, Literal, Optional

from dotenv import load_dotenv

# Charger les variables d’environnement avant tout import applicatif (Render, .env local).
load_dotenv()

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openai import OpenAI
from pydantic import BaseModel, Field

from app import store
from app import tennis_logic

logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("ace.api")
print(">>> BACKEND IS STARTING...", flush=True)
log.info("Python %s | cwd=%s", sys.version.split()[0], os.getcwd())

app = FastAPI(title="Coach Tennis IA API")

# CORS — local dev + frontend Vercel. Pas de "*" avec allow_credentials=True (interdit Starlette / navigateurs).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "https://ace-tennis-coach.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

KEEP_RECENT_MESSAGES = 12
SUMMARY_TRIGGER_MESSAGES = 24
SUMMARY_TRIGGER_CHARS = 12000
PROMPTS_DIR = Path(__file__).parent / "prompts"
DEFAULT_CORE_FALLBACK = (
    "Tu es Ace, coach tennis IA. Reponses courtes, actionnables, empathiques et directes. "
    "Une seule question par tour. Adapte le plan au contexte du joueur."
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class AuthSignupBody(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=256)


class AuthLoginBody(BaseModel):
    email: str
    password: str


class AuthForgotBody(BaseModel):
    email: str


class AuthResetBody(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=256)


class AuthDeleteBody(BaseModel):
    user_id: str
    password: str


@app.post("/auth/signup")
def auth_signup(body: AuthSignupBody) -> dict[str, Any]:
    try:
        user_id = store.create_user(body.email, body.password)
    except ValueError as e:
        detail = str(e)
        if detail == "email_deja_utilise":
            raise HTTPException(status_code=409, detail="Cet email est déjà utilisé.") from e
        if detail in ("email_invalide", "mot_de_passe_trop_court"):
            raise HTTPException(status_code=400, detail="Email ou mot de passe invalide.") from e
        raise HTTPException(status_code=400, detail="Inscription impossible.") from e
    return {"user_id": user_id, "email": store.normalize_email(body.email)}


@app.post("/auth/login")
def auth_login(body: AuthLoginBody) -> dict[str, str]:
    user_id = store.verify_user_password(body.email, body.password)
    if not user_id:
        raise HTTPException(status_code=401, detail="Email ou mot de passe incorrect.")
    row = store.get_user_by_id(user_id)
    return {
        "user_id": user_id,
        "email": str(row["email"]) if row else store.normalize_email(body.email),
    }


@app.post("/auth/forgot-password")
def auth_forgot_password(body: AuthForgotBody) -> dict[str, str]:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(hours=1)
    if store.set_password_reset_token(body.email, token, expires):
        base = os.getenv("PUBLIC_APP_URL", "http://localhost:3000").rstrip("/")
        reset_url = f"{base}/reset-password?token={token}"
        print(f"[auth] Lien réinitialisation mot de passe : {reset_url}")
    return {
        "ok": True,
        "detail": "Si cet email est connu, un lien de réinitialisation a été préparé.",
    }


@app.post("/auth/reset-password")
def auth_reset_password(body: AuthResetBody) -> dict[str, str]:
    row = store.get_user_by_reset_token(body.token.strip())
    if not row:
        raise HTTPException(status_code=400, detail="Lien invalide ou expiré.")
    exp_raw = row["reset_token_expires"]
    if exp_raw:
        try:
            exp = datetime.fromisoformat(str(exp_raw).replace("Z", "+00:00"))
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > exp:
                raise HTTPException(status_code=400, detail="Lien expiré.")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Lien invalide.") from exc
    user_id = str(row["user_id"])
    try:
        store.update_user_password(user_id, body.new_password)
    except ValueError as e:
        if str(e) == "mot_de_passe_trop_court":
            raise HTTPException(
                status_code=400, detail="Le mot de passe doit contenir au moins 8 caractères."
            ) from e
        raise
    return {"ok": True}


@app.post("/auth/delete-account")
def auth_delete_account(body: AuthDeleteBody) -> dict[str, str]:
    user_id = body.user_id.strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="Requête invalide.")
    if not store.verify_user_password_by_id(user_id, body.password):
        raise HTTPException(status_code=401, detail="Mot de passe incorrect.")
    store.delete_user_cascade(user_id)
    return {"ok": True}


@app.post("/speech-to-text")
async def speech_to_text(
    audio: UploadFile = File(...),
    language: str = Form(default="fr"),
) -> dict[str, str]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY manquante.")
    try:
        raw = await audio.read()
        if not raw:
            raise HTTPException(status_code=400, detail="Fichier audio vide.")
        from io import BytesIO

        bio = BytesIO(raw)
        bio.name = audio.filename or "speech.webm"
        client = OpenAI(api_key=api_key)
        transcript = client.audio.transcriptions.create(
            model=os.getenv("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe"),
            file=bio,
            language=language or "fr",
        )
        text = (getattr(transcript, "text", "") or "").strip()
        return {"text": text}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[ERROR] /speech-to-text: {exc}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ChatResponse(BaseModel):
    text: str


class ChatSendRequest(BaseModel):
    session_id: str
    message: str
    intent: Optional[str] = None
    context_type: Optional[Literal["general", "debrief", "planning", "program_adjustment"]] = "general"
    module_tag: Optional[str] = None


class ChatResetRequest(BaseModel):
    session_id: str


class SessionStateResponse(BaseModel):
    session_id: str
    summary: str
    messages: list[ChatMessage]


class PlayerProfileUpdate(BaseModel):
    display_name: Optional[str] = None
    avatar_data_url: Optional[str] = None
    gender: Optional[str] = None
    current_ranking: Optional[str] = None
    origin_ranking: Optional[str] = None
    target_ranking: Optional[str] = None
    preferred_surface: Optional[str] = None
    weekly_availability: Optional[str] = None
    injury_notes: Optional[str] = None
    playing_style: Optional[str] = None
    onboarding_completed: Optional[bool] = None


class PalmaresCreateBody(BaseModel):
    match_date: str
    opponent_name: str = ""
    opponent_ranking: str
    catalog_player_id: Optional[int] = None
    won: bool = True
    notes: str = ""


class PalmaresPatchBody(BaseModel):
    match_date: Optional[str] = None
    opponent_name: Optional[str] = None
    opponent_ranking: Optional[str] = None
    catalog_player_id: Optional[int] = None
    won: Optional[bool] = None
    notes: Optional[str] = None


class MatchCreateBody(BaseModel):
    match_datetime: str
    opponent_id: Optional[int] = None
    opponent_name: str = ""
    opponent_ranking: str = ""
    opponent_style: str = ""
    opponent_notes: str = ""
    surface: str = ""
    match_format: str = ""
    club_location: str = ""
    focus_text: str = ""


class MatchUpdateBody(BaseModel):
    match_datetime: Optional[str] = None
    opponent_id: Optional[int] = None
    opponent_name: Optional[str] = None
    opponent_ranking: Optional[str] = None
    opponent_style: Optional[str] = None
    opponent_notes: Optional[str] = None
    surface: Optional[str] = None
    match_format: Optional[str] = None
    club_location: Optional[str] = None
    focus_text: Optional[str] = None
    status: Optional[Literal["scheduled", "completed", "cancelled"]] = None
    result_score: Optional[str] = None
    result_feeling: Optional[str] = None
    outcome: Optional[str] = None


class MatchDebriefBody(BaseModel):
    result_score: str
    result_feeling: str
    opponent_name: str = ""
    opponent_ranking: str = ""
    opponent_anonymous: bool = False


class OpponentUpsertBody(BaseModel):
    name: str
    rank: str = ""
    play_style: str = ""
    notes_perso: str = ""


class TaskPatchBody(BaseModel):
    status: Optional[Literal["pending", "done", "skipped", "postponed"]] = None
    title: Optional[str] = None
    description: Optional[str] = None
    postponed_to_date: Optional[str] = None
    task_date: Optional[str] = None
    task_type: Optional[str] = None
    duration_min: Optional[int] = None


class ProgramTaskSuggestBody(BaseModel):
    session_id: str = Field(..., min_length=1)
    intent: str = Field(..., min_length=2, max_length=4000)


class ProgramTaskManualAddBody(BaseModel):
    session_id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1, max_length=500)
    description: str = ""
    task_type: str = "technique"
    duration_min: int = Field(default=30, ge=15, le=120)
    task_date: Optional[str] = None


class StaffPolesBody(BaseModel):
    technique: Optional[bool] = None
    physical: Optional[bool] = None
    mental: Optional[bool] = None
    nutrition: Optional[bool] = None
    recovery: Optional[bool] = None


class ContextMemoryBody(BaseModel):
    objective_long_term: Optional[str] = None
    current_technical_focus: Optional[str] = None
    next_match_strategy: Optional[str] = None
    next_match_info: Optional[dict[str, Any]] = None
    fatigue_level: Optional[int] = None
    physical_notes: Optional[str] = None
    mental_state: Optional[str] = None
    confidence_level: Optional[int] = None
    weekly_availability_context: Optional[str] = None
    extra_notes: Optional[str] = None
    # Retour sur le programme de la semaine (souvent saisi au debrief du match)
    program_week_helpful: Optional[str] = None
    program_week_notes: Optional[str] = None
    program_feedback_at: Optional[str] = None
    program_feedback_match_id: Optional[int] = None
    # Dernier ressenti express sur une tâche (easy / hard / long / great) — souvent saisi à la validation
    session_task_feeling: Optional[str] = None
    session_task_feeling_at: Optional[str] = None
    session_task_feeling_task_id: Optional[int] = None
    session_task_feeling_notes: Optional[str] = None


class HypotheticalMatch(BaseModel):
    opponent_ranking: str = Field(..., description="Classement FFT de l'adversaire, ex: 30/2")
    won: bool = True


class SimulateRankingBody(BaseModel):
    session_id: str
    hypothetical_victories: List[HypotheticalMatch]


class TenupImportParseBody(BaseModel):
    session_id: str
    current_ranking: str = ""
    origin_ranking: str = ""
    target_ranking: str = ""
    gender: str = "M"
    images_data_urls: List[str] = Field(default_factory=list)


class TenupImportParsedMatch(BaseModel):
    match_date: str
    opponent_name: str = ""
    opponent_ranking: str
    won: bool
    notes: str = ""


class TenupImportCommitBody(BaseModel):
    session_id: str
    current_ranking: str = ""
    origin_ranking: str = ""
    target_ranking: str = ""
    gender: str = "M"
    matches: List[TenupImportParsedMatch] = Field(default_factory=list)


SYSTEM_PROMPT_SAAS = """Tu es Ace, coach tennis IA. Ton role: aider le joueur a atteindre son objectif
de classement en preparant son PROCHAIN MATCH.

Regles:
- Toujours partir du prochain match (date, adversaire, focus unique).
- Ton motivant, expert, concis. Francais.
- Propose un plan concret (nutrition, physique, tennis, mental) et adapte-le selon les messages.
- Quand le joueur donne des infos (match, focus, ressenti), utilise les outils pour mettre a jour le dashboard (profil, match, programme) — ne te contente pas de repondre sans agir si une mise a jour est attendue.
- Les types de taches sont: technique, physical, mental, nutrition, recovery. Chaque tache doit avoir un type coherent et une duree_min.
- Pour chaque tache, la description doit etre en Markdown structure avec:
  - "## Objectif"
  - "## Protocole" (etapes 1,2,3)
  - "## Le Tip de Ace" (astuce personnalisee selon le contexte)
- Respecte le staff actif: si un pole est desactive, ne cree aucune tache de ce type.
- Si le contexte est incomplet (prochain match/forme/disponibilites), pose les questions de clarification.
- En debut de semaine, regenere un programme hebdo adapte au contexte courant.
- Si le joueur ne donne pas d'info, sois proactif et commence par "Quand est prevu ton prochain match ?".
- Mets a jour le context memory a chaque echange utile (fatigue, confiance, focus, disponibilites, strategie, infos match).

Classement FFT (rappel produit) :
""" + tennis_logic.fft_monthly_update_sentence() + """
- Le backend utilise un modele FFT renforce (capital de depart + fenetre 12 mois + barème de victoires). Si une regle avancee manque, rappelle que seul le barème officiel FFT fait foi.
- Pour estimer combien de victoires il lui manque avant le prochain palier, base-toi sur les points affiches dans le dashboard et sur l'outil simulateur cote UX quand il l'utilise.

Apres chaque match en debrief :
1) Demande le score et le ressenti, puis appelle complete_match_debrief.
2) Demande OBLIGATOIREMENT le classement FFT exact de l'adversaire (ex: 30/2) et si c'est une victoire ou une defaite.
3) Appelle apply_fft_match_points avec match_id, won (true/false), opponent_ranking (string FFT). Ne pas sauter cette etape si le joueur a donne ces infos — cela met a jour ses points et sa serie de victoires.

Ensuite, planifie le prochain match avec le joueur."""

SUMMARY_PROMPT = """Tu maintiens la memoire long terme d'un coach tennis IA.
Mets a jour le resume en respectant STRICTEMENT ce format:

Profil joueur:
- ...

Objectifs:
- ...

Problemes recurrents:
- ...

Conseils deja donnes:
- ...

Exercices proposes:
- ...

Contraintes:
- ...

Dernier plan d'action:
- ...

Regles:
- Reste factuel, concis, actionnable.
- Preserve les infos importantes des echanges precedents.
- Si une section est inconnue, mets "- Non defini pour le moment."
"""

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "update_player_profile",
            "description": "Met a jour le profil joueur (champs partiels).",
            "parameters": {
                "type": "object",
                "properties": {
                    "display_name": {"type": "string"},
                    "avatar_data_url": {"type": "string"},
                    "current_ranking": {"type": "string"},
                    "target_ranking": {"type": "string"},
                    "preferred_surface": {"type": "string"},
                    "weekly_availability": {"type": "string"},
                    "injury_notes": {"type": "string"},
                    "playing_style": {
                        "type": "string",
                        "description": "Style de jeu court (ex: puissant fond de court)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_next_match",
            "description": "Definit ou remplace le prochain match (ISO8601 pour match_datetime).",
            "parameters": {
                "type": "object",
                "properties": {
                    "match_datetime": {"type": "string"},
                    "opponent_id": {"type": "integer"},
                    "opponent_name": {"type": "string"},
                    "opponent_ranking": {"type": "string"},
                    "opponent_style": {"type": "string"},
                    "opponent_notes": {"type": "string"},
                    "surface": {"type": "string"},
                    "match_format": {"type": "string"},
                    "club_location": {"type": "string"},
                    "focus_text": {"type": "string"},
                },
                "required": ["match_datetime"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_match_fields",
            "description": "Met a jour le match courant (scheduled) par id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "match_id": {"type": "integer"},
                    "match_datetime": {"type": "string"},
                    "opponent_id": {"type": "integer"},
                    "opponent_name": {"type": "string"},
                    "opponent_ranking": {"type": "string"},
                    "opponent_style": {"type": "string"},
                    "opponent_notes": {"type": "string"},
                    "surface": {"type": "string"},
                    "match_format": {"type": "string"},
                    "club_location": {"type": "string"},
                    "focus_text": {"type": "string"},
                    "outcome": {"type": "string"},
                },
                "required": ["match_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "complete_match_debrief",
            "description": (
                "Enregistre score + ressenti et marque le match complete. "
                "Ensuite demande classement adversaire + victoire/defaite et appelle apply_fft_match_points."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "match_id": {"type": "integer"},
                    "result_score": {"type": "string"},
                    "result_feeling": {"type": "string"},
                },
                "required": ["match_id", "result_score", "result_feeling"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_fft_match_points",
            "description": (
                "Apres un match complete : enregistre victoire ou defaite et le classement FFT exact "
                "de l'adversaire, met a jour les points du profil (modele simplifie) et la serie de victoires. "
                "Une seule fois par match."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "match_id": {"type": "integer"},
                    "won": {"type": "boolean"},
                    "opponent_ranking": {
                        "type": "string",
                        "description": "Classement FFT adversaire, ex: 30/1, 15/3, N.2",
                    },
                },
                "required": ["match_id", "won", "opponent_ranking"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "replace_program_tasks",
            "description": (
                "Remplace les taches programme a partir de la date minimale fournie. "
                "Types: technique, physical, mental, nutrition, recovery. "
                "task_date format YYYY-MM-DD. "
                "description en markdown avec sections Objectif / Protocole / Le Tip de Ace."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "task_date": {"type": "string"},
                                "task_type": {
                                    "type": "string",
                                    "enum": ["technique", "physical", "mental", "nutrition", "recovery"],
                                },
                                "title": {"type": "string"},
                                "duration_min": {"type": "integer"},
                                "description": {"type": "string"},
                                "sort_order": {"type": "integer"},
                            },
                            "required": ["task_date", "task_type", "title"],
                        },
                    }
                },
                "required": ["tasks"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_program_task",
            "description": "Met a jour une tache par id (statut, report, texte).",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "integer"},
                    "status": {
                        "type": "string",
                        "enum": ["pending", "done", "skipped", "postponed"],
                    },
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "postponed_to_date": {"type": "string"},
                    "task_date": {"type": "string"},
                    "task_type": {
                        "type": "string",
                        "enum": ["technique", "physical", "mental", "nutrition", "recovery"],
                    },
                    "duration_min": {"type": "integer"},
                },
                "required": ["task_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_context_memory",
            "description": "Met a jour la memoire contexte persistante avec les infos recentes du joueur.",
            "parameters": {
                "type": "object",
                "properties": {
                    "objective_long_term": {"type": "string"},
                    "current_technical_focus": {"type": "string"},
                    "next_match_strategy": {"type": "string"},
                    "next_match_info": {"type": "object"},
                    "fatigue_level": {"type": "integer"},
                    "physical_notes": {"type": "string"},
                    "mental_state": {"type": "string"},
                    "confidence_level": {"type": "integer"},
                    "weekly_availability_context": {"type": "string"},
                    "extra_notes": {"type": "string"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_staff_poles",
            "description": "Active/desactive des poles du staff: technique, physical, mental, nutrition, recovery.",
            "parameters": {
                "type": "object",
                "properties": {
                    "technique": {"type": "boolean"},
                    "physical": {"type": "boolean"},
                    "mental": {"type": "boolean"},
                    "nutrition": {"type": "boolean"},
                    "recovery": {"type": "boolean"},
                },
            },
        },
    },
]


@app.on_event("startup")
def startup() -> None:
    try:
        db_path = getattr(store, "DB_PATH", "?")
        log.info("SQLite path: %s", os.path.abspath(db_path))
        store.init_db()
        log.info("SQLite init_db OK.")
    except Exception:
        log.exception("startup / init_db crashed — voir la traceback ci-dessous")
        raise


def should_summarize(messages: list[dict[str, str]]) -> bool:
    if len(messages) >= SUMMARY_TRIGGER_MESSAGES:
        return True
    total_chars = sum(len(m["content"]) for m in messages)
    return total_chars >= SUMMARY_TRIGGER_CHARS


def maybe_summarize_history(client: OpenAI, model: str, session_id: str) -> None:
    all_messages = store.get_all_chat_messages(session_id)
    if not should_summarize(all_messages):
        return
    if len(all_messages) <= KEEP_RECENT_MESSAGES:
        return

    older = all_messages[:-KEEP_RECENT_MESSAGES]
    recent = all_messages[-KEEP_RECENT_MESSAGES:]
    existing_summary = store.get_chat_summary(session_id)
    history_lines = [f"{m['role']}: {m['content']}" for m in older]
    history_text = "\n".join(history_lines)
    previous = existing_summary.strip() or "Aucun resume precedent."
    summary_input = (
        f"Resume precedent:\n{previous}\n\nNouveaux echanges a compresser:\n{history_text}"
    )

    completion = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SUMMARY_PROMPT},
            {"role": "user", "content": summary_input},
        ],
    )
    new_summary = (completion.choices[0].message.content or "").strip()
    if not new_summary:
        return
    store.update_chat_summary(session_id, new_summary)
    store.prune_chat_messages_keep_recent(session_id, len(recent))


def _has_explicit_confirmation(user_message: str) -> bool:
    text = (user_message or "").strip().lower()
    if not text:
        return False
    keywords = (
        "oui",
        "ok",
        "vas-y",
        "go",
        "confirm",
        "confirme",
        "tu peux",
        "fais-le",
        "fais le",
        "lance",
        "mets a jour",
        "met a jour",
        "ajoute",
        "supprime",
        "reporte",
        "modifie",
        "change",
    )
    return any(k in text for k in keywords)


def _format_focus_text_as_match_keys(raw: Any) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""

    lines = [ln.strip() for ln in text.replace("\r\n", "\n").split("\n") if ln.strip()]
    points: list[str] = []

    for ln in lines:
        cleaned = re.sub(r"^\d+[\.\)]\s*", "", ln)
        cleaned = re.sub(r"^[-*•]\s*", "", cleaned).strip()
        if not cleaned:
            continue
        lower = cleaned.lower()
        if lower.startswith("cl") and "match" in lower and ":" in lower:
            continue
        points.append(cleaned)
        if len(points) >= 3:
            break

    if not points:
        # Fallback: decoupe simple en phrases courtes, max 3.
        chunks = [c.strip() for c in re.split(r"[;\n]+|(?<=[.!?])\s+", text) if c.strip()]
        for c in chunks:
            cleaned = re.sub(r"^\d+[\.\)]\s*", "", c).strip(" -•*")
            if cleaned:
                points.append(cleaned)
            if len(points) >= 3:
                break

    if not points:
        return ""

    return "\n".join(f"{i + 1}. {p}" for i, p in enumerate(points[:3]))


def execute_tool(
    session_id: str, name: str, arguments: dict[str, Any], user_message: str
) -> dict[str, Any]:
    if not _has_explicit_confirmation(user_message):
        return {
            "ok": False,
            "error": "confirmation_required",
            "message": (
                "Modification bloquee: confirmation explicite requise. "
                "Demande d'abord validation utilisateur, puis execute l'outil au prochain tour."
            ),
        }

    if name == "update_player_profile":
        args = {k: v for k, v in arguments.items() if v is not None}
        if args:
            store.update_profile(session_id, **args)
        store.sync_points_from_ranking_labels(session_id)
        return {"ok": True, "updated": list(args.keys())}

    if name == "set_next_match":
        focus_text = _format_focus_text_as_match_keys(arguments.get("focus_text") or "")
        mid = store.create_match(
            session_id,
            match_datetime=arguments["match_datetime"],
            opponent_id=arguments.get("opponent_id"),
            opponent_name=arguments.get("opponent_name") or "",
            opponent_ranking=arguments.get("opponent_ranking") or "",
            opponent_style=arguments.get("opponent_style") or "",
            opponent_notes=arguments.get("opponent_notes") or "",
            surface=arguments.get("surface") or "",
            match_format=arguments.get("match_format") or "",
            club_location=arguments.get("club_location") or "",
            focus_text=focus_text,
        )
        return {"ok": True, "match_id": mid}

    if name == "update_match_fields":
        focus_text_raw = arguments.get("focus_text")
        focus_text = (
            _format_focus_text_as_match_keys(focus_text_raw)
            if focus_text_raw is not None
            else None
        )
        ok = store.update_match(
            int(arguments["match_id"]),
            session_id,
            match_datetime=arguments.get("match_datetime"),
            opponent_id=arguments.get("opponent_id"),
            opponent_name=arguments.get("opponent_name"),
            opponent_ranking=arguments.get("opponent_ranking"),
            opponent_style=arguments.get("opponent_style"),
            opponent_notes=arguments.get("opponent_notes"),
            surface=arguments.get("surface"),
            match_format=arguments.get("match_format"),
            club_location=arguments.get("club_location"),
            focus_text=focus_text,
            outcome=arguments.get("outcome"),
        )
        return {"ok": ok}

    if name == "complete_match_debrief":
        ok = store.complete_match_debrief(
            session_id,
            int(arguments["match_id"]),
            str(arguments["result_score"]),
            str(arguments["result_feeling"]),
        )
        return {"ok": ok}

    if name == "apply_fft_match_points":
        return store.apply_fft_match_points(
            session_id,
            int(arguments["match_id"]),
            bool(arguments["won"]),
            str(arguments["opponent_ranking"]).strip(),
        )

    if name == "replace_program_tasks":
        match_row = store.get_next_scheduled_match(session_id)
        mid = int(match_row["id"]) if match_row else None
        last_err: Optional[Exception] = None
        for _ in range(3):
            try:
                count = store.replace_program_tasks(session_id, mid, list(arguments["tasks"]))
                return {"ok": True, "tasks_written": count}
            except Exception as exc:
                last_err = exc
                if "database is locked" not in str(exc).lower():
                    raise
                time.sleep(0.35)
        if last_err is not None:
            raise last_err
        return {"ok": False, "error": "replace_program_tasks_failed"}

    if name == "update_program_task":
        ok = store.update_task(
            int(arguments["task_id"]),
            session_id,
            status=arguments.get("status"),
            title=arguments.get("title"),
            description=arguments.get("description"),
            postponed_to_date=arguments.get("postponed_to_date"),
            task_date=arguments.get("task_date"),
            task_type=arguments.get("task_type"),
            duration_min=arguments.get("duration_min"),
        )
        return {"ok": ok}

    if name == "update_context_memory":
        patch = {k: v for k, v in arguments.items() if v is not None}
        ctx = store.update_context_memory(session_id, patch)
        return {"ok": True, "context_keys": list(ctx.keys())}

    if name == "update_staff_poles":
        poles = {
            k: bool(v)
            for k, v in arguments.items()
            if k in ("technique", "physical", "mental", "nutrition", "recovery")
        }
        out = store.set_staff_poles(session_id, poles)
        return {"ok": True, "staff_poles": out}

    return {"ok": False, "error": f"unknown_tool:{name}"}


def _read_prompt_file(filename: str, fallback: str = "") -> str:
    path = PROMPTS_DIR / filename
    try:
        return path.read_text(encoding="utf-8").strip() or fallback
    except Exception:
        return fallback


def _parse_module_registry(registry_text: str) -> dict[str, str]:
    """
    Parse lines like:
    - match_debrief: module_match_debrief.txt
    """
    out: dict[str, str] = {}
    for raw in registry_text.splitlines():
        line = raw.strip()
        if not line.startswith("- "):
            continue
        payload = line[2:].strip()
        if ":" not in payload:
            continue
        tag, filename = payload.split(":", 1)
        tag = tag.strip().lower()
        filename = filename.strip()
        if tag and filename:
            out[tag] = filename
    return out


def build_system_instructions(
    context_type: Optional[str],
    module_tag: Optional[str],
    intent: Optional[str],
) -> str:
    core = _read_prompt_file("system_core.txt", DEFAULT_CORE_FALLBACK)
    modules_registry_text = _read_prompt_file("system_modules.txt", "")
    module_registry = _parse_module_registry(modules_registry_text)

    normalized_context = (context_type or "general").strip().lower()
    normalized_tag = (module_tag or "").strip().lower()
    effective_tag = normalized_tag
    if not effective_tag and normalized_context == "debrief":
        effective_tag = "match_debrief"
    if not effective_tag and normalized_context == "planning":
        effective_tag = "planning"
    if not effective_tag and normalized_context == "program_adjustment":
        effective_tag = "program_adjustment"
    if not effective_tag:
        effective_tag = "general"

    parts = [core]
    module_filename = module_registry.get(effective_tag)
    if module_filename:
        module_text = _read_prompt_file(module_filename, "")
        if module_text:
            parts.append(f"[MODULE:{effective_tag}]\n{module_text}")
    if normalized_context == "planning":
        parts.append(
            "Contexte planning: privilegie la planification concrete de la semaine, "
            "avec taches courtes et realistes selon la disponibilite."
        )
    if normalized_context == "program_adjustment":
        parts.append(
            "Contexte ajustement du jour: ajuster rapidement les taches existantes selon contraintes immediates, "
            "sans relancer un questionnaire large."
        )
    if intent:
        parts.append(f"Intent utilisateur (CTA): {intent}")
    return "\n\n".join(p for p in parts if p and p.strip())


def _trim_text(value: Any, max_len: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."


def compact_dashboard_for_prompt(session_id: str) -> str:
    raw = store.dashboard_payload(session_id)
    profile = raw.get("profile", {}) or {}
    match = raw.get("match", {}) or {}
    today = raw.get("program_today", []) or []
    upcoming = raw.get("program_until_match", []) or []
    history = raw.get("match_history", []) or []

    def compact_task(t: dict[str, Any]) -> dict[str, Any]:
        return {
            "task_date": t.get("task_date"),
            "task_type": t.get("task_type"),
            "duration_min": t.get("duration_min"),
            "title": _trim_text(t.get("title"), 120),
            "description": _trim_text(t.get("description"), 280),
            "status": t.get("status"),
        }

    compact = {
        "session_id": raw.get("session_id"),
        "profile": {
            "display_name": profile.get("display_name"),
            "current_ranking": profile.get("current_ranking"),
            "target_ranking": profile.get("target_ranking"),
            "current_points": profile.get("current_points"),
            "target_points": profile.get("target_points"),
            "win_streak": profile.get("win_streak"),
            "playing_style": _trim_text(profile.get("playing_style"), 120),
        },
        "match": {
            "id": match.get("id"),
            "status": match.get("status"),
            "match_datetime": match.get("match_datetime"),
            "opponent_name": _trim_text(match.get("opponent_name"), 80),
            "opponent_ranking": match.get("opponent_ranking"),
            "surface": match.get("surface"),
            "match_format": _trim_text(match.get("match_format"), 100),
            "club_location": _trim_text(match.get("club_location"), 100),
            "focus_text": _trim_text(match.get("focus_text"), 240),
            "result_score": _trim_text(match.get("result_score"), 80),
            "result_feeling": _trim_text(match.get("result_feeling"), 180),
            "points_if_win": match.get("points_if_win"),
            "stakes_label": _trim_text(match.get("stakes_label"), 80),
        },
        "program_today": [compact_task(t) for t in today[:5]],
        "program_until_match": [compact_task(t) for t in upcoming[:8]],
        "match_history": [
            {
                "match_date": h.get("match_date"),
                "outcome": h.get("outcome"),
                "score": _trim_text(h.get("score"), 40),
                "opponent_name": _trim_text(h.get("opponent_name"), 80),
                "sensations": _trim_text(h.get("sensations"), 140),
            }
            for h in history[:8]
        ],
        "ranking_model_note": raw.get("ranking_model_note"),
    }
    return json.dumps(compact, ensure_ascii=False, indent=2)


def run_chat_with_tools(
    client: OpenAI,
    model: str,
    session_id: str,
    user_message: str,
    intent: Optional[str],
    context_type: Optional[str] = "general",
    module_tag: Optional[str] = None,
) -> str:
    messages_api, had_successful_tool_write = _prepare_messages_and_resolve_tools(
        client=client,
        model=model,
        session_id=session_id,
        user_message=user_message,
        intent=intent,
        context_type=context_type,
        module_tag=module_tag,
    )
    completion = client.chat.completions.create(
        model=model,
        messages=messages_api,
    )
    choice = completion.choices[0].message
    text = (choice.content or "").strip()
    if had_successful_tool_write and text:
        lowered = text.lower()
        if "dashboard" not in lowered and "c'est fait" not in lowered and "c est fait" not in lowered:
            text = f"{text}\n\nC'est fait ! Ton dashboard a été mis à jour."
    return text or "Je suis Ace. Dis-moi ton prochain objectif pour ce match."


def _prepare_messages_and_resolve_tools(
    *,
    client: OpenAI,
    model: str,
    session_id: str,
    user_message: str,
    intent: Optional[str],
    context_type: Optional[str] = "general",
    module_tag: Optional[str] = None,
) -> tuple[list[dict[str, Any]], bool]:
    dashboard = compact_dashboard_for_prompt(session_id)
    summary = store.get_chat_summary(session_id)
    context_memory = json.dumps(store.get_context_memory(session_id), ensure_ascii=False, indent=2)
    staff_poles = json.dumps(store.get_staff_poles(session_id), ensure_ascii=False)
    system_prompt = build_system_instructions(context_type, module_tag, intent)
    now_local = datetime.now()
    weekday_fr = [
        "lundi",
        "mardi",
        "mercredi",
        "jeudi",
        "vendredi",
        "samedi",
        "dimanche",
    ][now_local.weekday()]
    system_parts = [system_prompt, f"Contexte dashboard (JSON):\n{dashboard}"]
    system_parts.append(
        f"Repere temporel courant: aujourd'hui = {now_local.date().isoformat()} ({weekday_fr}), heure locale = {now_local.strftime('%H:%M')}."
    )
    system_parts.append(f"Context memory (JSON):\n{context_memory}")
    system_parts.append(f"Staff poles actifs (JSON): {staff_poles}")
    if summary.strip():
        system_parts.append(
            "Memoire long terme (resume):\n" + summary.strip(),
        )

    messages_api: list[dict[str, Any]] = [
        {"role": "system", "content": "\n\n".join(system_parts)},
    ]
    had_successful_tool_write = False
    for msg in store.get_recent_chat_messages(session_id, KEEP_RECENT_MESSAGES)[-8:]:
        if msg["role"] == "system":
            continue
        content = (msg["content"] or "").strip()
        if len(content) > 4000:
            content = content[:4000] + "\n...[message tronqué]"
        messages_api.append({"role": msg["role"], "content": content})

    for _ in range(6):
        completion = client.chat.completions.create(
            model=model,
            messages=messages_api,
            tools=TOOLS,
            tool_choice="auto",
        )
        choice = completion.choices[0].message
        tool_calls = choice.tool_calls
        if tool_calls:
            dumped = choice.model_dump(exclude_none=True)
            messages_api.append(dumped)
            for tc in tool_calls:
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                try:
                    result = execute_tool(session_id, tc.function.name, args, user_message=user_message)
                except Exception as tool_exc:
                    # Never crash the whole chat turn on a single tool failure.
                    print(f"[ERROR] tool call failed session_id={session_id} tool={tc.function.name}: {tool_exc}")
                    traceback.print_exc()
                    result = {
                        "ok": False,
                        "error": str(tool_exc),
                        "tool": tc.function.name,
                    }
                messages_api.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(result, ensure_ascii=False),
                    }
                )
                if bool(result.get("ok")):
                    had_successful_tool_write = True
            continue

        return messages_api, had_successful_tool_write

    raise RuntimeError("Je suis Ace. La reponse est trop complexe, reformule en une phrase.")


def _maybe_apply_fft_after_match_update(session_id: str, match_id: int) -> None:
    row = store.get_match_row(match_id, session_id)
    if not row:
        return
    if str(row["status"] or "").strip().lower() != "completed":
        return
    if int(row["fft_points_applied"] or 0) == 1:
        return
    outcome = str(row["outcome"] or "").strip().lower()
    if outcome not in {"won", "lost"}:
        return
    opponent_ranking = str(row["opponent_ranking"] or "").strip()
    if not opponent_ranking:
        return
    if tennis_logic.normalize_label(opponent_ranking) not in tennis_logic.ECHELONS:
        return
    try:
        store.apply_fft_match_points(
            session_id=session_id,
            match_id=match_id,
            won=(outcome == "won"),
            opponent_ranking_fft=opponent_ranking,
        )
    except Exception as exc:
        print(f"[WARN] auto apply FFT failed session_id={session_id} match_id={match_id}: {exc}")
        traceback.print_exc()


def _extract_ranking_label(text: str) -> Optional[str]:
    m = re.search(r"\b(40|30[/\-][1-5]|15[/\-][1-5]|N\.?[1-3]|PRO)\b", text, flags=re.I)
    if not m:
        return None
    return tennis_logic.normalize_label(m.group(1))


def _extract_fatigue_level(msg: str) -> Optional[int]:
    m = re.search(r"fatigue\s*(?:niveau|=|:)?\s*([1-5])", msg, flags=re.I)
    if m:
        return int(m.group(1))
    low_markers = ("super bien", "en forme", "plein d'energie", "plein d’énergie", "frais")
    high_markers = ("epuise", "épuisé", "creve", "crevé", "fatigue", "fatigué", "rincé")
    if any(k in msg.lower() for k in low_markers):
        return 1
    if any(k in msg.lower() for k in high_markers):
        return 4
    return None


def _extract_confidence(msg: str) -> Optional[int]:
    m = re.search(r"confiance\s*(?:niveau|=|:)?\s*([1-5])", msg, flags=re.I)
    if m:
        return int(m.group(1))
    if any(k in msg.lower() for k in ("confiant", "confiante", "confiance totale")):
        return 4
    if any(k in msg.lower() for k in ("pas confiant", "pas en confiance", "doute")):
        return 2
    return None


def _extract_next_match_info(msg: str, current: dict[str, Any]) -> dict[str, Any]:
    info = dict(current or {})
    lower = msg.lower()
    date_marker: Optional[str] = None
    if "demain" in lower:
        date_marker = (date.today() + timedelta(days=1)).isoformat()
    elif "aujourd" in lower:
        date_marker = date.today().isoformat()
    elif "samedi" in lower:
        date_marker = "samedi"
    elif "dimanche" in lower:
        date_marker = "dimanche"
    if date_marker:
        info["date"] = date_marker
    if "terre battue" in lower:
        info["surface"] = "terre battue"
    elif "dur" in lower:
        info["surface"] = "dur"
    elif "gazon" in lower:
        info["surface"] = "gazon"
    rank = _extract_ranking_label(msg)
    if rank:
        info["opponent_ranking"] = rank
    if "gaucher" in lower:
        info["opponent_type"] = "gaucher"
    if "attaquant" in lower:
        info["opponent_type"] = "attaquant"
    if "defensif" in lower or "défensif" in lower:
        info["opponent_type"] = "defensif"
    return info


def passive_memory_update_from_user_message(session_id: str, user_message: str) -> None:
    """Deterministic passive memory updates from latest user message."""
    msg = user_message.strip()
    lower = msg.lower()
    patch: dict[str, Any] = {}

    target = _extract_ranking_label(msg)
    if target and ("objectif" in lower or "passer" in lower):
        patch["objective_long_term"] = f"Atteindre {target}"

    for key in ("retour de service", "service", "revers", "coup droit", "volée", "volee"):
        if key in lower:
            patch["current_technical_focus"] = key.replace("volee", "volée")
            break

    if "strategie" in lower or "stratégie" in lower or "tactique" in lower:
        patch["next_match_strategy"] = msg

    fatigue = _extract_fatigue_level(msg)
    if fatigue is not None:
        patch["fatigue_level"] = max(1, min(5, fatigue))

    confidence = _extract_confidence(msg)
    if confidence is not None:
        patch["confidence_level"] = max(1, min(5, confidence))
        patch["mental_state"] = "en confiance" if confidence >= 4 else "à stabiliser"

    if any(k in lower for k in ("bosse tard", "je travaille tard", "peu de temps", "20min", "20 min")):
        patch["weekly_availability_context"] = "Disponibilité réduite cette semaine"

    current_ctx = store.get_context_memory(session_id)
    next_match_info = _extract_next_match_info(msg, current_ctx.get("next_match_info", {}))
    if next_match_info:
        patch["next_match_info"] = next_match_info

    if any(k in lower for k in ("douleur", "douleurs", "genou", "epaule", "épaule", "poignet")):
        patch["physical_notes"] = msg

    if patch:
        store.update_context_memory(session_id, patch)

    # Passive palmares sync on explicit recent win/loss mention
    if ("victoire" in lower or "j'ai gagné" in lower or "jai gagne" in lower or "defaite" in lower or "défaite" in lower) and ("hier" in lower or "aujourd" in lower):
        won = not ("defaite" in lower or "défaite" in lower or "j'ai perdu" in lower or "jai perdu" in lower)
        match_date = date.today().isoformat() if "aujourd" in lower else (date.today() - timedelta(days=1)).isoformat()
        opp = _extract_ranking_label(msg) or "30/2"
        note = f"Capture passive: {msg[:180]}"
        existing = store.list_palmares_entries(session_id)
        already = any((e["match_date"] == match_date and e["won"] == won and note[:60] in (e.get("notes") or "")) for e in existing)
        if not already:
            try:
                store.add_palmares_entry(
                    session_id=session_id,
                    match_date=match_date,
                    opponent_name="",
                    opponent_ranking=opp,
                    catalog_player_id=None,
                    won=won,
                    notes=note,
                )
            except Exception:
                pass


@app.post("/chat", response_model=ChatResponse)
def chat(payload: ChatSendRequest) -> ChatResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail=(
                "OPENAI_API_KEY manquante. Ajoute ta cle dans backend/.env "
                "puis redemarre le serveur."
            ),
        )

    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    client = OpenAI(api_key=api_key)
    session_id = payload.session_id.strip()
    user_message = payload.message.strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id est obligatoire.")
    if not user_message:
        raise HTTPException(status_code=400, detail="message est obligatoire.")

    store.ensure_profile(session_id)
    store.add_chat_message(session_id, "user", user_message)
    passive_memory_update_from_user_message(session_id, user_message)

    try:
        answer = run_chat_with_tools(
            client,
            model,
            session_id,
            user_message,
            payload.intent,
            payload.context_type,
            payload.module_tag,
        )
    except Exception as exc:
        err_text = str(exc)
        if "context_length_exceeded" in err_text or "maximum context length" in err_text:
            print(f"[WARN] context too long for session {session_id}, forcing summarization retry")
            try:
                maybe_summarize_history(client, model, session_id)
                answer = run_chat_with_tools(
                    client,
                    model,
                    session_id,
                    user_message,
                    payload.intent,
                    payload.context_type,
                    payload.module_tag,
                )
            except Exception as retry_exc:
                print(f"[ERROR] /chat retry failed session_id={session_id}: {retry_exc}")
                traceback.print_exc()
                raise HTTPException(status_code=500, detail=str(retry_exc)) from retry_exc
        else:
            print(f"[ERROR] /chat session_id={session_id}: {exc}")
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    store.add_chat_message(session_id, "assistant", answer)
    maybe_summarize_history(client, model, session_id)
    return ChatResponse(text=answer)


@app.post("/chat/stream")
def chat_stream(payload: ChatSendRequest) -> StreamingResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail=(
                "OPENAI_API_KEY manquante. Ajoute ta cle dans backend/.env "
                "puis redemarre le serveur."
            ),
        )

    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    client = OpenAI(api_key=api_key)
    session_id = payload.session_id.strip()
    user_message = payload.message.strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id est obligatoire.")
    if not user_message:
        raise HTTPException(status_code=400, detail="message est obligatoire.")

    store.ensure_profile(session_id)
    store.add_chat_message(session_id, "user", user_message)
    passive_memory_update_from_user_message(session_id, user_message)

    def _sse(data: dict[str, Any]) -> bytes:
        return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")

    def event_stream():
        assembled_text = ""
        try:
            retry_once = False
            while True:
                try:
                    messages_api, had_successful_tool_write = _prepare_messages_and_resolve_tools(
                        client=client,
                        model=model,
                        session_id=session_id,
                        user_message=user_message,
                        intent=payload.intent,
                        context_type=payload.context_type,
                        module_tag=payload.module_tag,
                    )
                    break
                except Exception as exc:
                    err_text = str(exc)
                    if not retry_once and ("context_length_exceeded" in err_text or "maximum context length" in err_text):
                        retry_once = True
                        print(f"[WARN] context too long for session {session_id}, forcing summarization retry (stream)")
                        maybe_summarize_history(client, model, session_id)
                        continue
                    raise

            stream = client.chat.completions.create(
                model=model,
                messages=messages_api,
                stream=True,
            )
            for chunk in stream:
                try:
                    delta = chunk.choices[0].delta.content or ""
                except Exception:
                    delta = ""
                if not delta:
                    continue
                assembled_text += delta
                yield _sse({"type": "chunk", "text": delta})

            text = assembled_text.strip() or "Je suis Ace. Dis-moi ton prochain objectif pour ce match."
            if had_successful_tool_write and text:
                lowered = text.lower()
                if "dashboard" not in lowered and "c'est fait" not in lowered and "c est fait" not in lowered:
                    suffix = "\n\nC'est fait ! Ton dashboard a été mis à jour."
                    text = f"{text}{suffix}"
                    yield _sse({"type": "chunk", "text": suffix})

            store.add_chat_message(session_id, "assistant", text)
            maybe_summarize_history(client, model, session_id)
            yield _sse({"type": "done", "text": text})
        except Exception as exc:
            print(f"[ERROR] /chat/stream session_id={session_id}: {exc}")
            traceback.print_exc()
            yield _sse({"type": "error", "detail": str(exc)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@app.get("/chat/session/{session_id}", response_model=SessionStateResponse)
def get_session_state(session_id: str) -> SessionStateResponse:
    store.upsert_chat_session(session_id)
    msgs = store.get_all_chat_messages(session_id)
    return SessionStateResponse(
        session_id=session_id,
        summary=store.get_chat_summary(session_id),
        messages=[ChatMessage(role=m["role"], content=m["content"]) for m in msgs],
    )


@app.post("/chat/reset")
def reset_chat(payload: ChatResetRequest) -> dict[str, str]:
    session_id = payload.session_id.strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id est obligatoire.")
    store.reset_chat_session(session_id)
    return {"status": "ok"}


@app.get("/dashboard/{session_id}")
def get_dashboard(session_id: str) -> dict[str, Any]:
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    try:
        return store.dashboard_payload(sid)
    except Exception as exc:
        print(f"[ERROR] /dashboard/{sid}: {exc}")
        traceback.print_exc()
        # Fallback ultra-defensif pour éviter un plantage front au boot
        return {
            "session_id": sid,
            "profile": {
                "display_name": "",
                "current_ranking": "",
                "target_ranking": "",
                "current_points": None,
                "target_points": None,
                "points_to_target": None,
                "target_threshold_points": None,
                "preferred_surface": "",
                "weekly_availability": "",
                "injury_notes": "",
                "playing_style": "",
                "win_streak": 0,
                "goal_progress_ratio": 0.0,
                "projected_ranking_from_points": "40",
                "points_to_next_echelon": None,
                "next_echelon_label": None,
                "fft_monthly_update_hint": tennis_logic.fft_monthly_update_sentence(),
                "profile_created_at": None,
            },
            "match": None,
            "program_today": [],
            "program_until_match": [],
            "fft_ranking_info_url": "https://www.fft.fr/le-tennis/competitions/classement-et-homologation",
            "ranking_echelons": list(tennis_logic.ECHELONS),
            "ranking_model_note": "Modele FFT V2 (capital de depart + 12 mois glissants + V-E-2I-5G). Certaines regles FFT avancees restent a completer.",
            "context_memory": {},
            "staff_poles": {
                "technique": True,
                "physical": True,
                "mental": True,
                "nutrition": True,
                "recovery": True,
            },
            "match_history": [],
        }


@app.put("/profile/{session_id}")
def put_profile(session_id: str, body: PlayerProfileUpdate) -> dict[str, Any]:
    sid = session_id.strip()
    store.ensure_profile(sid)
    data = body.model_dump(exclude_none=True)
    if data:
        store.update_profile(sid, **data)
    store.sync_points_from_ranking_labels(sid)
    return store.dashboard_payload(sid)["profile"]


@app.get("/match-history/{session_id}")
def get_match_history(session_id: str) -> dict[str, Any]:
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    store.ensure_profile(sid)
    return {"rows": store.list_match_history(sid, limit=100)}


@app.get("/palmares/{session_id}")
def get_palmares(session_id: str) -> dict[str, Any]:
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    store.ensure_profile(sid)
    return {"entries": store.list_palmares_entries(sid)}


@app.post("/palmares/{session_id}")
def post_palmares(session_id: str, body: PalmaresCreateBody) -> dict[str, Any]:
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    out = store.add_palmares_entry(
        sid,
        match_date=_assert_not_future_match_date(body.match_date.strip()),
        opponent_name=body.opponent_name.strip(),
        opponent_ranking=body.opponent_ranking.strip(),
        catalog_player_id=body.catalog_player_id,
        won=body.won,
        notes=body.notes.strip(),
    )
    return {**out, "dashboard": store.dashboard_payload(sid)}


@app.patch("/palmares/{session_id}/{entry_id}")
def patch_palmares(
    session_id: str, entry_id: int, body: PalmaresPatchBody
) -> dict[str, Any]:
    sid = session_id.strip()
    data = body.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(status_code=400, detail="Aucun champ a mettre a jour.")
    if "match_date" in data and data["match_date"] is not None:
        data["match_date"] = _assert_not_future_match_date(str(data["match_date"]).strip())
    res = store.update_palmares_entry(sid, entry_id, **data)
    if res is None:
        raise HTTPException(status_code=404, detail="Entree introuvable.")
    return {**res, "dashboard": store.dashboard_payload(sid)}


@app.delete("/palmares/{session_id}/{entry_id}")
def delete_palmares(session_id: str, entry_id: int) -> dict[str, Any]:
    sid = session_id.strip()
    ok = store.delete_palmares_entry(sid, entry_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Entree introuvable.")
    return {"ok": True, "dashboard": store.dashboard_payload(sid)}


@app.post("/match/{session_id}")
def post_match(session_id: str, body: MatchCreateBody) -> dict[str, Any]:
    sid = session_id.strip()
    mid = store.create_match(
        sid,
        match_datetime=body.match_datetime,
        opponent_id=body.opponent_id,
        opponent_name=body.opponent_name,
        opponent_ranking=body.opponent_ranking,
        opponent_style=body.opponent_style,
        opponent_notes=body.opponent_notes,
        surface=body.surface,
        match_format=body.match_format,
        club_location=body.club_location,
        focus_text=body.focus_text,
    )
    return {"match_id": mid, "dashboard": store.dashboard_payload(sid)}


@app.patch("/match/{session_id}/{match_id}")
def patch_match(session_id: str, match_id: int, body: MatchUpdateBody) -> dict[str, Any]:
    sid = session_id.strip()
    data = body.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(status_code=400, detail="Aucun champ a mettre a jour.")
    ok = store.update_match(match_id, sid, **data)
    if not ok:
        raise HTTPException(status_code=404, detail="Match introuvable.")
    _maybe_apply_fft_after_match_update(sid, match_id)
    return store.dashboard_payload(sid)


@app.get("/opponents/{session_id}")
def get_opponents(session_id: str) -> dict[str, Any]:
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    store.ensure_profile(sid)
    return {"rows": store.list_opponents_with_h2h(sid)}


@app.get("/players-catalog")
def get_players_catalog(
    q: str = Query(default="", description="Nom joueur"),
    limit: int = Query(default=20, ge=1, le=100),
) -> dict[str, Any]:
    return {"rows": store.search_players_catalog(q, limit=limit)}


@app.post("/opponents/{session_id}")
def post_opponent(session_id: str, body: OpponentUpsertBody) -> dict[str, Any]:
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nom adversaire obligatoire.")
    opp_id = store.upsert_opponent(
        sid,
        name=name,
        rank=body.rank.strip(),
        play_style=body.play_style.strip(),
        notes_perso=body.notes_perso.strip(),
    )
    return {"opponent_id": opp_id, "rows": store.list_opponents_with_h2h(sid)}


@app.post("/match/{session_id}/{match_id}/debrief")
def post_debrief(
    session_id: str, match_id: int, body: MatchDebriefBody
) -> dict[str, Any]:
    sid = session_id.strip()
    opponent_name = (body.opponent_name or "").strip()
    opponent_ranking = (body.opponent_ranking or "").strip()
    if body.opponent_anonymous:
        opponent_name = "Anonyme"
        if not opponent_ranking:
            opponent_ranking = "À définir"
    elif not opponent_name:
        opponent_name = "À définir"
    if not opponent_ranking:
        opponent_ranking = "À définir"
    ok = store.update_match(
        match_id,
        sid,
        status="completed",
        result_score=body.result_score,
        result_feeling=body.result_feeling,
        opponent_name=opponent_name,
        opponent_ranking=opponent_ranking,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Match introuvable.")
    _maybe_apply_fft_after_match_update(sid, match_id)
    return store.dashboard_payload(sid)


@app.patch("/tasks/{session_id}/{task_id}")
def patch_task(session_id: str, task_id: int, body: TaskPatchBody) -> dict[str, Any]:
    sid = session_id.strip()
    data = body.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(status_code=400, detail="Aucun champ a mettre a jour.")
    ok = store.update_task(task_id, sid, **data)
    if not ok:
        raise HTTPException(status_code=404, detail="Tache introuvable.")
    return {"ok": True, "dashboard": store.dashboard_payload(sid)}


@app.delete("/tasks/{session_id}/{task_id}")
def delete_task(session_id: str, task_id: int) -> dict[str, Any]:
    sid = session_id.strip()
    ok = store.delete_task(task_id, sid)
    if not ok:
        raise HTTPException(status_code=404, detail="Tache introuvable.")
    return {"ok": True, "dashboard": store.dashboard_payload(sid)}


@app.post("/program-tasks/suggest-add")
def program_tasks_suggest_add(body: ProgramTaskSuggestBody) -> dict[str, Any]:
    """
    A partir d'une intention libre (ex: "travailler mon service"), propose 3 taches
    au format identique au reste du programme (markdown Objectif/Protocole/Tip).
    """
    sid = body.session_id.strip()
    intent = body.intent.strip()
    if not sid or not intent:
        raise HTTPException(status_code=400, detail="session_id et intent requis.")
    store.ensure_profile(sid)
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY manquante.")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    client = OpenAI(api_key=api_key)
    try:
        dash = store.dashboard_payload(sid)
    except Exception as exc:
        print(f"[ERROR] suggest-add dashboard: {exc}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Impossible de charger le contexte.") from exc
    poles = dash.get("staff_poles") or {}
    m = dash.get("match") or {}
    prof = dash.get("profile") or {}
    ctx = {
        "staff_poles": poles,
        "match": {
            "days_remaining": m.get("days_remaining"),
            "surface": m.get("surface"),
            "focus": (m.get("focus_text") or "")[:200],
        },
        "player": {
            "current_ranking": prof.get("current_ranking"),
            "target_ranking": prof.get("target_ranking"),
        },
    }
    allowed = [k for k, v in poles.items() if v] if isinstance(poles, dict) else list(store.TASK_TYPES)
    allowed_str = ", ".join(allowed) if allowed else "technique, physical, mental, nutrition, recovery"
    system_prompt = (
        "Tu es Ace, coach tennis. Propose exactement 3 taches concretes pour le programme du joueur, "
        "a partir de son intention. Reponse: UNIQUEMENT un JSON valide, sans texte autour, format:\n"
        "{\"suggestions\":[{\"title\":\"titre court\",\"task_type\":\"technique\",\"duration_min\":45,"
        "\"description\":\"markdown avec ## Objectif, ## Protocole (2 a 4 etapes numerotees 1. 2. 3.), "
        "## Le Tip de Ace\"}]}\n"
        f"Chaque task_type doit etre l'un de: {allowed_str}. "
        "duration_min entre 20 et 90. Les 3 propositions doivent etre distinctes. Francais."
    )
    user_prompt = f"Intention du joueur:\n{intent}\n\nContexte:\n{json.dumps(ctx, ensure_ascii=False)}"
    try:
        resp = client.chat.completions.create(
            model=model,
            temperature=0.55,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        raw = resp.choices[0].message.content if resp.choices else ""
        parsed = _extract_json_object(str(raw or ""))
    except Exception as exc:
        print(f"[ERROR] /program-tasks/suggest-add: {exc}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Echec generation des suggestions") from exc
    raw_list = parsed.get("suggestions") if isinstance(parsed, dict) else None
    if not isinstance(raw_list, list):
        raw_list = []
    out: list[dict[str, Any]] = []
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        tt = store.normalize_task_type(str(item.get("task_type") or "technique"))
        if not store.task_type_enabled(sid, tt):
            continue
        title = str(item.get("title") or "").strip()
        desc = str(item.get("description") or "").strip()
        if not title or not desc:
            continue
        try:
            dm = int(item.get("duration_min", 30))
        except Exception:
            dm = 30
        dm = max(15, min(120, dm))
        out.append(
            {"title": title, "description": desc, "task_type": tt, "duration_min": dm}
        )
        if len(out) >= 3:
            break
    if not out:
        raise HTTPException(
            status_code=422,
            detail="Aucune suggestion valide. Verifie le Staff (poles actifs) ou reformule.",
        )
    return {"suggestions": out}


@app.post("/program-tasks/add-manual")
def program_tasks_add_manual(body: ProgramTaskManualAddBody) -> dict[str, Any]:
    """Ajoute une tache a la journee (fin de liste), meme schema que les taches generees."""
    sid = body.session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    task_date = (body.task_date or "").strip() or date.today().isoformat()
    try:
        datetime.strptime(task_date, "%Y-%m-%d")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="task_date invalide (YYYY-MM-DD).") from exc
    tid = store.append_program_task(
        sid,
        task_date,
        body.title.strip(),
        (body.description or "").strip(),
        body.task_type,
        int(body.duration_min),
    )
    if tid is None:
        raise HTTPException(
            status_code=400,
            detail="Impossible d'ajouter: type desactive (Staff) ou titre vide.",
        )
    return {"ok": True, "task_id": tid, "dashboard": store.dashboard_payload(sid)}


@app.get("/staff/{session_id}")
def get_staff(session_id: str) -> dict[str, Any]:
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    try:
        poles = store.get_staff_poles(sid)
    except Exception as exc:
        print(f"[ERROR] /staff/{sid}: {exc}")
        traceback.print_exc()
        poles = {
            "technique": True,
            "physical": True,
            "mental": True,
            "nutrition": True,
            "recovery": True,
        }
    return {"staff_poles": poles}


@app.put("/staff/{session_id}")
def put_staff(session_id: str, body: StaffPolesBody) -> dict[str, Any]:
    sid = session_id.strip()
    data = body.model_dump(exclude_none=True)
    try:
        updated = store.set_staff_poles(sid, data)
        return {"staff_poles": updated, "dashboard": store.dashboard_payload(sid)}
    except Exception as exc:
        print(f"[ERROR] PUT /staff/{sid}: {exc} payload={data}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Erreur mise a jour staff")


@app.get("/context-memory/{session_id}")
def get_context_memory(session_id: str) -> dict[str, Any]:
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    try:
        ctx = store.get_context_memory(sid)
    except Exception as exc:
        print(f"[ERROR] /context-memory/{sid}: {exc}")
        traceback.print_exc()
        ctx = {}
    return {"context_memory": ctx or {}}


@app.patch("/context-memory/{session_id}")
def patch_context_memory(session_id: str, body: ContextMemoryBody) -> dict[str, Any]:
    sid = session_id.strip()
    data = body.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(status_code=400, detail="Aucun champ a mettre a jour.")
    try:
        updated = store.update_context_memory(sid, data)
        return {"context_memory": updated, "dashboard": store.dashboard_payload(sid)}
    except Exception as exc:
        print(f"[ERROR] PATCH /context-memory/{sid}: {exc} payload={data}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Erreur mise a jour context memory")


def _normalize_date_for_import(value: str) -> str:
    txt = (value or "").strip()
    if not txt:
        return date.today().isoformat()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(txt, fmt).date().isoformat()
        except Exception:
            pass
    return txt[:10]


def _assert_not_future_match_date(value: str) -> str:
    iso = _normalize_date_for_import(value)
    try:
        d = datetime.strptime(iso, "%Y-%m-%d").date()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Date de match invalide: {value}") from exc
    if d > date.today():
        raise HTTPException(
            status_code=400,
            detail=f"Match invalide: date future detectee ({iso}). Seule la simulation accepte des matchs futurs.",
        )
    return iso


def _extract_json_object(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(raw[start : end + 1])
        except Exception:
            return {}
    return {}


@app.post("/tenup-import/parse")
def tenup_import_parse(body: TenupImportParseBody) -> dict[str, Any]:
    sid = body.session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    if not body.images_data_urls:
        raise HTTPException(status_code=400, detail="Aucune capture fournie.")

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY manquante.")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    client = OpenAI(api_key=api_key)

    text_prompt = (
        "Tu lis des captures d'ecran de palmares Ten'Up. "
        "Retourne UNIQUEMENT un JSON valide sans markdown au format: "
        '{"detected_current_ranking":"",'
        '"matches":[{"match_date":"YYYY-MM-DD","opponent_name":"","opponent_ranking":"30/2","won":true,"notes":"source tenup import"}]}. '
        "Regles: dedupliquer les lignes identiques, convertir les dates en YYYY-MM-DD quand possible, "
        "won=true si la capture indique V (vert), won=false si D (rouge). "
        "Si inconnu pour le nom adversaire, laisse chaine vide."
    )
    content: List[dict[str, Any]] = [{"type": "text", "text": text_prompt}]
    for img in body.images_data_urls[:12]:
        content.append({"type": "image_url", "image_url": {"url": img}})

    try:
        resp = client.chat.completions.create(
            model=model,
            temperature=0,
            messages=[
                {"role": "system", "content": "Tu extrais des donnees structurées avec fiabilite."},
                {"role": "user", "content": content},
            ],
        )
        raw = resp.choices[0].message.content if resp.choices else ""
        parsed = _extract_json_object(raw)
    except Exception as exc:
        print(f"[ERROR] /tenup-import/parse session_id={sid}: {exc}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Echec extraction captures Ten'Up")

    raw_matches = parsed.get("matches") if isinstance(parsed, dict) else []
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    if isinstance(raw_matches, list):
        for m in raw_matches:
            if not isinstance(m, dict):
                continue
            opp_rank = str(m.get("opponent_ranking") or "").strip()
            if not opp_rank:
                continue
            row = {
                "match_date": _normalize_date_for_import(str(m.get("match_date") or "")),
                "opponent_name": str(m.get("opponent_name") or "").strip(),
                "opponent_ranking": tennis_logic.normalize_label(opp_rank),
                "won": bool(m.get("won")),
                "notes": str(m.get("notes") or "Import capture Ten'Up").strip(),
            }
            key = f"{row['match_date']}|{row['opponent_name'].lower()}|{row['opponent_ranking']}|{row['won']}"
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)

    return {
        "detected_current_ranking": str(parsed.get("detected_current_ranking") or "").strip(),
        "rows": rows,
    }


@app.post("/tenup-import/commit")
def tenup_import_commit(body: TenupImportCommitBody) -> dict[str, Any]:
    sid = body.session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    if not body.matches:
        raise HTTPException(status_code=400, detail="Aucun match a importer.")
    store.ensure_profile(sid)

    profile_patch: dict[str, Any] = {}
    if body.current_ranking.strip():
        profile_patch["current_ranking"] = tennis_logic.normalize_label(body.current_ranking.strip())
    if body.origin_ranking.strip():
        profile_patch["origin_ranking"] = tennis_logic.normalize_label(body.origin_ranking.strip())
    if body.target_ranking.strip():
        profile_patch["target_ranking"] = tennis_logic.normalize_label(body.target_ranking.strip())
    if (body.gender or "").strip():
        profile_patch["gender"] = tennis_logic.normalize_gender(body.gender.strip())
    if profile_patch:
        store.update_profile(sid, **profile_patch)

    imported = 0
    for m in body.matches:
        opp = tennis_logic.normalize_label((m.opponent_ranking or "").strip())
        if not opp:
            continue
        match_date = _assert_not_future_match_date(m.match_date)
        store.add_palmares_entry(
            session_id=sid,
            match_date=match_date,
            opponent_name=(m.opponent_name or "").strip(),
            opponent_ranking=opp,
            catalog_player_id=None,
            won=bool(m.won),
            notes=(m.notes or "Import capture Ten'Up").strip(),
        )
        imported += 1

    store.sync_points_from_ranking_labels(sid)
    return {
        "ok": True,
        "imported": imported,
        "dashboard": store.dashboard_payload(sid),
    }


@app.post("/simulate-ranking")
def simulate_ranking(body: SimulateRankingBody) -> dict[str, Any]:
    sid = body.session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    store.ensure_profile(sid)
    store.sync_points_from_ranking_labels(sid)
    pairs = [(h.opponent_ranking.strip(), h.won) for h in body.hypothetical_victories]
    sim = store.simulate_fft_projection(sid, pairs)
    if not sim:
        raise HTTPException(status_code=404, detail="Profil introuvable.")
    return {
        **sim,
        "window_months": 12,
        "disclaimer": "Simulation FFT V2 (calcul par echelons, capital de depart, 12 mois glissants).",
    }


@app.post("/session/{session_id}/reset-all")
def reset_all_session_data(session_id: str) -> dict[str, str]:
    """Reset chat + profil + matchs + taches pour la session (debug / nouveau depart)."""
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id invalide.")
    store.reset_chat_session(sid)
    with store.get_conn() as conn:
        conn.execute("DELETE FROM palmares_entries WHERE session_id = ?", (sid,))
        conn.execute("DELETE FROM context_memory WHERE session_id = ?", (sid,))
        conn.execute("DELETE FROM program_tasks WHERE session_id = ?", (sid,))
        conn.execute("DELETE FROM matches WHERE session_id = ?", (sid,))
        conn.execute("DELETE FROM player_profiles WHERE session_id = ?", (sid,))
        conn.execute("DELETE FROM chat_sessions WHERE session_id = ?", (sid,))
    store.ensure_profile(sid)
    return {"status": "ok"}
