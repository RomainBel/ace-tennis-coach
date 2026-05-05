"""SQLite persistence for Ace mini-SaaS (profile, matches, program tasks)."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal, Optional

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "coach_tennis.db")
TASK_TYPES: tuple[str, ...] = (
    "technique",
    "physical",
    "mental",
    "nutrition",
    "recovery",
)
DEFAULT_STAFF_POLES: dict[str, bool] = {k: True for k in TASK_TYPES}
LEGACY_CATEGORY_BY_TASK_TYPE: dict[str, str] = {
    "technique": "tennis",
    "physical": "physical",
    "mental": "mental",
    "nutrition": "nutrition",
    "recovery": "physical",
}

MATCH_FORMAT_MULTIPLIERS: dict[str, float] = {
    "classique": 1.0,
    "3 sets a 6 jeux": 1.2,
    "3 sets à 6 jeux": 1.2,
    "2 sets a 6 jeux + 3eme set sjd": 1.0,
    "2 sets à 6 jeux + 3ème set sjd": 1.0,
    "2 sets a 4 jeux avec pt decisif et jd a 4/4": 0.75,
    "2 sets à 4 jeux avec pt decisif et jd à 4/4": 0.75,
}


def _normalize_match_format_label(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def match_format_multiplier(match_format: str) -> float:
    key = _normalize_match_format_label(match_format)
    if not key:
        return 1.0
    return MATCH_FORMAT_MULTIPLIERS.get(key, 1.0)


def _opponent_name_key(name: str) -> str:
    return " ".join((name or "").strip().lower().split())


def _is_placeholder_opponent_name(name: str) -> bool:
    key = _opponent_name_key(name)
    return key in {"a definir", "à définir", "anonyme", "??", "?"}

def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.execute("PRAGMA busy_timeout=30000;")
    # Reduce "database is locked" under concurrent reads/writes from chat/tool flows.
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
    except sqlite3.OperationalError:
        # Keep connection usable even if PRAGMA cannot be changed right now.
        pass
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_sessions (
                session_id TEXT PRIMARY KEY,
                summary TEXT NOT NULL DEFAULT '',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(session_id) REFERENCES chat_sessions(session_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS player_profiles (
                session_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                gender TEXT NOT NULL DEFAULT 'M',
                current_ranking TEXT NOT NULL DEFAULT '',
                origin_ranking TEXT NOT NULL DEFAULT '',
                target_ranking TEXT NOT NULL DEFAULT '',
                avatar_data_url TEXT NOT NULL DEFAULT '',
                current_points INTEGER,
                target_points INTEGER,
                preferred_surface TEXT NOT NULL DEFAULT '',
                weekly_availability TEXT NOT NULL DEFAULT '',
                injury_notes TEXT NOT NULL DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS matches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                match_datetime TEXT NOT NULL,
                opponent_id INTEGER,
                opponent_name TEXT NOT NULL DEFAULT '',
                opponent_ranking TEXT NOT NULL DEFAULT '',
                opponent_notes TEXT NOT NULL DEFAULT '',
                surface TEXT NOT NULL DEFAULT '',
                match_format TEXT NOT NULL DEFAULT '',
                club_location TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL CHECK(status IN ('scheduled', 'completed', 'cancelled')),
                focus_text TEXT NOT NULL DEFAULT '',
                result_score TEXT NOT NULL DEFAULT '',
                result_feeling TEXT NOT NULL DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS opponents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                name_key TEXT NOT NULL,
                rank TEXT NOT NULL DEFAULT '',
                play_style TEXT NOT NULL DEFAULT '',
                notes_perso TEXT NOT NULL DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(session_id, name_key)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_opponents_session ON opponents(session_id, name_key)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS players_catalog (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                display_name TEXT NOT NULL,
                normalized_name TEXT NOT NULL UNIQUE,
                current_rank TEXT NOT NULL DEFAULT '',
                play_style TEXT NOT NULL DEFAULT '',
                public_notes TEXT NOT NULL DEFAULT '',
                player_status TEXT NOT NULL DEFAULT 'active',
                is_verified INTEGER NOT NULL DEFAULT 0,
                verified_user_id TEXT,
                created_by_session_id TEXT NOT NULL DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_players_catalog_name ON players_catalog(normalized_name)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_opponents (
                session_id TEXT NOT NULL,
                player_id INTEGER NOT NULL,
                private_notes TEXT NOT NULL DEFAULT '',
                private_tags TEXT NOT NULL DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(session_id, player_id),
                FOREIGN KEY(player_id) REFERENCES players_catalog(id)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_user_opponents_session ON user_opponents(session_id, player_id)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS program_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                match_id INTEGER,
                task_date TEXT NOT NULL,
                category TEXT NOT NULL CHECK(category IN ('nutrition', 'physical', 'tennis', 'mental')),
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL CHECK(status IN ('pending', 'done', 'skipped', 'postponed')),
                postponed_to_date TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(match_id) REFERENCES matches(id)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_matches_session ON matches(session_id, status, match_datetime)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tasks_session_date ON program_tasks(session_id, task_date)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS palmares_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                match_date TEXT NOT NULL,
                catalog_player_id INTEGER,
                opponent_name TEXT NOT NULL DEFAULT '',
                opponent_ranking TEXT NOT NULL DEFAULT '',
                won INTEGER NOT NULL DEFAULT 1,
                notes TEXT NOT NULL DEFAULT '',
                points_delta INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_palmares_session ON palmares_entries(session_id, match_date DESC)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS context_memory (
                session_id TEXT PRIMARY KEY,
                context_json TEXT NOT NULL DEFAULT '{}',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS match_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                match_id INTEGER NOT NULL,
                match_date TEXT NOT NULL,
                outcome TEXT NOT NULL DEFAULT '',
                score TEXT NOT NULL DEFAULT '',
                opponent_name TEXT NOT NULL DEFAULT '',
                sensations TEXT NOT NULL DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(session_id, match_id)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_match_history_session_date ON match_history(session_id, match_date DESC)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fft_rule_sets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                label TEXT NOT NULL,
                effective_from TEXT NOT NULL,
                effective_to TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fft_echelon_norms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_set_code TEXT NOT NULL,
                gender TEXT NOT NULL,
                echelon_label TEXT NOT NULL,
                min_bilan INTEGER NOT NULL,
                wins_counted INTEGER NOT NULL,
                UNIQUE(rule_set_code, gender, echelon_label)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fft_ve2i5g_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_set_code TEXT NOT NULL,
                series_code TEXT NOT NULL,
                range_min REAL,
                range_max REAL,
                delta_wins INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fft_victory_points_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_set_code TEXT NOT NULL,
                gap_min INTEGER,
                gap_max INTEGER,
                points_coef1 INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                reset_token TEXT,
                reset_token_expires DATETIME
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        _migrate_schema(conn)
        _seed_fft_rules(conn)


def _migrate_schema(conn: sqlite3.Connection) -> None:
    def cols(table: str) -> set[str]:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        return {str(r[1]) for r in rows}

    p = cols("player_profiles")
    if "playing_style" not in p:
        conn.execute(
            "ALTER TABLE player_profiles ADD COLUMN playing_style TEXT NOT NULL DEFAULT ''"
        )
    if "win_streak" not in p:
        conn.execute(
            "ALTER TABLE player_profiles ADD COLUMN win_streak INTEGER NOT NULL DEFAULT 0"
        )
    if "disabled_task_types" not in p:
        conn.execute(
            "ALTER TABLE player_profiles ADD COLUMN disabled_task_types TEXT NOT NULL DEFAULT ''"
        )
    if "avatar_data_url" not in p:
        conn.execute(
            "ALTER TABLE player_profiles ADD COLUMN avatar_data_url TEXT NOT NULL DEFAULT ''"
        )
    if "gender" not in p:
        conn.execute(
            "ALTER TABLE player_profiles ADD COLUMN gender TEXT NOT NULL DEFAULT 'M'"
        )
    if "origin_ranking" not in p:
        conn.execute(
            "ALTER TABLE player_profiles ADD COLUMN origin_ranking TEXT NOT NULL DEFAULT ''"
        )
    if "onboarding_completed" not in p:
        conn.execute(
            "ALTER TABLE player_profiles ADD COLUMN onboarding_completed INTEGER NOT NULL DEFAULT 1"
        )

    t = cols("program_tasks")
    if "task_type" not in t:
        conn.execute(
            "ALTER TABLE program_tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'technique'"
        )
    if "duration_min" not in t:
        conn.execute(
            "ALTER TABLE program_tasks ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 30"
        )

    m = cols("matches")
    if "surface" not in m:
        conn.execute("ALTER TABLE matches ADD COLUMN surface TEXT NOT NULL DEFAULT ''")
    if "opponent_id" not in m:
        conn.execute("ALTER TABLE matches ADD COLUMN opponent_id INTEGER")
    if "catalog_player_id" not in m:
        conn.execute("ALTER TABLE matches ADD COLUMN catalog_player_id INTEGER")
    if "opponent_notes" not in m:
        conn.execute("ALTER TABLE matches ADD COLUMN opponent_notes TEXT NOT NULL DEFAULT ''")
    if "match_format" not in m:
        conn.execute("ALTER TABLE matches ADD COLUMN match_format TEXT NOT NULL DEFAULT ''")
    if "club_location" not in m:
        conn.execute("ALTER TABLE matches ADD COLUMN club_location TEXT NOT NULL DEFAULT ''")
    if "outcome" not in m:
        conn.execute("ALTER TABLE matches ADD COLUMN outcome TEXT NOT NULL DEFAULT ''")
    if "fft_points_applied" not in m:
        conn.execute(
            "ALTER TABLE matches ADD COLUMN fft_points_applied INTEGER NOT NULL DEFAULT 0"
        )

    mh = cols("match_history")
    if mh:
        if "updated_at" not in mh:
            conn.execute(
                "ALTER TABLE match_history ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP"
            )

    pe = cols("palmares_entries")
    if "catalog_player_id" not in pe:
        conn.execute("ALTER TABLE palmares_entries ADD COLUMN catalog_player_id INTEGER")
    if "opponent_name" not in pe:
        conn.execute("ALTER TABLE palmares_entries ADD COLUMN opponent_name TEXT NOT NULL DEFAULT ''")
    pc = cols("players_catalog")
    if "player_status" not in pc:
        conn.execute(
            "ALTER TABLE players_catalog ADD COLUMN player_status TEXT NOT NULL DEFAULT 'active'"
        )


def _seed_fft_rules(conn: sqlite3.Connection) -> None:
    """Seed règles FFT versionnées (V2)."""
    from app import tennis_logic

    code = "fft-2023"
    conn.execute(
        """
        INSERT INTO fft_rule_sets(code, label, effective_from, effective_to, is_active)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(code) DO UPDATE SET label = excluded.label, effective_from = excluded.effective_from
        """,
        (code, "FFT Baremes 2023", "2022-10-01", None),
    )

    # Normes
    conn.execute("DELETE FROM fft_echelon_norms WHERE rule_set_code = ?", (code,))
    for echelon, vals in tennis_logic._NORMS_M.items():
        conn.execute(
            """
            INSERT INTO fft_echelon_norms(rule_set_code, gender, echelon_label, min_bilan, wins_counted)
            VALUES (?, 'M', ?, ?, ?)
            """,
            (code, echelon, int(vals[0]), int(vals[1])),
        )
    for echelon, vals in tennis_logic._NORMS_F.items():
        conn.execute(
            """
            INSERT INTO fft_echelon_norms(rule_set_code, gender, echelon_label, min_bilan, wins_counted)
            VALUES (?, 'F', ?, ?, ?)
            """,
            (code, echelon, int(vals[0]), int(vals[1])),
        )

    # V-E-2I-5G
    conn.execute("DELETE FROM fft_ve2i5g_rules WHERE rule_set_code = ?", (code,))
    for series, rows in tennis_logic.VE2I5G_STEPS.items():
        for lo, hi, delta in rows:
            conn.execute(
                """
                INSERT INTO fft_ve2i5g_rules(rule_set_code, series_code, range_min, range_max, delta_wins)
                VALUES (?, ?, ?, ?, ?)
                """,
                (code, series, lo, hi, int(delta)),
            )

    # Barème victoire coef 1
    conn.execute("DELETE FROM fft_victory_points_rules WHERE rule_set_code = ?", (code,))
    conn.execute(
        """
        INSERT INTO fft_victory_points_rules(rule_set_code, gap_min, gap_max, points_coef1) VALUES
        (?, NULL, -4, 0),
        (?, -3, -3, 15),
        (?, -2, -2, 20),
        (?, -1, -1, 30),
        (?, 0, 0, 60),
        (?, 1, 1, 90),
        (?, 2, NULL, 120)
        """,
        (code, code, code, code, code, code, code),
    )


def upsert_chat_session(session_id: str) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO chat_sessions(session_id, summary)
            VALUES (?, '')
            ON CONFLICT(session_id) DO NOTHING
            """,
            (session_id,),
        )


def ensure_profile(session_id: str) -> None:
    upsert_chat_session(session_id)
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO player_profiles(session_id)
            VALUES (?)
            ON CONFLICT(session_id) DO NOTHING
            """,
            (session_id,),
        )


def get_profile_row(session_id: str) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM player_profiles WHERE session_id = ?", (session_id,)
        ).fetchone()


def update_profile(session_id: str, **fields: Any) -> None:
    ensure_profile(session_id)
    allowed = {
        "display_name",
        "gender",
        "current_ranking",
        "origin_ranking",
        "target_ranking",
        "current_points",
        "target_points",
        "avatar_data_url",
        "preferred_surface",
        "weekly_availability",
        "injury_notes",
        "playing_style",
        "win_streak",
        "disabled_task_types",
        "onboarding_completed",
    }
    updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if "onboarding_completed" in updates:
        updates["onboarding_completed"] = 1 if updates["onboarding_completed"] else 0
    if not updates:
        return
    cols = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values())
    values.append(session_id)
    with get_conn() as conn:
        conn.execute(
            f"UPDATE player_profiles SET {cols}, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?",
            values,
        )


def normalize_task_type(value: str) -> str:
    v = (value or "").strip().lower()
    if v in ("tennis", "technique"):
        return "technique"
    if v in ("physique", "physical"):
        return "physical"
    if v in ("mental",):
        return "mental"
    if v in ("nutrition",):
        return "nutrition"
    if v in ("recovery", "recuperation", "récupération"):
        return "recovery"
    return "technique"


def infer_task_type_from_text(title: str, description: str, category: str = "") -> str:
    text = f"{title} {description}".lower()
    cat = (category or "").lower()
    if any(k in text for k in ("respir", "visualisation", "confiance", "mental", "routine")):
        return "mental"
    if any(k in text for k in ("repas", "dejeuner", "déjeuner", "diner", "dîner", "hydrata", "nutrition")):
        return "nutrition"
    if any(k in text for k in ("recup", "récup", "etire", "étire", "mobilite", "mobilité", "repos")):
        return "recovery"
    if any(k in text for k in ("cardio", "sprint", "renfo", "physique", "fractionne", "fractionné")):
        return "physical"
    if cat in ("nutrition", "mental", "physical", "tennis"):
        return {"nutrition": "nutrition", "mental": "mental", "physical": "physical", "tennis": "technique"}[cat]
    return "technique"


def _disabled_set_from_profile(profile: Optional[sqlite3.Row]) -> set[str]:
    if not profile:
        return set()
    raw = (profile["disabled_task_types"] if "disabled_task_types" in profile.keys() else "") or ""
    out: set[str] = set()
    for it in raw.split(","):
        it = it.strip()
        if it:
            out.add(normalize_task_type(it))
    return out


def get_staff_poles(session_id: str) -> dict[str, bool]:
    try:
        prof = get_profile_row(session_id)
        if not prof:
            return DEFAULT_STAFF_POLES.copy()
        disabled = _disabled_set_from_profile(prof)
        return {k: (k not in disabled) for k in TASK_TYPES}
    except Exception:
        return DEFAULT_STAFF_POLES.copy()


def set_staff_poles(session_id: str, poles: dict[str, bool]) -> dict[str, bool]:
    current = get_staff_poles(session_id)
    merged = current.copy()
    for k, v in poles.items():
        nk = normalize_task_type(k)
        if nk in merged:
            merged[nk] = bool(v)
    disabled = ",".join([k for k, enabled in merged.items() if not enabled])
    update_profile(session_id, disabled_task_types=disabled)
    return merged


def task_type_enabled(session_id: str, task_type: str) -> bool:
    poles = get_staff_poles(session_id)
    return poles.get(normalize_task_type(task_type), True)


def get_context_memory(session_id: str) -> dict[str, Any]:
    upsert_chat_session(session_id)
    try:
        with get_conn() as conn:
            row = conn.execute(
                "SELECT context_json FROM context_memory WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if not row:
                return {}
            raw = row["context_json"] or "{}"
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
    except Exception:
        return {}
    return {}


def update_context_memory(session_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    base = get_context_memory(session_id)
    merged = {**base, **patch}
    payload = json.dumps(merged, ensure_ascii=False)
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO context_memory(session_id, context_json, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(session_id) DO UPDATE SET context_json = excluded.context_json, updated_at = CURRENT_TIMESTAMP
            """,
            (session_id, payload),
        )
    return merged


def sync_points_from_ranking_labels(session_id: str) -> None:
    """Recalcule les points FFT avec fenêtre glissante 12 mois + capital de départ."""
    from app import tennis_logic

    ensure_profile(session_id)
    prof = get_profile_row(session_id)
    if not prof:
        return
    cur_l = (prof["current_ranking"] or "").strip() or "40"
    origin_l = (prof["origin_ranking"] or "").strip() or cur_l
    origin_l = tennis_logic.normalize_label(origin_l) or "40"
    cur_l = tennis_logic.normalize_label(cur_l) or "40"
    if not (prof["origin_ranking"] or "").strip():
        update_profile(session_id, origin_ranking=origin_l)

    tgt_l = (prof["target_ranking"] or "").strip()
    gender = (prof["gender"] or "M").strip() if "gender" in prof.keys() else "M"
    window_start = tennis_logic.rolling_window_start(date.today(), months=12).isoformat()
    win_points: list[int] = []
    losses_count = 0

    with get_conn() as conn:
        match_rows = conn.execute(
            """
            SELECT outcome, opponent_ranking, match_format
            FROM matches
            WHERE session_id = ?
              AND status = 'completed'
              AND fft_points_applied = 1
              AND substr(match_datetime, 1, 10) >= ?
            """,
            (session_id, window_start),
        ).fetchall()
        for r in match_rows:
            opp = (r["opponent_ranking"] or "").strip()
            if not opp:
                continue
            outcome = (r["outcome"] or "").strip().lower()
            if outcome not in ("won", "lost"):
                continue
            if outcome == "won":
                pts = tennis_logic.points_for_match(cur_l, opp, True)
                pts = int(round(pts * match_format_multiplier(str(r["match_format"] or ""))))
                win_points.append(max(0, pts))
            else:
                losses_count += 1

        palmares_rows = conn.execute(
            """
            SELECT won, opponent_ranking
            FROM palmares_entries
            WHERE session_id = ? AND match_date >= ?
            """,
            (session_id, window_start),
        ).fetchall()
        for r in palmares_rows:
            opp = (r["opponent_ranking"] or "").strip()
            won = bool(r["won"])
            if won:
                if opp and tennis_logic.normalize_label(opp) in tennis_logic.ECHELONS:
                    win_points.append(max(0, tennis_logic.points_for_match(cur_l, opp, True)))
            else:
                losses_count += 1

    snap = tennis_logic.fft_snapshot(
        current_label=cur_l,
        origin_label=origin_l,
        gender=gender,
        win_points=win_points,
        losses_count=losses_count,
    )
    new_cur = int(snap["current_points"])
    tgt_pts = (
        tennis_logic.points_threshold_for_label(tgt_l) if tgt_l else None
    )
    update_profile(session_id, current_points=new_cur, target_points=tgt_pts)


def _collect_fft_window_matches(
    session_id: str, calculation_label: str, window_start: str
) -> tuple[list[dict[str, Any]], int, int]:
    """Retourne les victoires (avec points) et le nombre de défaites sur la fenêtre."""
    from app import tennis_logic

    wins: list[dict[str, Any]] = []
    losses_count = 0
    matches_total = 0
    seen_match_keys: set[str] = set()
    calc_lbl = tennis_logic.normalize_label(calculation_label or "40")

    def _opponent_identity(name: str) -> str:
        cleaned = "".join(ch.lower() if (ch.isalnum() or ch.isspace()) else " " for ch in (name or ""))
        parts = [p for p in cleaned.split() if p]
        if not parts:
            return ""
        # Le nom de famille suffit pour éviter les doublons type "T. GAGNE" vs "Thomas Gagne".
        return parts[-1]

    def _match_key(match_date: str, opponent_name: str, opponent_ranking: str, outcome: str) -> str:
        return "|".join(
            [
                (match_date or "")[:10],
                _opponent_identity(opponent_name),
                tennis_logic.normalize_label(opponent_ranking or ""),
                (outcome or "").strip().lower(),
            ]
        )

    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT outcome, opponent_ranking, opponent_name, match_format, substr(match_datetime, 1, 10) AS match_date
            FROM matches
            WHERE session_id = ?
              AND status = 'completed'
              AND fft_points_applied = 1
              AND substr(match_datetime, 1, 10) >= ?
            """,
            (session_id, window_start),
        ).fetchall()
        for r in rows:
            opp = (r["opponent_ranking"] or "").strip()
            outcome = (r["outcome"] or "").strip().lower()
            if outcome not in ("won", "lost"):
                continue
            opp_known = bool(opp) and tennis_logic.normalize_label(opp) in tennis_logic.ECHELONS
            key = _match_key(str(r["match_date"] or ""), str(r["opponent_name"] or ""), opp, outcome)
            if key in seen_match_keys:
                continue
            seen_match_keys.add(key)
            matches_total += 1
            if outcome == "won":
                if not opp_known:
                    continue
                pts = tennis_logic.points_for_match(calc_lbl, opp, True)
                pts = int(round(pts * match_format_multiplier(str(r["match_format"] or ""))))
                wins.append(
                    {
                        "points": max(0, pts),
                        "opponent_ranking": tennis_logic.normalize_label(opp),
                        "opponent_name": str(r["opponent_name"] or "").strip(),
                        "match_date": str(r["match_date"] or ""),
                    }
                )
            else:
                losses_count += 1

        palmares_rows = conn.execute(
            """
            SELECT won, opponent_ranking, opponent_name, match_date
            FROM palmares_entries
            WHERE session_id = ? AND match_date >= ?
            """,
            (session_id, window_start),
        ).fetchall()
        for r in palmares_rows:
            opp = (r["opponent_ranking"] or "").strip()
            opp_known = bool(opp) and tennis_logic.normalize_label(opp) in tennis_logic.ECHELONS
            won = bool(r["won"])
            outcome = "won" if won else "lost"
            key = _match_key(str(r["match_date"] or ""), str(r["opponent_name"] or ""), opp, outcome)
            if key in seen_match_keys:
                continue
            seen_match_keys.add(key)
            matches_total += 1
            if won:
                if not opp_known:
                    continue
                pts = tennis_logic.points_for_match(calc_lbl, opp, True)
                wins.append(
                    {
                        "points": max(0, int(pts)),
                        "opponent_ranking": tennis_logic.normalize_label(opp),
                        "opponent_name": str(r["opponent_name"] or "").strip(),
                        "match_date": str(r["match_date"] or ""),
                    }
                )
            else:
                losses_count += 1
    return wins, losses_count, matches_total


def _fft_snapshot_for_label(session_id: str, calculation_label: str) -> dict[str, Any]:
    from app import tennis_logic

    ensure_profile(session_id)
    prof = get_profile_row(session_id)
    if not prof:
        return tennis_logic.fft_snapshot(
            current_label=calculation_label,
            origin_label="40",
            gender="M",
            win_points=[],
            losses_count=0,
        )
    origin_l = tennis_logic.normalize_label(
        (prof["origin_ranking"] or "").strip() or (prof["current_ranking"] or "40")
    )
    gender = (prof["gender"] or "M").strip() if "gender" in prof.keys() else "M"
    window_start = tennis_logic.rolling_window_start(date.today(), months=12).isoformat()
    wins, losses, _ = _collect_fft_window_matches(session_id, calculation_label, window_start)
    return tennis_logic.fft_snapshot(
        current_label=calculation_label,
        origin_label=origin_l,
        gender=gender,
        win_points=[int(w["points"]) for w in wins],
        losses_count=losses,
    )


def simulate_fft_projection(
    session_id: str, hypothetical: list[tuple[str, bool]]
) -> dict[str, Any]:
    """Simulation FFT V2 sur 12 mois avec hypothèses (V/D) et calcul par échelon."""
    from app import tennis_logic

    ensure_profile(session_id)
    prof = get_profile_row(session_id)
    if not prof:
        return {}

    cur_lbl = tennis_logic.normalize_label((prof["current_ranking"] or "").strip() or "40")
    origin_l = tennis_logic.normalize_label((prof["origin_ranking"] or "").strip() or cur_lbl)
    target_lbl = tennis_logic.normalize_label((prof["target_ranking"] or "").strip()) if (prof["target_ranking"] or "").strip() else ""
    gender = (prof["gender"] or "M").strip() if "gender" in prof.keys() else "M"
    window_start = tennis_logic.rolling_window_start(date.today(), months=12).isoformat()

    hypo_pairs = [
        (tennis_logic.normalize_label(str(opp or "").strip()), bool(won))
        for opp, won in hypothetical
        if str(opp or "").strip()
    ]

    def _snapshot_for(label: str) -> dict[str, Any]:
        wins_rows, losses_count, matches_count = _collect_fft_window_matches(session_id, label, window_start)
        wins_points = [int(w["points"]) for w in wins_rows]
        for opp, won in hypo_pairs:
            matches_count += 1
            if won:
                wins_points.append(max(0, int(tennis_logic.points_for_match(label, opp, True))))
            else:
                losses_count += 1
        snap = tennis_logic.fft_snapshot(
            current_label=label,
            origin_label=origin_l,
            gender=gender,
            win_points=wins_points,
            losses_count=losses_count,
        )
        points_cumules = int(snap["counted_points"])
        points_min = int(snap["min_bilan_required"])
        points_missing = max(0, points_min - points_cumules)
        return {
            "label": label,
            "matches_count": int(matches_count),
            "wins_count": int(len(wins_points)),
            "losses_count": int(losses_count),
            "wins_counted": int(snap["wins_counted"]),
            "points_cumules": points_cumules,
            "points_minimum": points_min,
            "points_manquants": points_missing,
            "points_total_with_capital": int(snap["current_points"]),
        }

    tabs: list[dict[str, Any]] = []
    cur_idx = tennis_logic.echelon_index(cur_lbl)
    for label in tennis_logic.ECHELONS[cur_idx:]:
        tabs.append(_snapshot_for(label))

    projected_label = cur_lbl
    for t in tabs:
        if int(t["points_manquants"]) == 0:
            projected_label = str(t["label"])
        else:
            break

    # Le "classement du dessus" doit partir du classement obtenu en simulation.
    next_label = tennis_logic.next_echelon_label(projected_label)
    points_to_next = 0
    if next_label:
        next_tab = next((t for t in tabs if str(t["label"]) == next_label), None)
        if next_tab:
            points_to_next = int(next_tab["points_manquants"])

    points_to_target = None
    if target_lbl:
        tgt_tab = next((t for t in tabs if str(t["label"]) == target_lbl), None)
        if tgt_tab:
            points_to_target = int(tgt_tab["points_manquants"])
        else:
            points_to_target = 0 if projected_label == target_lbl else None

    projected_tab = next((t for t in tabs if str(t["label"]) == projected_label), None)
    projected_points_cumules = int(projected_tab["points_cumules"]) if projected_tab else 0
    projected_points_minimum = int(projected_tab["points_minimum"]) if projected_tab else 0
    projected_matches_count = int(projected_tab["matches_count"]) if projected_tab else 0
    projected_wins_count = int(projected_tab["wins_count"]) if projected_tab else 0
    projected_win_rate_pct = (
        round((projected_wins_count / projected_matches_count) * 100.0, 1)
        if projected_matches_count > 0
        else 0.0
    )

    next_perf_hint = None
    if next_label and points_to_next and points_to_next > 0:
        # Estimation simple et lisible: perf "à +1 échelon" depuis le palier obtenu.
        idx = tennis_logic.echelon_index(projected_label)
        opp_hint = tennis_logic.ECHELONS[min(len(tennis_logic.ECHELONS) - 1, idx + 1)]
        pts_per_win = max(1, int(tennis_logic.points_for_match(projected_label, opp_hint, True)))
        wins_needed = (int(points_to_next) + pts_per_win - 1) // pts_per_win
        next_perf_hint = {
            "opponent_example": opp_hint,
            "points_per_win_estimate": pts_per_win,
            "wins_needed_estimate": wins_needed,
            "text": f"Exemple: {wins_needed} perf(s) à {opp_hint} (~+{pts_per_win} pts chacune).",
        }

    return {
        "current_label": cur_lbl,
        "projected_label": projected_label,
        "projected_points_cumules": projected_points_cumules,
        "projected_points_minimum": projected_points_minimum,
        "projected_matches_count": projected_matches_count,
        "projected_wins_count": projected_wins_count,
        "projected_win_rate_pct": projected_win_rate_pct,
        "next_label": next_label,
        "points_to_next_label": points_to_next,
        "next_perf_hint": next_perf_hint,
        "target_label": target_lbl or None,
        "points_to_target_label": points_to_target,
        "hypothetical_count": len(hypo_pairs),
        "tabs": tabs,
    }


def fft_points_summary_12m(session_id: str) -> dict[str, Any]:
    from app import tennis_logic

    ensure_profile(session_id)
    prof = get_profile_row(session_id)
    if not prof:
        return {
            "window_months": 12,
            "starting_capital": 0,
            "window_start": tennis_logic.rolling_window_start(date.today(), 12).isoformat(),
            "matches_count": 0,
            "wins_count": 0,
            "losses_count": 0,
            "wins_counted": 0,
            "points_from_matches": 0,
            "current_points": 0,
        }

    cur_l = tennis_logic.normalize_label((prof["current_ranking"] or "").strip() or "40")
    origin_l = tennis_logic.normalize_label((prof["origin_ranking"] or "").strip() or cur_l)
    gender = (prof["gender"] or "M").strip() if "gender" in prof.keys() else "M"
    window_start = tennis_logic.rolling_window_start(date.today(), months=12).isoformat()
    win_rows, losses, matches_total = _collect_fft_window_matches(session_id, cur_l, window_start)
    wins = len(win_rows)

    snap = tennis_logic.fft_snapshot(
        current_label=cur_l,
        origin_label=origin_l,
        gender=gender,
        win_points=[int(w["points"]) for w in win_rows],
        losses_count=losses,
    )
    best = max(win_rows, key=lambda x: int(x["points"]), default=None)
    win_rate = (wins / matches_total * 100.0) if matches_total > 0 else 0.0
    try:
        cur_idx = tennis_logic.echelon_index(cur_l)
    except Exception:
        cur_idx = 0
    echelon_tabs: list[dict[str, Any]] = []
    for label in tennis_logic.ECHELONS[cur_idx : min(len(tennis_logic.ECHELONS), cur_idx + 4)]:
        wins_for_tab, losses_for_tab, total_for_tab = _collect_fft_window_matches(session_id, label, window_start)
        snap_tab = tennis_logic.fft_snapshot(
            current_label=label,
            origin_label=origin_l,
            gender=gender,
            win_points=[int(w["points"]) for w in wins_for_tab],
            losses_count=losses_for_tab,
        )
        echelon_tabs.append(
            {
                "label": label,
                "matches_count": total_for_tab,
                "wins_count": len(wins_for_tab),
                "losses_count": losses_for_tab,
                "wins_counted": int(snap_tab["wins_counted"]),
                "points_cumules": int(snap_tab["counted_points"]),
                "points_total_with_capital": int(snap_tab["current_points"]),
                "points_minimum": int(snap_tab["min_bilan_required"]),
                "points_manquants": max(
                    0, int(snap_tab["min_bilan_required"]) - int(snap_tab["counted_points"])
                ),
            }
        )
    return {
        "window_months": 12,
        "window_start": window_start,
        "matches_count": matches_total,
        "wins_count": wins,
        "losses_count": losses,
        "points_from_matches": int(snap["counted_points"]),
        "win_rate_pct": round(win_rate, 1),
        "best_win": best or None,
        "echelon_tabs": echelon_tabs,
        **snap,
    }


def list_palmares_entries(session_id: str) -> list[dict[str, Any]]:
    ensure_profile(session_id)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, match_date, catalog_player_id, opponent_name, opponent_ranking, won, notes, points_delta, created_at
            FROM palmares_entries
            WHERE session_id = ?
            ORDER BY match_date DESC, id DESC
            """,
            (session_id,),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "match_date": r["match_date"],
            "catalog_player_id": int(r["catalog_player_id"]) if "catalog_player_id" in r.keys() and r["catalog_player_id"] else None,
            "opponent_name": r["opponent_name"] if "opponent_name" in r.keys() else "",
            "opponent_ranking": r["opponent_ranking"],
            "won": bool(r["won"]),
            "notes": r["notes"],
            "points_delta": int(r["points_delta"] or 0),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def add_palmares_entry(
    session_id: str,
    match_date: str,
    opponent_name: str,
    opponent_ranking: str,
    catalog_player_id: Optional[int],
    won: bool,
    notes: str = "",
) -> dict[str, Any]:
    from app import tennis_logic

    ensure_profile(session_id)
    prof = get_profile_row(session_id)
    player_r = (prof["current_ranking"] if prof else "") or "40"
    delta = tennis_logic.points_for_match(player_r, opponent_ranking, won)
    resolved_player_id = catalog_player_id
    if not resolved_player_id and opponent_name.strip():
        resolved_player_id = upsert_opponent(
            session_id=session_id,
            name=opponent_name,
            rank=opponent_ranking,
            notes_perso=notes,
        )
    cur_pts = int(prof["current_points"] or 0) if prof else 0
    new_pts = max(0, cur_pts + delta)
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO palmares_entries (session_id, match_date, catalog_player_id, opponent_name, opponent_ranking, won, notes, points_delta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                match_date,
                resolved_player_id,
                opponent_name.strip(),
                opponent_ranking.strip(),
                1 if won else 0,
                notes or "",
                delta,
            ),
        )
        eid = cur.lastrowid
        conn.execute(
            """
            UPDATE player_profiles SET current_points = ?, updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
            """,
            (new_pts, session_id),
        )
    sync_points_from_ranking_labels(session_id)
    fresh = get_profile_row(session_id)
    return {
        "id": eid,
        "delta": delta,
        "new_points": int(fresh["current_points"] or 0) if fresh else new_pts,
    }


def update_palmares_entry(
    session_id: str,
    entry_id: int,
    match_date: Optional[str] = None,
    opponent_name: Optional[str] = None,
    opponent_ranking: Optional[str] = None,
    catalog_player_id: Optional[int] = None,
    won: Optional[bool] = None,
    notes: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    from app import tennis_logic

    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT * FROM palmares_entries WHERE id = ? AND session_id = ?
            """,
            (entry_id, session_id),
        ).fetchone()
        if not row:
            return None
        md = match_date if match_date is not None else row["match_date"]
        opp_name = (
            opponent_name.strip()
            if opponent_name is not None
            else (row["opponent_name"] if "opponent_name" in row.keys() else "")
        )
        opp = (
            opponent_ranking.strip()
            if opponent_ranking is not None
            else row["opponent_ranking"]
        )
        w = bool(row["won"]) if won is None else won
        nt = notes if notes is not None else row["notes"]
        prof = get_profile_row(session_id)
        player_r = (prof["current_ranking"] if prof else "") or "40"
        new_delta = tennis_logic.points_for_match(player_r, opp, w)
        resolved_catalog_player_id = catalog_player_id
        if not resolved_catalog_player_id and opp_name:
            resolved_catalog_player_id = upsert_opponent(
                session_id=session_id,
                name=opp_name,
                rank=opp,
                notes_perso=str(nt or ""),
            )
        old_delta = int(row["points_delta"] or 0)
        cur_pts = int(prof["current_points"] or 0) if prof else 0
        adjusted = max(0, cur_pts - old_delta + new_delta)
        conn.execute(
            """
            UPDATE palmares_entries
            SET match_date = ?, catalog_player_id = ?, opponent_name = ?, opponent_ranking = ?, won = ?, notes = ?, points_delta = ?
            WHERE id = ? AND session_id = ?
            """,
            (
                md,
                resolved_catalog_player_id,
                opp_name,
                opp,
                1 if w else 0,
                nt or "",
                new_delta,
                entry_id,
                session_id,
            ),
        )
        conn.execute(
            """
            UPDATE player_profiles SET current_points = ?, updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
            """,
            (adjusted, session_id),
        )
    sync_points_from_ranking_labels(session_id)
    fresh = get_profile_row(session_id)
    return {
        "id": entry_id,
        "delta": new_delta,
        "new_points": int(fresh["current_points"] or 0) if fresh else adjusted,
    }


def delete_palmares_entry(session_id: str, entry_id: int) -> bool:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT points_delta FROM palmares_entries WHERE id = ? AND session_id = ?",
            (entry_id, session_id),
        ).fetchone()
        if not row:
            return False
        old_delta = int(row["points_delta"] or 0)
        prof = get_profile_row(session_id)
        cur_pts = int(prof["current_points"] or 0) if prof else 0
        adjusted = max(0, cur_pts - old_delta)
        conn.execute(
            "DELETE FROM palmares_entries WHERE id = ? AND session_id = ?",
            (entry_id, session_id),
        )
        conn.execute(
            """
            UPDATE player_profiles SET current_points = ?, updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
            """,
            (adjusted, session_id),
        )
    sync_points_from_ranking_labels(session_id)
    return True


def _parse_iso(dt: str) -> datetime:
    cleaned = dt.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(cleaned)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def get_next_scheduled_match(session_id: str) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            """
            SELECT * FROM matches
            WHERE session_id = ? AND status = 'scheduled'
            ORDER BY match_datetime ASC
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()


def get_last_completed_pending_fft(session_id: str) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            """
            SELECT * FROM matches
            WHERE session_id = ? AND status = 'completed' AND fft_points_applied = 0
            ORDER BY id DESC
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()


def get_dashboard_match_row(session_id: str) -> Optional[sqlite3.Row]:
    """Match affiche sur le dashboard : prochain scheduled, ou dernier complete sans points FFT."""
    scheduled = get_next_scheduled_match(session_id)
    if scheduled:
        return scheduled
    return get_last_completed_pending_fft(session_id)


def get_opponent_by_id(session_id: str, opponent_id: int) -> Optional[sqlite3.Row]:
    # opponent_id now references players_catalog.id (global)
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM players_catalog WHERE id = ?",
            (opponent_id,),
        ).fetchone()


def get_opponent_by_name(session_id: str, name: str) -> Optional[sqlite3.Row]:
    key = _opponent_name_key(name)
    if not key:
        return None
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM players_catalog WHERE normalized_name = ?",
            (key,),
        ).fetchone()


def search_players_catalog(query: str, limit: int = 20) -> list[dict[str, Any]]:
    key = _opponent_name_key(query)
    with get_conn() as conn:
        if key:
            rows = conn.execute(
                """
                SELECT id, display_name, current_rank, play_style, public_notes, is_verified, player_status
                FROM players_catalog
                WHERE normalized_name LIKE ?
                ORDER BY updated_at DESC, id DESC
                LIMIT ?
                """,
                (f"%{key}%", max(1, int(limit))),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, display_name, current_rank, play_style, public_notes, is_verified, player_status
                FROM players_catalog
                ORDER BY updated_at DESC, id DESC
                LIMIT ?
                """,
                (max(1, int(limit)),),
            ).fetchall()
    return [
        {
            "id": int(r["id"]),
            "display_name": r["display_name"],
            "current_rank": r["current_rank"],
            "play_style": r["play_style"],
            "public_notes": r["public_notes"],
            "is_verified": bool(int(r["is_verified"] or 0)),
            "player_status": str(r["player_status"]) if "player_status" in r.keys() else "active",
        }
        for r in rows
    ]


def upsert_opponent(
    session_id: str,
    name: str,
    rank: str = "",
    play_style: str = "",
    notes_perso: str = "",
) -> Optional[int]:
    clean_name = " ".join((name or "").strip().split())
    key = _opponent_name_key(clean_name)
    if not clean_name or not key:
        return None
    placeholder_keys = {"a definir", "à définir", "anonyme", "??", "?"}
    player_status = "placeholder" if key in placeholder_keys else "active"
    if player_status == "placeholder":
        return None
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM players_catalog WHERE normalized_name = ?",
            (key,),
        ).fetchone()
        if row:
            next_rank = rank.strip() if rank.strip() else str(row["current_rank"] or "")
            next_style = play_style.strip() if play_style.strip() else str(row["play_style"] or "")
            next_public_notes = (
                str(row["public_notes"] or "")
                if str(row["public_notes"] or "").strip()
                else notes_perso.strip()
            )
            conn.execute(
                """
                UPDATE players_catalog
                SET display_name = ?, current_rank = ?, play_style = ?, public_notes = ?, player_status = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (clean_name, next_rank, next_style, next_public_notes, player_status, int(row["id"])),
            )
            player_id = int(row["id"])
        else:
            cur = conn.execute(
                """
                INSERT INTO players_catalog(
                    display_name, normalized_name, current_rank, play_style, public_notes, player_status, is_verified, created_by_session_id
                )
                VALUES (?, ?, ?, ?, ?, ?, 0, ?)
                """,
                (clean_name, key, rank.strip(), play_style.strip(), notes_perso.strip(), player_status, session_id),
            )
            player_id = int(cur.lastrowid)

        conn.execute(
            """
            INSERT INTO user_opponents(session_id, player_id, private_notes, private_tags, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(session_id, player_id) DO UPDATE SET
                private_notes = CASE
                    WHEN excluded.private_notes != '' THEN excluded.private_notes
                    ELSE user_opponents.private_notes
                END,
                private_tags = CASE
                    WHEN excluded.private_tags != '' THEN excluded.private_tags
                    ELSE user_opponents.private_tags
                END,
                updated_at = CURRENT_TIMESTAMP
            """,
            (session_id, player_id, notes_perso.strip(), play_style.strip()),
        )
        return player_id


def list_opponents_with_h2h(session_id: str) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                p.id,
                p.display_name AS name,
                p.current_rank AS rank,
                p.play_style AS play_style,
                COALESCE(u.private_notes, '') AS notes_perso,
                COALESCE(SUM(CASE WHEN m.outcome = 'won' THEN 1 ELSE 0 END), 0) AS wins,
                COALESCE(SUM(CASE WHEN m.outcome = 'lost' THEN 1 ELSE 0 END), 0) AS losses
            FROM user_opponents u
            JOIN players_catalog p ON p.id = u.player_id
            LEFT JOIN matches m
              ON m.session_id = u.session_id
             AND (m.catalog_player_id = p.id OR m.opponent_id = p.id)
             AND m.status = 'completed'
            WHERE u.session_id = ?
            GROUP BY p.id, p.display_name, p.current_rank, p.play_style, u.private_notes
            ORDER BY MAX(u.updated_at) DESC, p.id DESC
            """,
            (session_id,),
        ).fetchall()
    return [
        {
            "id": int(r["id"]),
            "name": r["name"],
            "rank": r["rank"],
            "play_style": r["play_style"],
            "notes_perso": r["notes_perso"],
            "wins": int(r["wins"] or 0),
            "losses": int(r["losses"] or 0),
        }
        for r in rows
    ]


def cancel_other_scheduled(session_id: str, keep_id: int) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE matches SET status = 'cancelled'
            WHERE session_id = ? AND status = 'scheduled' AND id != ?
            """,
            (session_id, keep_id),
        )


def create_match(
    session_id: str,
    match_datetime: str,
    opponent_id: Optional[int] = None,
    opponent_name: str = "",
    opponent_ranking: str = "",
    opponent_style: str = "",
    opponent_notes: str = "",
    focus_text: str = "",
    surface: str = "",
    match_format: str = "",
    club_location: str = "",
) -> int:
    ensure_profile(session_id)
    resolved_opponent_id = opponent_id
    if not resolved_opponent_id and opponent_name.strip() and not _is_placeholder_opponent_name(opponent_name):
        resolved_opponent_id = upsert_opponent(
            session_id=session_id,
            name=opponent_name,
            rank=opponent_ranking,
            play_style=opponent_style,
            notes_perso=opponent_notes,
        )
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO matches(
                session_id, match_datetime, opponent_id, catalog_player_id, opponent_name, opponent_ranking,
                opponent_notes, surface, match_format, club_location, status, focus_text
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
            """,
            (
                session_id,
                match_datetime,
                resolved_opponent_id,
                resolved_opponent_id,
                opponent_name,
                opponent_ranking,
                opponent_notes,
                surface,
                match_format,
                club_location,
                focus_text,
            ),
        )
        match_id = int(cur.lastrowid)
    cancel_other_scheduled(session_id, match_id)
    return match_id


def update_match(
    match_id: int,
    session_id: str,
    **fields: Any,
) -> bool:
    allowed = {
        "match_datetime",
        "opponent_id",
        "catalog_player_id",
        "opponent_name",
        "opponent_ranking",
        "opponent_notes",
        "surface",
        "match_format",
        "club_location",
        "focus_text",
        "status",
        "result_score",
        "result_feeling",
        "outcome",
    }
    opponent_style = str(fields.get("opponent_style") or "").strip()
    updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if not updates and not opponent_style:
        return False
    existing = get_match_row(match_id, session_id)
    if not existing:
        return False

    incoming_opponent_id = updates.get("opponent_id")
    incoming_name = (
        str(updates.get("opponent_name"))
        if "opponent_name" in updates
        else str(existing["opponent_name"] or "")
    ).strip()
    incoming_rank = (
        str(updates.get("opponent_ranking"))
        if "opponent_ranking" in updates
        else str(existing["opponent_ranking"] or "")
    ).strip()
    incoming_notes = (
        str(updates.get("opponent_notes"))
        if "opponent_notes" in updates
        else str(existing["opponent_notes"] or "")
    ).strip()

    try:
        resolved_opponent_id = int(incoming_opponent_id) if incoming_opponent_id else None
    except Exception:
        resolved_opponent_id = None
    if not resolved_opponent_id and incoming_name and not _is_placeholder_opponent_name(incoming_name):
        resolved_opponent_id = upsert_opponent(
            session_id=session_id,
            name=incoming_name,
            rank=incoming_rank,
            play_style=opponent_style,
            notes_perso=incoming_notes,
        )
    elif resolved_opponent_id:
        row = get_opponent_by_id(session_id, resolved_opponent_id)
        if row:
            upsert_opponent(
                session_id=session_id,
                name=incoming_name or str(row["name"] or ""),
                rank=incoming_rank or str(row["rank"] or ""),
                play_style=opponent_style or str(row["play_style"] or ""),
                notes_perso=incoming_notes or str(row["notes_perso"] or ""),
            )
    if resolved_opponent_id:
        updates["opponent_id"] = resolved_opponent_id
        updates["catalog_player_id"] = resolved_opponent_id

    cols = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values())
    values.extend([match_id, session_id])
    if updates:
        with get_conn() as conn:
            cur = conn.execute(
                f"UPDATE matches SET {cols} WHERE id = ? AND session_id = ?",
                values,
            )
            ok = cur.rowcount > 0
    else:
        ok = True
    if ok:
        sync_match_history_from_match(session_id, match_id)
        sync_palmares_from_match(session_id, match_id)
    return ok


def complete_match_debrief(
    session_id: str,
    match_id: int,
    result_score: str,
    result_feeling: str,
) -> bool:
    return update_match(
        match_id,
        session_id,
        status="completed",
        result_score=result_score,
        result_feeling=result_feeling,
    )


def delete_tasks_for_session_after(session_id: str, from_date: Optional[str]) -> None:
    with get_conn() as conn:
        if from_date:
            conn.execute(
                "DELETE FROM program_tasks WHERE session_id = ? AND task_date >= ?",
                (session_id, from_date),
            )
        else:
            conn.execute("DELETE FROM program_tasks WHERE session_id = ?", (session_id,))


def replace_program_tasks(
    session_id: str,
    match_id: Optional[int],
    tasks: list[dict[str, Any]],
) -> int:
    """Replace all future tasks from min date in payload; if empty, no-op."""
    if not tasks:
        return 0
    dates = [t["task_date"] for t in tasks if t.get("task_date")]
    if not dates:
        return 0
    poles = get_staff_poles(session_id)
    start = min(dates)
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM program_tasks WHERE session_id = ? AND task_date >= ?",
            (session_id, start),
        )
        for index, task in enumerate(tasks):
            raw_task_type = str(task.get("task_type") or "").strip()
            task_type = normalize_task_type(raw_task_type) if raw_task_type else infer_task_type_from_text(
                str(task.get("title") or ""),
                str(task.get("description") or ""),
                str(task.get("category") or ""),
            )
            if not poles.get(normalize_task_type(task_type), True):
                continue
            legacy_category = LEGACY_CATEGORY_BY_TASK_TYPE.get(task_type, "tennis")
            conn.execute(
                """
                INSERT INTO program_tasks(
                    session_id, match_id, task_date, category, task_type, duration_min,
                    title, description, status, sort_order
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                """,
                (
                    session_id,
                    match_id,
                    task["task_date"],
                    legacy_category,
                    task_type,
                    int(task.get("duration_min", 30)),
                    task["title"],
                    task.get("description") or "",
                    int(task.get("sort_order", index)),
                ),
            )
    return len(tasks)


def upsert_single_task(
    session_id: str,
    task_date: str,
    category: str,
    title: str,
    description: str = "",
    task_type: str = "technique",
    duration_min: int = 30,
    match_id: Optional[int] = None,
) -> int:
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT id FROM program_tasks
            WHERE session_id = ? AND task_date = ? AND category = ? AND title = ?
            """,
            (session_id, task_date, category, title),
        ).fetchone()
        if row:
            tid = int(row["id"])
            conn.execute(
                """
                UPDATE program_tasks
                SET description = ?, task_type = ?, duration_min = ?, match_id = COALESCE(?, match_id)
                WHERE id = ?
                """,
                (description, normalize_task_type(task_type), int(duration_min), match_id, tid),
            )
            return tid
        normalized = normalize_task_type(task_type)
        if not task_type_enabled(session_id, normalized):
            return -1
        cur = conn.execute(
            """
            INSERT INTO program_tasks(
                session_id, match_id, task_date, category, task_type, duration_min,
                title, description, status, sort_order
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
            """,
            (
                session_id,
                match_id,
                task_date,
                category,
                normalized,
                int(duration_min),
                title,
                description,
            ),
        )
        return int(cur.lastrowid)


def append_program_task(
    session_id: str,
    task_date: str,
    title: str,
    description: str,
    task_type: str,
    duration_min: int,
) -> Optional[int]:
    """
    Insère une tâche en fin de journée (sort_order = max + 1).
    Retourne l'id créé, ou None si le type est désactivé (staff).
    """
    tt = normalize_task_type(task_type)
    if not task_type_enabled(session_id, tt):
        return None
    legacy = LEGACY_CATEGORY_BY_TASK_TYPE.get(tt, "tennis")
    match_row = get_next_scheduled_match(session_id)
    mid = int(match_row["id"]) if match_row else None
    title = (title or "").strip()
    if not title:
        return None
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT COALESCE(MAX(sort_order), -1) AS m
            FROM program_tasks
            WHERE session_id = ? AND task_date = ?
            """,
            (session_id, task_date),
        ).fetchone()
        sort_order = int(row["m"] if row and row["m"] is not None else -1) + 1
        cur = conn.execute(
            """
            INSERT INTO program_tasks(
                session_id, match_id, task_date, category, task_type, duration_min,
                title, description, status, sort_order
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
            """,
            (
                session_id,
                mid,
                task_date,
                legacy,
                tt,
                int(duration_min),
                title,
                description or "",
                sort_order,
            ),
        )
        return int(cur.lastrowid)


def update_task(
    task_id: int,
    session_id: str,
    status: Optional[str] = None,
    title: Optional[str] = None,
    description: Optional[str] = None,
    postponed_to_date: Optional[str] = None,
    task_date: Optional[str] = None,
    task_type: Optional[str] = None,
    duration_min: Optional[int] = None,
) -> bool:
    fields: dict[str, Any] = {}
    if status is not None:
        fields["status"] = status
    if title is not None:
        fields["title"] = title
    if description is not None:
        fields["description"] = description
    if postponed_to_date is not None:
        fields["postponed_to_date"] = postponed_to_date
    if task_date is not None:
        fields["task_date"] = task_date
    if task_type is not None:
        fields["task_type"] = normalize_task_type(task_type)
    if duration_min is not None:
        fields["duration_min"] = int(duration_min)
    if not fields:
        return False
    cols = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values())
    values.extend([task_id, session_id])
    with get_conn() as conn:
        cur = conn.execute(
            f"UPDATE program_tasks SET {cols} WHERE id = ? AND session_id = ?",
            values,
        )
        return cur.rowcount > 0


def delete_task(task_id: int, session_id: str) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM program_tasks WHERE id = ? AND session_id = ?",
            (task_id, session_id),
        )
        return cur.rowcount > 0


def get_tasks_between(session_id: str, start: str, end: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM program_tasks
            WHERE session_id = ? AND task_date >= ? AND task_date <= ?
            ORDER BY task_date ASC, sort_order ASC, id ASC
            """,
            (session_id, start, end),
        ).fetchall()
    return list(rows)


def get_today_str() -> str:
    return date.today().isoformat()


def match_ui_state(
    match_row: Optional[sqlite3.Row],
) -> Literal["no_match", "upcoming", "past"]:
    if match_row is None:
        return "no_match"
    if match_row["status"] == "completed" and int(match_row["fft_points_applied"] or 0) == 0:
        return "past"
    try:
        mdt = _parse_iso(match_row["match_datetime"])
    except ValueError:
        return "no_match"
    if match_row["status"] == "scheduled" and mdt <= now_utc():
        return "past"
    return "upcoming"


def points_gap(profile_row: Optional[sqlite3.Row]) -> Optional[int]:
    if not profile_row:
        return None
    cur = profile_row["current_points"]
    tgt = profile_row["target_points"]
    if cur is None or tgt is None:
        return None
    return max(0, int(tgt) - int(cur))


def get_match_row(match_id: int, session_id: str) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM matches WHERE id = ? AND session_id = ?",
            (match_id, session_id),
        ).fetchone()


def _match_date_from_datetime(value: str) -> str:
    text = (value or "").strip()
    if not text:
        return date.today().isoformat()
    try:
        return _parse_iso(text).date().isoformat()
    except Exception:
        return text[:10]


def sync_match_history_from_match(session_id: str, match_id: int) -> None:
    row = get_match_row(match_id, session_id)
    if not row:
        return
    status = str(row["status"] or "").strip().lower()
    with get_conn() as conn:
        if status != "completed":
            conn.execute(
                "DELETE FROM match_history WHERE session_id = ? AND match_id = ?",
                (session_id, match_id),
            )
            return
        conn.execute(
            """
            INSERT INTO match_history(session_id, match_id, match_date, outcome, score, opponent_name, sensations, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(session_id, match_id) DO UPDATE SET
                match_date = excluded.match_date,
                outcome = excluded.outcome,
                score = excluded.score,
                opponent_name = excluded.opponent_name,
                sensations = excluded.sensations,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                session_id,
                match_id,
                _match_date_from_datetime(str(row["match_datetime"] or "")),
                str(row["outcome"] or ""),
                str(row["result_score"] or ""),
                str(row["opponent_name"] or ""),
                str(row["result_feeling"] or ""),
            ),
        )


def sync_palmares_from_match(session_id: str, match_id: int) -> None:
    row = get_match_row(match_id, session_id)
    if not row:
        return
    status = str(row["status"] or "").strip().lower()
    outcome = str(row["outcome"] or "").strip().lower()
    auto_note = f"[AUTO_MATCH:{match_id}]"
    with get_conn() as conn:
        if status != "completed" or outcome not in {"won", "lost"}:
            conn.execute(
                "DELETE FROM palmares_entries WHERE session_id = ? AND notes = ?",
                (session_id, auto_note),
            )
            return
        won = 1 if outcome == "won" else 0
        match_date = _match_date_from_datetime(str(row["match_datetime"] or ""))
        existing = conn.execute(
            "SELECT id FROM palmares_entries WHERE session_id = ? AND notes = ? LIMIT 1",
            (session_id, auto_note),
        ).fetchone()
        if existing:
            conn.execute(
                """
                UPDATE palmares_entries
                SET match_date = ?, catalog_player_id = ?, opponent_name = ?, opponent_ranking = ?, won = ?
                WHERE id = ? AND session_id = ?
                """,
                (
                    match_date,
                    int(row["catalog_player_id"]) if row["catalog_player_id"] else None,
                    str(row["opponent_name"] or ""),
                    str(row["opponent_ranking"] or ""),
                    won,
                    int(existing["id"]),
                    session_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO palmares_entries(
                    session_id, match_date, catalog_player_id, opponent_name, opponent_ranking, won, notes, points_delta
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    session_id,
                    match_date,
                    int(row["catalog_player_id"]) if row["catalog_player_id"] else None,
                    str(row["opponent_name"] or ""),
                    str(row["opponent_ranking"] or ""),
                    won,
                    auto_note,
                ),
            )


def list_match_history(session_id: str, limit: int = 50) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT match_id, match_date, outcome, score, opponent_name, sensations, updated_at
            FROM match_history
            WHERE session_id = ?
            ORDER BY match_date DESC, match_id DESC
            LIMIT ?
            """,
            (session_id, max(1, int(limit))),
        ).fetchall()
    return [
        {
            "match_id": int(r["match_id"]),
            "match_date": r["match_date"],
            "outcome": r["outcome"],
            "score": r["score"],
            "opponent_name": r["opponent_name"],
            "sensations": r["sensations"],
            "updated_at": r["updated_at"],
        }
        for r in rows
    ]


def apply_fft_match_points(
    session_id: str,
    match_id: int,
    won: bool,
    opponent_ranking_fft: str,
) -> dict[str, Any]:
    from app import tennis_logic

    row = get_match_row(match_id, session_id)
    if not row:
        return {"ok": False, "error": "match_not_found"}
    if int(row["fft_points_applied"] or 0) == 1:
        return {
            "ok": False,
            "error": "fft_already_applied",
            "message": "Points FFT deja appliques pour ce match.",
        }

    ensure_profile(session_id)
    prof = get_profile_row(session_id)
    player_r = (prof["current_ranking"] if prof else "") or "40"
    delta = tennis_logic.points_for_match(player_r, opponent_ranking_fft, won)
    delta = int(round(delta * match_format_multiplier(str(row["match_format"] or ""))))
    cur_pts = int(prof["current_points"] or 0) if prof else 0
    new_pts = max(0, cur_pts + delta)
    streak = int(prof["win_streak"] or 0) if prof else 0
    new_streak = streak + 1 if won else 0

    with get_conn() as conn:
        resolved_opponent_id = int(row["opponent_id"]) if row["opponent_id"] else None
        if (
            not resolved_opponent_id
            and str(row["opponent_name"] or "").strip()
            and not _is_placeholder_opponent_name(str(row["opponent_name"] or ""))
        ):
            resolved_opponent_id = upsert_opponent(
                session_id=session_id,
                name=str(row["opponent_name"] or ""),
                rank=opponent_ranking_fft,
                notes_perso=str(row["opponent_notes"] or ""),
            )
        conn.execute(
            """
            UPDATE player_profiles
            SET current_points = ?, win_streak = ?, updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
            """,
            (new_pts, new_streak, session_id),
        )
        conn.execute(
            """
            UPDATE matches
            SET opponent_id = ?, catalog_player_id = ?, opponent_ranking = ?, outcome = ?, fft_points_applied = 1
            WHERE id = ? AND session_id = ?
            """,
            (
                resolved_opponent_id,
                resolved_opponent_id,
                opponent_ranking_fft,
                "won" if won else "lost",
                match_id,
                session_id,
            ),
        )
    sync_points_from_ranking_labels(session_id)
    fresh = get_profile_row(session_id)
    sync_match_history_from_match(session_id, match_id)
    sync_palmares_from_match(session_id, match_id)
    return {
        "ok": True,
        "delta": delta,
        "new_points": int(fresh["current_points"] or 0) if fresh else new_pts,
        "win_streak": new_streak,
    }


def add_chat_message(session_id: str, role: str, content: str) -> None:
    upsert_chat_session(session_id)
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO chat_messages(session_id, role, content)
            VALUES (?, ?, ?)
            """,
            (session_id, role, content),
        )
        conn.execute(
            """
            UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
            """,
            (session_id,),
        )


def get_chat_summary(session_id: str) -> str:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT summary FROM chat_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        return row["summary"] if row else ""


def get_all_chat_messages(session_id: str) -> list[dict[str, str]]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT role, content
            FROM chat_messages
            WHERE session_id = ?
            ORDER BY id ASC
            """,
            (session_id,),
        ).fetchall()
    return [{"role": row["role"], "content": row["content"]} for row in rows]


def get_recent_chat_messages(session_id: str, limit: int) -> list[dict[str, str]]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT role, content
            FROM chat_messages
            WHERE session_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (session_id, limit),
        ).fetchall()
    ordered = list(reversed(rows))
    return [{"role": row["role"], "content": row["content"]} for row in ordered]


def update_chat_summary(session_id: str, summary: str) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE chat_sessions
            SET summary = ?, updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
            """,
            (summary, session_id),
        )


def prune_chat_messages_keep_recent(session_id: str, keep_recent: int) -> None:
    with get_conn() as conn:
        conn.execute(
            f"""
            DELETE FROM chat_messages
            WHERE session_id = ?
              AND id NOT IN (
                SELECT id FROM chat_messages
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT {keep_recent}
              )
            """,
            (session_id, session_id),
        )


def reset_chat_session(session_id: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM chat_messages WHERE session_id = ?", (session_id,))
        conn.execute(
            "UPDATE chat_sessions SET summary = '' WHERE session_id = ?",
            (session_id,),
        )


EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalize_email(email: str) -> str:
    return " ".join((email or "").strip().lower().split())


def get_user_by_email(email: str) -> Optional[sqlite3.Row]:
    key = normalize_email(email)
    if not key:
        return None
    with get_conn() as conn:
        return conn.execute("SELECT * FROM users WHERE email = ?", (key,)).fetchone()


def get_user_by_id(user_id: str) -> Optional[sqlite3.Row]:
    if not user_id:
        return None
    with get_conn() as conn:
        return conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()


def create_user(email: str, password_plain: str) -> str:
    import bcrypt

    key = normalize_email(email)
    if not key or not EMAIL_PATTERN.match(key):
        raise ValueError("email_invalide")
    if len(password_plain) < 8:
        raise ValueError("mot_de_passe_trop_court")
    if get_user_by_email(key):
        raise ValueError("email_deja_utilise")
    user_id = str(uuid.uuid4())
    pw_hash = bcrypt.hashpw(
        password_plain.encode("utf-8"), bcrypt.gensalt(rounds=12)
    ).decode("ascii")
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO users (user_id, email, password_hash)
            VALUES (?, ?, ?)
            """,
            (user_id, key, pw_hash),
        )
    ensure_profile(user_id)
    update_profile(user_id, onboarding_completed=0)
    return user_id


def verify_user_password(email: str, password_plain: str) -> Optional[str]:
    import bcrypt

    key = normalize_email(email)
    row = get_user_by_email(key)
    if not row:
        return None
    try:
        ok = bcrypt.checkpw(
            password_plain.encode("utf-8"),
            str(row["password_hash"]).encode("utf-8"),
        )
    except ValueError:
        return None
    if not ok:
        return None
    return str(row["user_id"])


def verify_user_password_by_id(user_id: str, password_plain: str) -> bool:
    import bcrypt

    row = get_user_by_id(user_id)
    if not row:
        return False
    try:
        return bcrypt.checkpw(
            password_plain.encode("utf-8"),
            str(row["password_hash"]).encode("utf-8"),
        )
    except ValueError:
        return False


def set_password_reset_token(email: str, token: str, expires_at: datetime) -> bool:
    key = normalize_email(email)
    if not get_user_by_email(key):
        return False
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE users
            SET reset_token = ?, reset_token_expires = ?
            WHERE email = ?
            """,
            (token, expires_at.isoformat(), key),
        )
    return True


def get_user_by_reset_token(token: str) -> Optional[sqlite3.Row]:
    if not token:
        return None
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM users WHERE reset_token = ?", (token,)
        ).fetchone()


def clear_reset_token(user_id: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET reset_token = NULL, reset_token_expires = NULL WHERE user_id = ?",
            (user_id,),
        )


def update_user_password(user_id: str, new_plain: str) -> None:
    import bcrypt

    if len(new_plain) < 8:
        raise ValueError("mot_de_passe_trop_court")
    pw_hash = bcrypt.hashpw(
        new_plain.encode("utf-8"), bcrypt.gensalt(rounds=12)
    ).decode("ascii")
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE user_id = ?",
            (pw_hash, user_id),
        )
    clear_reset_token(user_id)


def delete_user_cascade(user_id: str) -> None:
    """Supprime toutes les données liées à user_id (= session_id métier)."""
    with get_conn() as conn:
        conn.execute("DELETE FROM chat_messages WHERE session_id = ?", (user_id,))
        conn.execute("DELETE FROM program_tasks WHERE session_id = ?", (user_id,))
        conn.execute("DELETE FROM match_history WHERE session_id = ?", (user_id,))
        conn.execute("DELETE FROM palmares_entries WHERE session_id = ?", (user_id,))
        conn.execute("DELETE FROM matches WHERE session_id = ?", (user_id,))
        conn.execute("DELETE FROM user_opponents WHERE session_id = ?", (user_id,))
        conn.execute("DELETE FROM opponents WHERE session_id = ?", (user_id,))
        conn.execute("DELETE FROM context_memory WHERE session_id = ?", (user_id,))
        conn.execute("DELETE FROM player_profiles WHERE session_id = ?", (user_id,))
        conn.execute("DELETE FROM chat_sessions WHERE session_id = ?", (user_id,))
        conn.execute(
            "UPDATE players_catalog SET created_by_session_id = '' WHERE created_by_session_id = ?",
            (user_id,),
        )
        conn.execute("DELETE FROM users WHERE user_id = ?", (user_id,))


def dashboard_payload(session_id: str) -> dict[str, Any]:
    from app import tennis_logic

    ensure_profile(session_id)
    sync_points_from_ranking_labels(session_id)
    profile = get_profile_row(session_id)
    match_row = get_dashboard_match_row(session_id)
    ui = match_ui_state(match_row)

    today = get_today_str()
    end_date = today
    if match_row and ui == "upcoming":
        end_date = _parse_iso(match_row["match_datetime"]).date().isoformat()
    elif match_row and ui == "past":
        end_date = today

    tasks_today = get_tasks_between(session_id, today, today)
    tasks_until = get_tasks_between(session_id, today, end_date) if match_row else []

    cur_pts = int(profile["current_points"] or 0) if profile else 0
    cur_lbl = (profile["current_ranking"] if profile else "") or "40"
    cur_lbl = tennis_logic.normalize_label(cur_lbl)
    tgt_lbl = (profile["target_ranking"] if profile else "") or ""
    tgt_threshold = (
        tennis_logic.points_threshold_for_label(tgt_lbl) if tgt_lbl else None
    )
    pts_to_tgt_computed = (
        max(0, tgt_threshold - cur_pts) if tgt_threshold is not None else None
    )

    next_lbl = tennis_logic.next_echelon_label(cur_lbl)
    pts_to_next = tennis_logic.points_to_next_echelon(cur_pts, cur_lbl)
    if next_lbl:
        try:
            next_snap = _fft_snapshot_for_label(session_id, next_lbl)
            pts_to_next = int(next_snap.get("points_to_min_bilan", pts_to_next or 0))
        except Exception:
            pass

    profile_out = {
        "display_name": profile["display_name"] if profile else "",
        "gender": profile["gender"] if profile and "gender" in profile.keys() else "M",
        "avatar_data_url": profile["avatar_data_url"] if profile and "avatar_data_url" in profile.keys() else "",
        "current_ranking": profile["current_ranking"] if profile else "",
        "origin_ranking": profile["origin_ranking"] if profile and "origin_ranking" in profile.keys() else "",
        "target_ranking": profile["target_ranking"] if profile else "",
        "current_points": profile["current_points"] if profile else None,
        "target_points": profile["target_points"] if profile else None,
        "points_to_target": pts_to_tgt_computed
        if pts_to_tgt_computed is not None
        else points_gap(profile),
        "target_threshold_points": tgt_threshold,
        "preferred_surface": profile["preferred_surface"] if profile else "",
        "weekly_availability": profile["weekly_availability"] if profile else "",
        "injury_notes": profile["injury_notes"] if profile else "",
        "playing_style": profile["playing_style"] if profile else "",
        "win_streak": int(profile["win_streak"] or 0) if profile else 0,
        "goal_progress_ratio": tennis_logic.progress_ratio_to_target(cur_pts, tgt_lbl)
        if tgt_lbl
        else 0.0,
        "projected_ranking_from_points": tennis_logic.projected_ranking_label(cur_pts),
        "points_to_next_echelon": pts_to_next,
        "next_echelon_label": next_lbl,
        "fft_monthly_update_hint": tennis_logic.fft_monthly_update_sentence(),
        "fft_points_summary_12m": fft_points_summary_12m(session_id),
        "onboarding_completed": (
            bool(int(profile["onboarding_completed"] or 0))
            if profile and "onboarding_completed" in profile.keys()
            else True
        ),
        "profile_created_at": (
            str(profile["created_at"]).strip()
            if profile and "created_at" in profile.keys() and profile["created_at"]
            else None
        ),
    }
    tabs = profile_out["fft_points_summary_12m"].get("echelon_tabs", [])
    if next_lbl and isinstance(tabs, list):
        next_tab = next((t for t in tabs if isinstance(t, dict) and t.get("label") == next_lbl), None)
        if isinstance(next_tab, dict):
            try:
                profile_out["points_to_next_echelon"] = int(next_tab.get("points_manquants", pts_to_next or 0))
            except Exception:
                pass
    context_memory = get_context_memory(session_id) or {}
    staff_poles = get_staff_poles(session_id) or DEFAULT_STAFF_POLES.copy()
    match_history = list_match_history(session_id, limit=30)

    match_out: Optional[dict[str, Any]] = None
    days_remaining: Optional[int] = None
    if match_row:
        opponent_row = None
        candidate_player_id = None
        if "catalog_player_id" in match_row.keys() and match_row["catalog_player_id"]:
            candidate_player_id = int(match_row["catalog_player_id"])
        elif "opponent_id" in match_row.keys() and match_row["opponent_id"]:
            candidate_player_id = int(match_row["opponent_id"])
        if candidate_player_id:
            try:
                opponent_row = get_opponent_by_id(session_id, candidate_player_id)
            except Exception:
                opponent_row = None
        mdt = _parse_iso(match_row["match_datetime"])
        if ui == "upcoming":
            days_remaining = max(0, (mdt.date() - date.today()).days)
        opponent_r = (match_row["opponent_ranking"] or "").strip()
        stake_if_win: Optional[int] = None
        stake_label = ""
        if opponent_r:
            try:
                base_stake = tennis_logic.points_for_match(cur_lbl, opponent_r, True)
                stake_if_win = int(
                    round(base_stake * match_format_multiplier(str(match_row["match_format"] or "")))
                )
                if stake_if_win >= 80:
                    stake_label = "Gros levier de progression"
                elif stake_if_win >= 50:
                    stake_label = "Match important pour monter"
                elif stake_if_win >= 30:
                    stake_label = "Match à sécuriser"
                else:
                    stake_label = "Match de maintien"
            except Exception:
                stake_if_win = None
                stake_label = ""
        match_out = {
            "id": match_row["id"],
            "match_datetime": match_row["match_datetime"],
            "opponent_id": candidate_player_id,
            "opponent_name": match_row["opponent_name"],
            "opponent_ranking": match_row["opponent_ranking"],
            "opponent_style": (opponent_row["play_style"] if opponent_row else "") if opponent_row else "",
            "opponent_notes": match_row["opponent_notes"] if "opponent_notes" in match_row.keys() else "",
            "surface": match_row["surface"] if "surface" in match_row.keys() else "",
            "match_format": match_row["match_format"] if "match_format" in match_row.keys() else "",
            "club_location": match_row["club_location"] if "club_location" in match_row.keys() else "",
            "focus_text": match_row["focus_text"],
            "status": match_row["status"],
            "ui_state": ui,
            "days_remaining": days_remaining,
            "result_score": match_row["result_score"],
            "result_feeling": match_row["result_feeling"],
            "points_if_win": stake_if_win,
            "stakes_label": stake_label,
            "outcome": match_row["outcome"] if "outcome" in match_row.keys() else "",
            "fft_points_applied": int(match_row["fft_points_applied"] or 0)
            if "fft_points_applied" in match_row.keys()
            else 0,
        }

    def serialize_tasks(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for r in rows:
            category = r["category"]
            raw_tt = (r["task_type"] if "task_type" in r.keys() else "") or ""
            task_type = normalize_task_type(raw_tt)
            # Backfill old rows where migration defaulted to technique.
            if task_type == "technique" and category in ("nutrition", "mental", "physical"):
                task_type = {"nutrition": "nutrition", "mental": "mental", "physical": "physical"}[category]
            if task_type == "technique":
                task_type = infer_task_type_from_text(
                    str(r["title"] or ""),
                    str(r["description"] or ""),
                    str(category or ""),
                )
            out.append(
                {
                    "id": r["id"],
                    "task_date": r["task_date"],
                    "category": category,
                    "task_type": task_type,
                    "duration_min": int(r["duration_min"] or 30)
                    if "duration_min" in r.keys()
                    else 30,
                    "title": r["title"],
                    "description": r["description"],
                    "status": r["status"],
                    "postponed_to_date": r["postponed_to_date"],
                    "match_id": r["match_id"],
                }
            )
        return out

    return {
        "session_id": session_id,
        "profile": profile_out,
        "match": match_out,
        "program_today": serialize_tasks(tasks_today),
        "program_until_match": serialize_tasks(tasks_until),
        "fft_ranking_info_url": "https://www.fft.fr/le-tennis/competitions/classement-et-homologation",
        "ranking_echelons": list(tennis_logic.ECHELONS),
        "ranking_model_note": "Modele FFT renforce: capital de depart + fenetre glissante 12 mois + barème victoire FFT (coef 1). Des regles FFT avancees restent a completer (V-E-2I-5G complet).",
        "context_memory": context_memory,
        "staff_poles": staff_poles,
        "match_history": match_history,
    }


def dashboard_json_for_prompt(session_id: str) -> str:
    return json.dumps(dashboard_payload(session_id), ensure_ascii=False, indent=2)
