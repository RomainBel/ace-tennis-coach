"use client";

import {
  Bot,
  CalendarDays,
  Check,
  Loader2,
  MessageCircle,
  Mic,
  Plus,
  Send,
  ShieldQuestion,
  Trash2,
  TrendingUp,
  Trophy,
  UserCircle2,
  X
} from "lucide-react";
import { buttonPrimary, buttonSecondary } from "@/lib/button-styles";
import { ChatMarkdown } from "@/components/chat-markdown";
import { cn } from "@/lib/cn";
import { TennisBall } from "@/lib/tennis-ball";
import {
  mergeTenupParsedRows,
  sanitizeTenupMatchesForCommit,
  type TenupParsedRow
} from "@/lib/tenup-import-commit";
import { projectedRankingFromPoints, FFT_ECHELONS } from "@/lib/projected-ranking-from-points";
import { signOut, useSession } from "next-auth/react";
import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Libellés de format reconnus comme préréglages (le reste → « Autre (personnalisé) » dans l’éditeur). */
const MATCH_FORMAT_OPTIONS = [
  "Match classique",
  "3 sets à 6 jeux",
  "3 sets a 6 jeux",
  "2 sets à 6 jeux + 3ème set sJD",
  "2 sets à 6 jeux + 3ème set sjd",
  "2 sets a 6 jeux + 3eme set sjd",
  "2 sets à 4 jeux avec pt décisif et JD à 4/4",
  "2 sets a 4 jeux avec pt decisif et jd a 4/4"
] as const;

const SURFACE_SWATCH = {
  clay:
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#c67c38"/></svg>'
    ),
  hard:
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#3b82f6"/></svg>'
    ),
  grass:
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#16a34a"/></svg>'
    )
} as const;

function surfaceChipFromText(surface: string | undefined): { icon: string; label: string } {
  const raw = (surface ?? "").trim();
  const s = raw.toLowerCase();
  if (!raw) return { icon: SURFACE_SWATCH.hard, label: "Surface" };
  if (s.includes("terre") || s.includes("battue") || s.includes("clay") || s.includes("orange"))
    return { icon: SURFACE_SWATCH.clay, label: raw };
  if (s.includes("gazon") || s.includes("grass") || s.includes("herbe"))
    return { icon: SURFACE_SWATCH.grass, label: raw };
  if (
    s.includes("dur") ||
    s.includes("hard") ||
    s.includes("greenset") ||
    s.includes("moquette") ||
    s.includes("synth")
  )
    return { icon: SURFACE_SWATCH.hard, label: raw };
  return { icon: SURFACE_SWATCH.hard, label: raw };
}

function renderMarkdownTaskDescription(md: string): ReactNode {
  const lines = md.split(/\n/);
  const sections: { title: string; body: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.*)$/);
    if (!m) continue;
    const title = m[1].trim();
    const bodyLines: string[] = [];
    i++;
    while (i < lines.length && !/^##\s/.test(lines[i])) {
      bodyLines.push(lines[i]);
      i++;
    }
    i--;
    sections.push({ title, body: bodyLines.join("\n").trim() });
  }
  if (sections.length === 0) {
    return <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">{md}</p>;
  }
  return (
    <div className="space-y-5">
      {sections.map((sec, idx) => (
        <div key={`${sec.title}-${idx}`} className="border-b border-white/[0.06] pb-4 last:border-0 last:pb-0">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-[#ea5806]">{sec.title}</p>
          <TaskDescriptionBody text={sec.body} />
        </div>
      ))}
    </div>
  );
}

function TaskDescriptionBody({ text }: { text: string }) {
  const rawLines = text.split(/\n/).map((l) => l.trim());
  const nonEmpty = rawLines.filter((l) => l.length > 0);
  const allNumbered = nonEmpty.length > 0 && nonEmpty.every((l) => /^\d+\.\s/.test(l));
  if (allNumbered) {
    return (
      <ol className="list-decimal space-y-2.5 pl-5 text-sm leading-relaxed text-neutral-200">
        {nonEmpty.map((l, i) => (
          <li key={i}>{l.replace(/^\d+\.\s*/, "")}</li>
        ))}
      </ol>
    );
  }
  return <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">{text}</p>;
}

type Role = "user" | "assistant";

/** CTA in-chat (ex. validation fiche match) — déclenché par analyse du texte assistant. */
type ChatInlineAction = {
  id: string;
  label: string;
  message: string;
  /** Texte affiché dans le fil utilisateur si différent du message envoyé au coach. */
  userBubbleText?: string;
};

type ChatMessage = { role: Role; text: string; inlineActionsDismissed?: boolean };

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Repère la question de validation « mettre à jour la fiche match avec cette stratégie » (prompt module match prep). */
function inferMatchSheetUpdateCta(text: string): ChatInlineAction[] {
  if (!text.includes("?")) return [];
  const n = stripAccents(text).toLowerCase();
  if (!n.includes("fiche match")) return [];
  if (!n.includes("mettre") || !n.includes("jour")) return [];
  const compact = n.replace(/\s+/g, "").replace(/-/g, "");
  if (!compact.includes("veuxtu") && !compact.includes("souhaitestu")) return [];
  if (!n.includes("strategie")) return [];
  return [
    {
      id: "confirm_match_sheet_strategy",
      label: "Mettre à jour la fiche",
      message: "Oui, mets à jour ma fiche match avec cette stratégie."
    }
  ];
}

/** Question « générer le planning jour par jour » (module_planning) — CTA sous la conversation. */
function inferPlanningGenerateComposerCta(text: string): ChatInlineAction | null {
  if (!text.includes("?")) return null;
  const n = stripAccents(text).toLowerCase();
  const compact = n.replace(/\s+/g, "").replace(/-/g, "");
  if (!compact.includes("veuxtu") && !compact.includes("souhaitestu")) return null;

  const wantsGenerate = n.includes("generer") || n.includes("genere");
  const aboutProgram =
    n.includes("planning") ||
    n.includes("programme") ||
    n.includes("seances") ||
    n.includes("seance");
  if (!wantsGenerate || !aboutProgram) return null;

  const dayByDay = n.includes("jour par jour") || n.includes("jour apres jour");
  const detailed = n.includes("precis") || n.includes("precise") || n.includes("detaille");
  const untilMatch =
    n.includes("jusqu'au match") ||
    n.includes("jusquau match") ||
    n.includes("jusqu'au prochain") ||
    n.includes("jusquau prochain");
  if (!dayByDay && !detailed && !untilMatch && !n.includes("planning")) return null;

  return {
    id: "confirm_generate_planning_composer",
    label: "Oui, je veux générer mon planning",
    message:
      "Oui, vas-y : génère ce planning précis jour par jour et mets à jour les tâches de mon programme (replace_program_tasks).",
    userBubbleText: "Oui, je veux générer mon planning"
  };
}

type DashboardMatch = {
  id: number;
  match_datetime: string;
  opponent_id?: number | null;
  catalog_player_id?: number | null;
  opponent_name: string;
  opponent_ranking: string;
  opponent_style?: string;
  opponent_notes: string;
  surface: string;
  match_format: string;
  club_location: string;
  focus_text: string;
  status: string;
  ui_state: "no_match" | "upcoming" | "past";
  days_remaining: number | null;
  result_score: string;
  result_feeling: string;
  outcome: string;
  fft_points_applied: number;
  points_if_win?: number | null;
  stakes_label?: string;
};

type ProgramTask = {
  id: number;
  task_date: string;
  category: string;
  task_type: "technique" | "physical" | "mental" | "nutrition" | "recovery";
  duration_min: number;
  title: string;
  description: string;
  status: string;
  postponed_to_date: string | null;
  match_id?: number | null;
};

type PalmaresEntry = {
  id: number;
  match_date: string;
  catalog_player_id?: number | null;
  opponent_name?: string;
  opponent_ranking: string;
  won: boolean;
  notes: string;
  points_delta: number;
  created_at: string;
};

type CatalogPlayer = {
  id: number;
  display_name: string;
  current_rank: string;
  play_style: string;
  public_notes: string;
};

type Dashboard = {
  session_id: string;
  profile: {
    display_name: string;
    avatar_data_url?: string;
    current_ranking: string;
    target_ranking: string;
    current_points: number | null;
    target_points: number | null;
    points_to_target: number | null;
    target_threshold_points: number | null;
    preferred_surface: string;
    weekly_availability: string;
    injury_notes: string;
    playing_style: string;
    win_streak: number;
    goal_progress_ratio: number;
    projected_ranking_from_points: string;
    points_to_next_echelon: number | null;
    next_echelon_label: string | null;
    fft_monthly_update_hint: string;
    onboarding_completed?: boolean;
    profile_created_at?: string | null;
    fft_points_summary_12m?: {
      window_months: number;
      matches_count: number;
      wins_count: number;
      losses_count: number;
      win_rate_pct?: number;
      best_win?: {
        points: number;
        opponent_ranking: string;
        opponent_name: string;
        match_date: string;
      } | null;
    };
  };
  match: DashboardMatch | null;
  program_today: ProgramTask[];
  program_until_match: ProgramTask[];
  fft_ranking_info_url: string;
  ranking_echelons: string[];
  context_memory?: Record<string, unknown>;
  staff_poles?: Record<string, boolean>;
  match_history?: {
    match_id: number;
    match_date: string;
    outcome: string;
    score: string;
    opponent_name: string;
    sensations: string;
  }[];
};

const CHAT_WELCOME: ChatMessage = {
  role: "assistant",
  text: "Je suis Ace. Ton design est en place — parlons de ton prochain match."
};

/** API Web Speech (Chrome, Edge, Safari récents) — dictée avec résultats partiels. */
type AceSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  abort(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onresult:
    | ((
        ev: {
          resultIndex: number;
          results: {
            length: number;
            [i: number]: { isFinal: boolean; 0: { transcript: string } };
          };
        }
      ) => void)
    | null;
};

function getSpeechRecognitionCtor(): (new () => AceSpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => AceSpeechRecognition;
    webkitSpeechRecognition?: new () => AceSpeechRecognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function pickMediaRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

const CATEGORY_FALLBACK: Record<string, string> = {
  nutrition: "Nutrition",
  physical: "Physique",
  tennis: "Tennis",
  mental: "Mental"
};

async function fireMicroConfetti(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const confetti = (await import("canvas-confetti")).default;
    confetti({
      particleCount: 40,
      spread: 50,
      origin: { y: 0.75 },
      colors: ["#e67e22", "#22c55e", "#fbbf24", "#3b82f6"]
    });
  } catch {
    /* ignore */
  }
}

const TASK_TYPE_LABEL: Record<string, string> = {
  technique: "Technique",
  physical: "Physique",
  mental: "Mental",
  nutrition: "Nutrition",
  recovery: "Récupération"
};

const TASK_FEEDBACK_OPTIONS: { id: string; label: string; emoji: string }[] = [
  { id: "great", label: "Très utile", emoji: "🔥" },
  { id: "ok", label: "Utile", emoji: "👍" },
  { id: "mixed", label: "Mitigé", emoji: "😐" },
  { id: "weak", label: "Peu utile", emoji: "👎" }
];

function taskFeedbackPhrase(id: string): string {
  const o = TASK_FEEDBACK_OPTIONS.find((x) => x.id === id);
  return o ? `${o.emoji} ${o.label}` : id;
}

/** Courbe SVG du cumul des points palmarès (fin de chaque mois). */
function RankingCumulativeChart({ values }: { values: number[] }) {
  const n = values.length;
  const w = 400;
  const h = 120;
  const padX = 28;
  const padY = 12;
  const innerW = w - padX - 10;
  const innerH = h - padY * 2;
  const maxV = Math.max(...values, 1);
  const minV = 0;
  if (n < 1) return null;
  const step = n <= 1 ? 0 : innerW / Math.max(1, n - 1);
  const pts = values.map((v, i) => {
    const x = padX + i * step;
    const t = maxV === minV ? 0.5 : (v - minV) / (maxV - minV);
    const y = padY + innerH * (1 - t);
    return { x, y, v };
  });
  const pointsAttr = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return (
    <div className="mb-4 rounded-xl border border-white/10 bg-black/30 p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        Progression des points (cumul palmarès, fin de mois)
      </p>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-28 w-full text-[#58d68d]"
        role="img"
        aria-label="Courbe de cumul des points"
      >
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={pointsAttr}
        />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="4" fill="#1e1e1e" stroke="currentColor" strokeWidth="2" />
        ))}
      </svg>
      {n < 2 ? (
        <p className="mt-1 text-[11px] text-neutral-500">
          Plusieurs mois suffisent pour lire une vraie tendance.
        </p>
      ) : null}
    </div>
  );
}

/** Sélecteur d'échelon FFT : liste complète (le couple input + datalist est filtré par le navigateur). */
function EchelonSelect({
  value,
  onChange,
  placeholder,
  className
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  className?: string;
}) {
  const cur = value.trim();
  const isNc = cur.toUpperCase() === "NC";
  const inFft = FFT_ECHELONS.includes(cur);
  const selectValue = cur === "" ? "" : isNc ? "NC" : inFft ? cur : `__extra__:${cur}`;

  return (
    <select
      className={cn(
        "mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white outline-none focus:ring-1 focus:ring-[#e67e22]",
        className
      )}
      value={selectValue}
      onChange={(e) => {
        const v = e.target.value;
        if (v.startsWith("__extra__:")) return;
        onChange(v);
      }}
    >
      <option value="">{placeholder}</option>
      <option value="NC">NC (non classé)</option>
      {FFT_ECHELONS.map((e) => (
        <option key={e} value={e}>
          {e}
        </option>
      ))}
      {cur !== "" && !isNc && !inFft ? (
        <option value={`__extra__:${cur}`} disabled>
          {cur} (valeur actuelle — non reconnue, choisis un échelon ci-dessus)
        </option>
      ) : null}
    </select>
  );
}

function taskTypeStyles(task: ProgramTask): {
  border: string;
  dot: string;
  label: string;
} {
  const tt = task.task_type ?? "technique";
  switch (tt) {
    case "physical":
      return {
        border: "border-l-emerald-500",
        dot: "bg-emerald-500",
        label: "text-emerald-300"
      };
    case "mental":
      return { border: "border-l-violet-500", dot: "bg-violet-500", label: "text-violet-300" };
    case "nutrition":
      return { border: "border-l-amber-500", dot: "bg-amber-500", label: "text-amber-300" };
    case "recovery":
      return { border: "border-l-sky-500", dot: "bg-sky-500", label: "text-sky-300" };
    default:
      return { border: "border-l-[#e67e22]", dot: "bg-[#e67e22]", label: "text-[#e67e22]" };
  }
}

function taskRowLabel(task: ProgramTask): string {
  const t = task.title.toLowerCase();
  if (task.category === "nutrition") {
    if (t.includes("déjeun") || t.includes("dejeun")) return "Déjeuner";
    if (t.includes("dîner") || t.includes("diner")) return "Dîner";
  }
  return CATEGORY_FALLBACK[task.category] ?? task.category;
}

/** Texte de la section ## Objectif uniquement (aperçu liste). */
function taskObjectivePreview(description: string, maxChars = 220): string {
  const raw = (description || "").trim();
  if (!raw) return "";

  const lines = raw.split("\n");
  let inObjective = false;
  const bodyLines: string[] = [];
  const isObjectiveHeading = (l: string) => /^##\s*objectif\b/i.test(l.trim());
  const isSectionHeading = (l: string) => /^##\s+/.test(l.trim());

  for (const line of lines) {
    if (isObjectiveHeading(line)) {
      inObjective = true;
      continue;
    }
    if (inObjective && isSectionHeading(line) && !isObjectiveHeading(line)) {
      break;
    }
    if (inObjective) bodyLines.push(line);
  }

  let text = bodyLines.join(" ").replace(/\s+/g, " ").trim();

  if (!text) {
    const compact = raw.replace(/\s+/g, " ").trim();
    const inline = compact.match(
      /\bobjectif\s*:\s*(.+?)(?=\s*\bprotocole\s*:|(?:\s*le tip de ace\s*:)|$)/i
    );
    if (inline?.[1]) text = inline[1].trim();
  }

  if (!text) {
    const prelude = raw.split(/^##\s+/m)[0]?.trim() ?? "";
    if (prelude) text = prelude.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  }

  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}…`;
}

function matchPillParts(
  days: number | null,
  iso: string
): { bold: string; dateLine: string } {
  try {
    const d = new Date(iso);
    const day = d.toLocaleDateString("fr-FR", {
      weekday: "short",
      day: "numeric",
      month: "short"
    });
    if (days != null && days >= 0) {
      const label =
        days === 0 ? "Aujourd'hui" : days === 1 ? "Demain" : `Dans ${days} jours`;
      return {
        bold: label,
        dateLine: day.charAt(0).toUpperCase() + day.slice(1)
      };
    }
    return { bold: day.charAt(0).toUpperCase() + day.slice(1), dateLine: "" };
  } catch {
    return { bold: iso, dateLine: "" };
  }
}

function surfaceKey(value: string): string {
  const v = (value || "").trim().toLowerCase();
  if (v.includes("terre")) return "terre battue";
  if (v.includes("gazon")) return "gazon";
  if (v.includes("moquette")) return "moquette";
  if (v.includes("multi")) return "multisport";
  if (v.includes("dur")) return "dur";
  return "";
}

function countdownToMatch(iso: string): string {
  const ts = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ts)) return "--:--:--";
  if (ts <= 0) return "00:00:00";
  const h = Math.floor(ts / (3600 * 1000));
  const m = Math.floor((ts % (3600 * 1000)) / (60 * 1000));
  const s = Math.floor((ts % (60 * 1000)) / 1000);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function daysBetweenIso(a: string, b: string): number {
  const da = new Date(`${a}T12:00:00`).getTime();
  const db = new Date(`${b}T12:00:00`).getTime();
  return Math.round((db - da) / 86400000);
}

function matchDateLong(iso: string): string {
  const raw = (iso || "").trim();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "Date inconnue - À définir";
  const dayMonth = d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  const capitalizedDayMonth = dayMonth.charAt(0).toUpperCase() + dayMonth.slice(1);
  const hasExplicitTime = raw.includes("T");
  if (!hasExplicitTime) return `${capitalizedDayMonth} - À définir`;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (hh === "00" && mm === "00") return `${capitalizedDayMonth} - À définir`;
  const hourLabel = mm === "00" ? `${hh}h` : `${hh}h${mm}`;
  return `${capitalizedDayMonth} - ${hourLabel}`;
}

function splitGamePlanKeys(focusText: string): string[] {
  return (focusText || "")
    .split(/\n|;|•|\. /g)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function defaultCommandments(surface: string, targetRanking: string): string[] {
  const s = surfaceKey(surface);
  const base = [
    "Sois discipliné sur tes routines entre les points.",
    "Construis chaque point avec patience avant d'accélérer.",
    targetRanking
      ? `Joue chaque jeu comme une étape vers ${targetRanking}.`
      : "Reste focalisé sur l’intention tactique du point."
  ];
  if (s === "terre battue") return ["Glisse sur les appuis avant chaque frappe.", ...base];
  if (s === "gazon") return ["Prends la balle tôt et reste bas sur les jambes.", ...base];
  if (s === "dur") return ["Ancre ton premier pas après le service.", ...base];
  return base;
}

function taskCategoryTextClass(task: ProgramTask): string {
  const label = taskRowLabel(task);
  if (task.category === "mental") return "text-[#e8c547]";
  if (label === "Déjeuner" || label === "Dîner") return "text-[#7dd3fc]";
  if (task.category === "nutrition") return "text-[#7dd3fc]";
  if (task.category === "physical") return "text-[#a78bfa]";
  if (task.category === "tennis") return "text-[#58d68d]";
  return "text-neutral-400";
}

function GoalRing({
  label,
  ratio,
  size = 100
}: {
  label: string;
  ratio: number;
  size?: number;
}) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(1, Math.max(0, ratio)));
  return (
    <div className="relative flex flex-col items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#e67e22"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center px-1">
        <span className="text-center text-lg font-bold leading-none tracking-tight text-white">
          {label}
        </span>
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const [sessionId, setSessionId] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([CHAT_WELCOME]);
  const [input, setInput] = useState("");
  const [intent, setIntent] = useState<string | null>(null);
  const [chatContextType, setChatContextType] = useState<
    "general" | "debrief" | "planning" | "program_adjustment"
  >("general");
  const [chatModuleTag, setChatModuleTag] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [onboardingTour, setOnboardingTour] = useState(false);
  const [onboardingAcePopup, setOnboardingAcePopup] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const speechRecognitionRef = useRef<AceSpeechRecognition | null>(null);
  const chatDictationActiveRef = useRef(false);
  const chatDictationStartedRef = useRef(false);
  const speechRestartTimeoutRef = useRef<number | null>(null);
  const liveProbeTimerRef = useRef<number | null>(null);
  const dictationModeRef = useRef<"none" | "live" | "record">("none");
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<BlobPart[]>([]);
  const dictationDiscardTranscribeRef = useRef(false);
  const voiceBaseRef = useRef("");
  const voiceFinalRef = useRef("");
  const [chatDictationActive, setChatDictationActive] = useState(false);
  const [chatDictationTranscribing, setChatDictationTranscribing] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showPalmares, setShowPalmares] = useState(false);
  const [showStaff, setShowStaff] = useState(false);
  const [showProgramFull, setShowProgramFull] = useState(false);
  const [showSimulate, setShowSimulate] = useState(false);
  const [showMatchTimingEdit, setShowMatchTimingEdit] = useState(false);
  const [matchTimingSaveError, setMatchTimingSaveError] = useState<string | null>(null);
  const [matchTimingSaving, setMatchTimingSaving] = useState(false);
  const [showCreateMatchModal, setShowCreateMatchModal] = useState(false);
  const [createMatchError, setCreateMatchError] = useState<string | null>(null);
  const [showMatchKeysEdit, setShowMatchKeysEdit] = useState(false);
  const [showScoutModal, setShowScoutModal] = useState(false);
  const [scoutSaveError, setScoutSaveError] = useState<string | null>(null);
  const [scoutSaving, setScoutSaving] = useState(false);
  const [scoutQuery, setScoutQuery] = useState("");
  const [scoutResults, setScoutResults] = useState<CatalogPlayer[]>([]);
  const [showDebriefModal, setShowDebriefModal] = useState(false);
  const [matchTimingValue, setMatchTimingValue] = useState("");
  const [debriefOutcome, setDebriefOutcome] = useState<"won" | "lost">("won");
  const [debriefScore, setDebriefScore] = useState("");
  const [debriefOpponentName, setDebriefOpponentName] = useState("");
  const [debriefOpponentRanking, setDebriefOpponentRanking] = useState("");
  const [debriefOpponentAnonymous, setDebriefOpponentAnonymous] = useState(false);
  const [debriefProgramHelpful, setDebriefProgramHelpful] = useState<"" | "yes" | "somewhat" | "no">("");
  const [debriefProgramNotes, setDebriefProgramNotes] = useState("");
  const [showAnonConfirmToast, setShowAnonConfirmToast] = useState(false);
  const [matchMetaForm, setMatchMetaForm] = useState({
    surface: "",
    match_format: "",
    club_location: "",
    custom_match_format: ""
  });
  const [scoutForm, setScoutForm] = useState({
    opponent_id: null as number | null,
    opponent_name: "",
    opponent_ranking: "",
    opponent_style: "",
    opponent_notes: ""
  });
  const [createMatchForm, setCreateMatchForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    time: "18:00",
    surface: "",
    match_format: "Match classique",
    club_location: "",
    opponent_name: "",
    opponent_ranking: "",
    opponent_style: "",
    opponent_notes: ""
  });
  const [matchKeysDraft, setMatchKeysDraft] = useState("");
  const [taskEdit, setTaskEdit] = useState<ProgramTask | null>(null);
  const [taskEditDate, setTaskEditDate] = useState("");
  const [taskDetail, setTaskDetail] = useState<ProgramTask | null>(null);
  /** `feedback` = case à cocher (ressenti seul) ; `full` = clic sur la carte (détail complet). */
  const [taskModalView, setTaskModalView] = useState<"full" | "feedback">("full");
  /** Ressenti / valider / reporter : uniquement depuis « Programme du jour » (tâches d'aujourd'hui). */
  const [taskDetailAllowActions, setTaskDetailAllowActions] = useState(false);
  const [taskFeedbackChoice, setTaskFeedbackChoice] = useState<string | null>(null);
  const [taskFeedbackNote, setTaskFeedbackNote] = useState("");
  const [taskFeedbackLoading, setTaskFeedbackLoading] = useState(false);
  const todayIso = new Date().toISOString().slice(0, 10);
  const [showAddTaskModal, setShowAddTaskModal] = useState(false);
  const [addTaskStep, setAddTaskStep] = useState<"intent" | "pick">("intent");
  const [addTaskIntent, setAddTaskIntent] = useState("");
  const [addTaskSuggestions, setAddTaskSuggestions] = useState<
    { title: string; description: string; task_type: string; duration_min: number }[]
  >([]);
  const [addTaskLoading, setAddTaskLoading] = useState(false);
  const [addTaskError, setAddTaskError] = useState<string | null>(null);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [palmaresEntries, setPalmaresEntries] = useState<PalmaresEntry[]>([]);
  const [palmaresLoading, setPalmaresLoading] = useState(false);
  const [palmaresQuery, setPalmaresQuery] = useState("");
  const [palmaresResults, setPalmaresResults] = useState<CatalogPlayer[]>([]);
  const [palmaresEditingId, setPalmaresEditingId] = useState<number | null>(null);
  const [showPalmaresForm, setShowPalmaresForm] = useState(false);
  const [palmForm, setPalmForm] = useState({
    match_date: "",
    opponent_id: null as number | null,
    opponent_name: "",
    opponent_ranking: "",
    won: true,
    notes: ""
  });

  const [hypoRows, setHypoRows] = useState<{ opponent_ranking: string; won: boolean }[]>([
    { opponent_ranking: "30/2", won: true }
  ]);
  const [showTenupImport, setShowTenupImport] = useState(false);
  const [tenupFiles, setTenupFiles] = useState<string[]>([]);
  const [tenupRows, setTenupRows] = useState<TenupParsedRow[]>([]);
  const [tenupCurrentRanking, setTenupCurrentRanking] = useState("");
  const [tenupOriginRanking, setTenupOriginRanking] = useState("");
  const [tenupTargetRanking, setTenupTargetRanking] = useState("");
  const [tenupGender, setTenupGender] = useState<"M" | "F">("M");
  const [tenupParsing, setTenupParsing] = useState(false);
  const [tenupCommitting, setTenupCommitting] = useState(false);
  const [tenupImportStep, setTenupImportStep] = useState<1 | 2>(1);
  const [tenupFileNames, setTenupFileNames] = useState<string[]>([]);
  const [tenupPostParseNotice, setTenupPostParseNotice] = useState(false);
  const tenupAppendNextParseRef = useRef(false);
  const tenupFileInputRef = useRef<HTMLInputElement>(null);
  const [simResult, setSimResult] = useState<Record<string, unknown> | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [deleteAccountPassword, setDeleteAccountPassword] = useState("");
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);
  const [deleteAccountLoading, setDeleteAccountLoading] = useState(false);
  const [profileDeleteExpanded, setProfileDeleteExpanded] = useState(false);
  const [showRankingHistoryModal, setShowRankingHistoryModal] = useState(false);
  const [rankingHistoryPortalReady, setRankingHistoryPortalReady] = useState(false);
  const [selectedProgramDay, setSelectedProgramDay] = useState<string>("");
  const [staffPoles, setStaffPoles] = useState<Record<string, boolean>>({
    technique: true,
    physical: true,
    mental: true,
    nutrition: true,
    recovery: true
  });

  const [profileForm, setProfileForm] = useState({
    display_name: "",
    avatar_data_url: "",
    current_ranking: "",
    target_ranking: "",
    preferred_surface: "",
    weekly_availability: "",
    injury_notes: "",
    playing_style: ""
  });

  const searchPlayersCatalog = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) return [] as CatalogPlayer[];
    const res = await fetch(`${API}/players-catalog?q=${encodeURIComponent(q)}&limit=8`);
    if (!res.ok) return [] as CatalogPlayer[];
    const data = (await res.json()) as { rows?: CatalogPlayer[] };
    return data.rows ?? [];
  }, []);

  const normalizeDashboard = useCallback((raw: Dashboard): Dashboard => {
    return {
      ...raw,
      profile: {
        ...raw.profile,
        onboarding_completed: raw.profile?.onboarding_completed ?? true
      },
      match: raw.match
        ? {
            ...raw.match,
            surface: raw.match.surface ?? "",
            match_format: raw.match.match_format ?? "",
            club_location: raw.match.club_location ?? "",
            opponent_notes: raw.match.opponent_notes ?? "",
            points_if_win: raw.match.points_if_win ?? null,
            stakes_label: raw.match.stakes_label ?? ""
          }
        : null,
      context_memory: raw.context_memory ?? {},
      staff_poles: raw.staff_poles ?? {
        technique: true,
        physical: true,
        mental: true,
        nutrition: true,
        recovery: true
      },
      match_history: raw.match_history ?? [],
      program_today: (raw.program_today ?? []).map((t) => ({
        ...t,
        task_type: (t.task_type ?? "technique") as ProgramTask["task_type"],
        duration_min: t.duration_min ?? 30
      })),
      program_until_match: (raw.program_until_match ?? []).map((t) => ({
        ...t,
        task_type: (t.task_type ?? "technique") as ProgramTask["task_type"],
        duration_min: t.duration_min ?? 30
      }))
    };
  }, []);

  const loadDashboard = useCallback(async (sid: string) => {
    const res = await fetch(`${API}/dashboard/${sid}`);
    if (!res.ok) return;
    const data = normalizeDashboard((await res.json()) as Dashboard);
    setDashboard(data);
    setProfileForm({
      display_name: data.profile.display_name,
      avatar_data_url: data.profile.avatar_data_url ?? "",
      current_ranking: data.profile.current_ranking,
      target_ranking: data.profile.target_ranking,
      preferred_surface: data.profile.preferred_surface,
      weekly_availability: data.profile.weekly_availability,
      injury_notes: data.profile.injury_notes,
      playing_style: data.profile.playing_style ?? ""
    });
    if (data.staff_poles) setStaffPoles(data.staff_poles);
  }, [normalizeDashboard]);

  useEffect(() => {
    if (sessionStatus === "loading") return;
    const uid = session?.user?.id;
    if (!uid) {
      setIsBootstrapping(false);
      return;
    }
    window.localStorage.setItem("ace_session_id", uid);
    setSessionId(uid);

    const boot = async () => {
      try {
        const [dashRes, chatRes] = await Promise.all([
          fetch(`${API}/dashboard/${uid}`),
          fetch(`${API}/chat/session/${uid}`)
        ]);
        if (dashRes.ok) {
          const data = normalizeDashboard((await dashRes.json()) as Dashboard);
          setDashboard(data);
          setProfileForm({
            display_name: data.profile.display_name,
            avatar_data_url: data.profile.avatar_data_url ?? "",
            current_ranking: data.profile.current_ranking,
            target_ranking: data.profile.target_ranking,
            preferred_surface: data.profile.preferred_surface,
            weekly_availability: data.profile.weekly_availability,
            injury_notes: data.profile.injury_notes,
            playing_style: data.profile.playing_style ?? ""
          });
          if (data.staff_poles) setStaffPoles(data.staff_poles);
        }
        if (chatRes.ok) {
          const chatData = (await chatRes.json()) as {
            messages?: { role: Role; content: string }[];
          };
          if (chatData.messages && chatData.messages.length > 0) {
            setMessages(
              chatData.messages.map((m) => ({ role: m.role, text: m.content }))
            );
          }
        }
      } finally {
        setIsBootstrapping(false);
      }
    };
    void boot();
  }, [normalizeDashboard, session?.user?.id, sessionStatus]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("onboarding") === "1") {
      setOnboardingTour(true);
      setOnboardingAcePopup(true);
    }
  }, []);

  useEffect(() => {
    if (isBootstrapping || sessionStatus !== "authenticated") return;
    if (dashboard?.profile?.onboarding_completed === false) {
      router.replace("/onboarding");
    }
  }, [
    isBootstrapping,
    sessionStatus,
    dashboard?.profile?.onboarding_completed,
    router
  ]);

  useEffect(() => {
    if (!chatExpanded) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, chatExpanded, isLoading]);

  const CHAT_INPUT_MAX_LINES = 5;
  useLayoutEffect(() => {
    const el = chatTextareaRef.current;
    if (!el || !chatExpanded) return;
    el.style.height = "0px";
    const lh = Number.parseFloat(getComputedStyle(el).lineHeight);
    const linePx = Number.isFinite(lh) && lh > 0 ? lh : 20;
    const maxH = linePx * CHAT_INPUT_MAX_LINES;
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  }, [input, chatExpanded]);

  const hasInput = input.trim().length > 0;
  const canSend = useMemo(
    () => hasInput && !isLoading && !isBootstrapping && !!sessionId,
    [hasInput, isLoading, isBootstrapping, sessionId]
  );

  /** Suggestion au-dessus du clavier : confirmation génération planning (module_planning). */
  const planningComposerCta = useMemo(() => {
    if (isLoading || isBootstrapping) return null;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return null;
    return inferPlanningGenerateComposerCta(last.text);
  }, [messages, isLoading, isBootstrapping]);

  const stopChatDictation = useCallback((opts?: { discardTranscription?: boolean }) => {
    const discardTranscription = opts?.discardTranscription ?? true;
    dictationDiscardTranscribeRef.current = discardTranscription;

    if (liveProbeTimerRef.current) {
      clearTimeout(liveProbeTimerRef.current);
      liveProbeTimerRef.current = null;
    }
    if (speechRestartTimeoutRef.current) {
      clearTimeout(speechRestartTimeoutRef.current);
      speechRestartTimeoutRef.current = null;
    }

    const mr = mediaRecorderRef.current;
    const wasRecording = mr && mr.state === "recording";
    if (wasRecording) {
      try {
        mr.stop();
      } catch {
        /* */
      }
    } else {
      mediaRecorderRef.current = null;
      const stream = mediaStreamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
    }

    const rec = speechRecognitionRef.current;
    speechRecognitionRef.current = null;
    if (rec) {
      try {
        rec.abort();
      } catch {
        /* déjà arrêté */
      }
    }

    chatDictationStartedRef.current = false;
    chatDictationActiveRef.current = false;
    dictationModeRef.current = "none";
    setChatDictationActive(false);
    if (discardTranscription || !wasRecording) {
      setChatDictationTranscribing(false);
    }
  }, []);

  const startChatDictation = useCallback(async () => {
    if (typeof window.isSecureContext !== "undefined" && !window.isSecureContext) {
      window.alert("La dictée vocale nécessite une connexion sécurisée (HTTPS ou localhost).");
      return;
    }

    voiceBaseRef.current = input;
    voiceFinalRef.current = "";
    dictationDiscardTranscribeRef.current = false;
    chatDictationStartedRef.current = false;
    chatDictationActiveRef.current = true;
    dictationModeRef.current = "none";
    setChatDictationActive(true);
    setChatExpanded(true);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      chatDictationActiveRef.current = false;
      setChatDictationActive(false);
      window.alert(
        "Impossible d'accéder au micro. Autorise l'accès dans les réglages du navigateur pour ce site (icône cadenas à gauche de l'URL)."
      );
      return;
    }
    mediaStreamRef.current = stream;

    const beginMediaRecorder = (mediaStream: MediaStream, hint: string | null) => {
      if (!chatDictationActiveRef.current) {
        mediaStream.getTracks().forEach((t) => t.stop());
        if (mediaStreamRef.current === mediaStream) mediaStreamRef.current = null;
        return;
      }
      dictationModeRef.current = "record";
      mediaStreamRef.current = mediaStream;
      if (hint) setToastMessage(hint);
      mediaChunksRef.current = [];
      const mimePick = pickMediaRecorderMime();
      let mr: MediaRecorder;
      try {
        mr = mimePick
          ? new MediaRecorder(mediaStream, { mimeType: mimePick })
          : new MediaRecorder(mediaStream);
      } catch {
        mediaStream.getTracks().forEach((t) => t.stop());
        if (mediaStreamRef.current === mediaStream) mediaStreamRef.current = null;
        chatDictationActiveRef.current = false;
        setChatDictationActive(false);
        window.alert("Enregistrement audio indisponible sur ce navigateur.");
        return;
      }
      const finalMime = mr.mimeType || mimePick || "audio/webm";
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) mediaChunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        mediaRecorderRef.current = null;
        mediaStream.getTracks().forEach((t) => t.stop());
        if (mediaStreamRef.current === mediaStream) mediaStreamRef.current = null;
        const discard = dictationDiscardTranscribeRef.current;
        dictationDiscardTranscribeRef.current = false;
        if (discard) {
          dictationModeRef.current = "none";
          chatDictationActiveRef.current = false;
          setChatDictationActive(false);
          return;
        }
        const blob = new Blob(mediaChunksRef.current, { type: finalMime });
        mediaChunksRef.current = [];
        if (blob.size < 80) {
          dictationModeRef.current = "none";
          chatDictationActiveRef.current = false;
          setChatDictationActive(false);
          setToastMessage("Message trop court pour être transcrit.");
          return;
        }
        setChatDictationTranscribing(true);
        void (async () => {
          try {
            const form = new FormData();
            const ext = finalMime.includes("mp4") ? "m4a" : "webm";
            form.append("audio", blob, `dictation.${ext}`);
            form.append("language", "fr");
            const res = await fetch(`${API}/speech-to-text`, { method: "POST", body: form });
            const data = (await res.json()) as { text?: string; detail?: string };
            if (!res.ok) {
              throw new Error(typeof data.detail === "string" ? data.detail : "Échec de la transcription.");
            }
            const text = (data.text ?? "").trim();
            if (text) {
              setInput((prev) => (prev.trim() === "" ? text : `${prev.trimEnd()} ${text}`));
            } else {
              setToastMessage("Aucun texte reconnu — réessaie en parlant un peu plus fort.");
            }
          } catch (err) {
            window.alert(
              err instanceof Error
                ? err.message
                : "Transcription impossible. Vérifie que le backend a bien OPENAI_API_KEY et réessaie."
            );
          } finally {
            setChatDictationTranscribing(false);
            dictationModeRef.current = "none";
            chatDictationActiveRef.current = false;
            setChatDictationActive(false);
          }
        })();
      };
      try {
        mr.start(250);
      } catch {
        mediaStream.getTracks().forEach((t) => t.stop());
        if (mediaStreamRef.current === mediaStream) mediaStreamRef.current = null;
        chatDictationActiveRef.current = false;
        setChatDictationActive(false);
        window.alert("Impossible de démarrer l'enregistrement.");
      }
    };

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      beginMediaRecorder(
        stream,
        "Dictée en direct indisponible ici — enregistre ton message, puis reclique sur le micro pour transcrire."
      );
      return;
    }

    const speech = new Ctor();
    speechRecognitionRef.current = speech;
    speech.continuous = true;
    speech.interimResults = true;
    speech.lang = "fr-FR";
    dictationModeRef.current = "live";

    let liveHasStarted = false;
    const armLiveFailureProbe = () => {
      if (liveProbeTimerRef.current) {
        clearTimeout(liveProbeTimerRef.current);
        liveProbeTimerRef.current = null;
      }
      liveProbeTimerRef.current = window.setTimeout(() => {
        liveProbeTimerRef.current = null;
        if (liveHasStarted || !chatDictationActiveRef.current) return;
        const s = speechRecognitionRef.current;
        speechRecognitionRef.current = null;
        if (s) {
          try {
            s.abort();
          } catch {
            /* */
          }
        }
        dictationModeRef.current = "none";
        beginMediaRecorder(
          stream,
          "Dictée instantanée indisponible — enregistre ton message, puis reclique sur le micro pour transcrire."
        );
      }, 900);
    };

    const scheduleListenRestart = () => {
      if (speechRestartTimeoutRef.current) {
        clearTimeout(speechRestartTimeoutRef.current);
        speechRestartTimeoutRef.current = null;
      }
      speechRestartTimeoutRef.current = window.setTimeout(() => {
        speechRestartTimeoutRef.current = null;
        if (!chatDictationActiveRef.current || speechRecognitionRef.current !== speech) return;
        try {
          speech.start();
        } catch {
          void (async () => {
            try {
              const s2 = await navigator.mediaDevices.getUserMedia({ audio: true });
              const prev = mediaStreamRef.current;
              if (prev && prev !== s2) prev.getTracks().forEach((t) => t.stop());
              mediaStreamRef.current = s2;
              beginMediaRecorder(s2, null);
            } catch {
              stopChatDictation();
              window.alert("La dictée s'est interrompue. Réessaie ou utilise le clavier.");
            }
          })();
        }
      }, 160);
    };

    speech.onstart = () => {
      liveHasStarted = true;
      chatDictationStartedRef.current = true;
      if (liveProbeTimerRef.current) {
        clearTimeout(liveProbeTimerRef.current);
        liveProbeTimerRef.current = null;
      }
      stream.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    };

    speech.onerror = (ev) => {
      const code = ev.error;
      if (code === "aborted") return;
      if (liveProbeTimerRef.current) {
        clearTimeout(liveProbeTimerRef.current);
        liveProbeTimerRef.current = null;
      }
      if (code === "no-speech") {
        scheduleListenRestart();
        return;
      }
      if (speechRestartTimeoutRef.current) {
        clearTimeout(speechRestartTimeoutRef.current);
        speechRestartTimeoutRef.current = null;
      }

      const switchToRecorder = (msg: string) => {
        speechRecognitionRef.current = null;
        try {
          speech.abort();
        } catch {
          /* */
        }
        void (async () => {
          try {
            const s2 = await navigator.mediaDevices.getUserMedia({ audio: true });
            const prev = mediaStreamRef.current;
            if (prev && prev !== s2) prev.getTracks().forEach((t) => t.stop());
            mediaStreamRef.current = s2;
            beginMediaRecorder(s2, msg);
          } catch {
            stopChatDictation();
            window.alert(
              "Impossible de passer au mode enregistrement. Vérifie le micro ou réessaie plus tard."
            );
          }
        })();
      };

      if (code === "not-allowed") {
        stopChatDictation();
        window.alert("Accès au micro refusé. Autorise le micro dans les réglages du site ou du navigateur.");
        return;
      }
      if (code === "audio-capture") {
        stopChatDictation();
        window.alert("Aucun micro détecté ou micro déjà utilisé par une autre application.");
        return;
      }
      if (code === "network" || code === "service-not-allowed") {
        switchToRecorder(
          "Service de dictée en ligne indisponible — enregistre ton message, puis reclique sur le micro pour transcrire."
        );
        return;
      }
      if (code === "language-not-supported") {
        stopChatDictation();
        window.alert("Langue de dictée non prise en charge sur cet appareil.");
        return;
      }
      if (!liveHasStarted) {
        beginMediaRecorder(stream, null);
        return;
      }
      stopChatDictation();
      window.alert(`Dictée interrompue (code : ${code}). Réessaie ou saisis ton message au clavier.`);
    };

    speech.onresult = (event) => {
      let interim = "";
      let newFinal = voiceFinalRef.current;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) newFinal += r[0].transcript;
        else interim += r[0].transcript;
      }
      voiceFinalRef.current = newFinal;
      setInput(voiceBaseRef.current + newFinal + interim);
    };

    speech.onend = () => {
      if (!chatDictationActiveRef.current || speechRecognitionRef.current !== speech) return;
      if (dictationModeRef.current !== "live") return;
      scheduleListenRestart();
    };

    armLiveFailureProbe();
    try {
      speech.start();
    } catch {
      if (liveProbeTimerRef.current) {
        clearTimeout(liveProbeTimerRef.current);
        liveProbeTimerRef.current = null;
      }
      speechRecognitionRef.current = null;
      dictationModeRef.current = "none";
      beginMediaRecorder(
        stream,
        "Démarrage de la dictée directe impossible — enregistre ton message, puis reclique sur le micro pour transcrire."
      );
    }
  }, [input, stopChatDictation, setToastMessage]);

  const openChat = (
    nextIntent: string | null,
    opts?: {
      contextType?: "general" | "debrief" | "planning" | "program_adjustment";
      moduleTag?: string | null;
    }
  ) => {
    setIntent(nextIntent);
    if (opts) {
      if (opts.contextType !== undefined) setChatContextType(opts.contextType);
      if (opts.moduleTag !== undefined) setChatModuleTag(opts.moduleTag);
    } else {
      setChatContextType("general");
      setChatModuleTag(null);
    }
    setChatExpanded(true);
  };

  async function postChatAssistantReply(userMessageText: string): Promise<string> {
    const body: {
      session_id: string;
      message: string;
      intent?: string;
      context_type: "general" | "debrief" | "planning" | "program_adjustment";
      module_tag?: string;
    } = {
      session_id: sessionId,
      message: userMessageText,
      context_type: chatContextType
    };
    if (intent) body.intent = intent;
    if (chatModuleTag) body.module_tag = chatModuleTag;
    const response = await fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = (await response.json()) as { text?: string; detail?: string };
    if (!response.ok) throw new Error(data.detail ?? "Erreur backend");
    return data.text ?? "Je suis Ace. On continue ?";
  }

  async function executeInlineChatAction(messageIndex: number, action: ChatInlineAction) {
    if (!sessionId || isLoading) return;
    stopChatDictation();
    const visible = (action.userBubbleText ?? action.message).trim();
    const trimmed = action.message.trim();
    setMessages((prev) => {
      const next = [...prev];
      next[messageIndex] = { ...next[messageIndex], inlineActionsDismissed: true };
      next.push({ role: "user", text: visible });
      return next;
    });
    setIsLoading(true);
    setChatExpanded(true);
    try {
      const answer = await postChatAssistantReply(trimmed);
      setMessages((prev) => [...prev, { role: "assistant", text: answer }]);
      setIntent(null);
      if (answer.toLowerCase().includes("dashboard a été mis à jour")) {
        setToastMessage("C'est fait ! Ton dashboard a été mis à jour.");
      }
      await loadDashboard(sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur reseau";
      setMessages((prev) => [...prev, { role: "assistant", text: `Erreur: ${msg}` }]);
    } finally {
      setIsLoading(false);
    }
  }

  async function executePlanningComposerCta(action: ChatInlineAction) {
    if (!sessionId || isLoading) return;
    stopChatDictation();
    const visible = (action.userBubbleText ?? action.message).trim();
    const trimmed = action.message.trim();
    setMessages((prev) => [...prev, { role: "user", text: visible }]);
    setIsLoading(true);
    setChatExpanded(true);
    try {
      const answer = await postChatAssistantReply(trimmed);
      setMessages((prev) => [...prev, { role: "assistant", text: answer }]);
      setIntent(null);
      if (answer.toLowerCase().includes("dashboard a été mis à jour")) {
        setToastMessage("C'est fait ! Ton dashboard a été mis à jour.");
      }
      await loadDashboard(sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur reseau";
      setMessages((prev) => [...prev, { role: "assistant", text: `Erreur: ${msg}` }]);
    } finally {
      setIsLoading(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    stopChatDictation();
    const trimmed = input.trim();
    if (!trimmed || isLoading || !sessionId) return;

    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setInput("");
    setIsLoading(true);
    setChatExpanded(true);

    try {
      const answer = await postChatAssistantReply(trimmed);
      setMessages((prev) => [...prev, { role: "assistant", text: answer }]);
      setIntent(null);
      if (answer.toLowerCase().includes("dashboard a été mis à jour")) {
        setToastMessage("C'est fait ! Ton dashboard a été mis à jour.");
      }
      await loadDashboard(sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur reseau";
      setMessages((prev) => [...prev, { role: "assistant", text: `Erreur: ${msg}` }]);
    } finally {
      setIsLoading(false);
    }
  }

  async function sendQuickChatMessage(
    message: string,
    nextIntent?: string,
    displayUserMessage?: string,
    contextType?: "general" | "debrief" | "planning" | "program_adjustment",
    moduleTag?: string
  ) {
    if (!sessionId || !message.trim() || isLoading) return;
    stopChatDictation();
    const trimmed = message.trim();
    const visible = (displayUserMessage ?? trimmed).trim();
    setMessages((prev) => [...prev, { role: "user", text: visible }]);
    setIsLoading(true);
    setChatExpanded(true);
    try {
      const body: {
        session_id: string;
        message: string;
        intent?: string;
        context_type?: "general" | "debrief" | "planning" | "program_adjustment";
        module_tag?: string;
      } = {
        session_id: sessionId,
        message: trimmed
      };
      if (nextIntent) body.intent = nextIntent;
      if (contextType) body.context_type = contextType;
      if (moduleTag) body.module_tag = moduleTag;
      const response = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = (await response.json()) as { text?: string; detail?: string };
      if (!response.ok) throw new Error(data.detail ?? "Erreur backend");
      if (contextType !== undefined) setChatContextType(contextType);
      if (moduleTag !== undefined) setChatModuleTag(moduleTag);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.text ?? "Merci, je m'adapte." }
      ]);
      if ((data.text ?? "").toLowerCase().includes("dashboard a été mis à jour")) {
        setToastMessage("C'est fait ! Ton dashboard a été mis à jour.");
      }
      await loadDashboard(sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur reseau";
      setMessages((prev) => [...prev, { role: "assistant", text: `Erreur: ${msg}` }]);
    } finally {
      setIsLoading(false);
    }
  }

  const loadPalmares = useCallback(async (sid: string) => {
    setPalmaresLoading(true);
    try {
      const res = await fetch(`${API}/palmares/${sid}`);
      if (!res.ok) return;
      const data = (await res.json()) as { entries: PalmaresEntry[] };
      setPalmaresEntries(data.entries);
    } finally {
      setPalmaresLoading(false);
    }
  }, []);

  async function saveProfile() {
    if (!sessionId) return;
    setProfileSaveError(null);
    try {
      const res = await fetch(`${API}/profile/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: profileForm.display_name,
          avatar_data_url: profileForm.avatar_data_url,
          current_ranking: profileForm.current_ranking,
          target_ranking: profileForm.target_ranking,
          preferred_surface: profileForm.preferred_surface,
          weekly_availability: profileForm.weekly_availability,
          injury_notes: profileForm.injury_notes,
          playing_style: profileForm.playing_style
        })
      });
      const payload = (await res.json().catch(() => ({}))) as {
        detail?: string | unknown[];
      };
      if (!res.ok) {
        const msg = Array.isArray(payload.detail)
          ? "Données invalides"
          : typeof payload.detail === "string"
            ? payload.detail
            : "Erreur lors de l'enregistrement";
        setProfileSaveError(msg);
        return;
      }
      await loadDashboard(sessionId);
      setShowProfile(false);
    } catch {
      setProfileSaveError("Réseau indisponible ou serveur arrêté.");
    }
  }

  async function deleteAccount() {
    if (!session?.user?.id) return;
    setDeleteAccountError(null);
    setDeleteAccountLoading(true);
    try {
      const res = await fetch(`${API}/auth/delete-account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: session.user.id,
          password: deleteAccountPassword
        })
      });
      const payload = (await res.json().catch(() => ({}))) as {
        detail?: string | unknown[];
      };
      if (!res.ok) {
        const msg = Array.isArray(payload.detail)
          ? "Requête invalide"
          : typeof payload.detail === "string"
            ? payload.detail
            : "Suppression impossible";
        setDeleteAccountError(msg);
        return;
      }
      window.localStorage.removeItem("ace_session_id");
      await signOut({ callbackUrl: "/login" });
    } catch {
      setDeleteAccountError("Réseau indisponible ou serveur arrêté.");
    } finally {
      setDeleteAccountLoading(false);
    }
  }

  function onAvatarSelected(file: File | null) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setProfileSaveError("Choisis une image valide (PNG, JPG, WebP...).");
      return;
    }
    const maxBytes = 2 * 1024 * 1024;
    if (file.size > maxBytes) {
      setProfileSaveError("Image trop lourde (max 2 Mo).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      setProfileForm((p) => ({ ...p, avatar_data_url: result }));
      setProfileSaveError(null);
    };
    reader.onerror = () => setProfileSaveError("Impossible de lire cette image.");
    reader.readAsDataURL(file);
  }

  async function submitPalmares(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sessionId) return;
    const todayIso = new Date().toISOString().slice(0, 10);
    if (palmForm.match_date > todayIso) {
      window.alert("Un match joué ne peut pas être daté dans le futur.");
      return;
    }
    const body = {
      match_date: palmForm.match_date,
      catalog_player_id: palmForm.opponent_id,
      opponent_name: palmForm.opponent_name.trim(),
      opponent_ranking: palmForm.opponent_ranking.trim(),
      won: palmForm.won,
      notes: palmForm.notes.trim()
    };
    if (!body.opponent_ranking) return;
    try {
      if (palmaresEditingId != null) {
        const res = await fetch(`${API}/palmares/${sessionId}/${palmaresEditingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) return;
      } else {
        const res = await fetch(`${API}/palmares/${sessionId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) return;
      }
      setPalmaresEditingId(null);
      setPalmForm({
        match_date: new Date().toISOString().slice(0, 10),
        opponent_id: null,
        opponent_name: "",
        opponent_ranking: "",
        won: true,
        notes: ""
      });
      setPalmaresQuery("");
      setPalmaresResults([]);
      setShowPalmaresForm(false);
      await loadPalmares(sessionId);
      await loadDashboard(sessionId);
    } catch {
      /* ignore */
    }
  }

  async function deletePalmaresEntry(id: number) {
    if (!sessionId || !window.confirm("Retirer ce match du palmarès ? Les points seront recalculés."))
      return;
    const res = await fetch(`${API}/palmares/${sessionId}/${id}`, { method: "DELETE" });
    if (!res.ok) return;
    await loadPalmares(sessionId);
    await loadDashboard(sessionId);
    if (palmaresEditingId === id) {
      setPalmaresEditingId(null);
      setPalmForm({
        match_date: new Date().toISOString().slice(0, 10),
        opponent_id: null,
        opponent_name: "",
        opponent_ranking: "",
        won: true,
        notes: ""
      });
    }
  }

  function startEditPalmares(entry: PalmaresEntry) {
    setPalmaresEditingId(entry.id);
    setPalmForm({
      match_date: entry.match_date.slice(0, 10),
      opponent_id: entry.catalog_player_id ?? null,
      opponent_name: entry.opponent_name ?? "",
      opponent_ranking: entry.opponent_ranking,
      won: entry.won,
      notes: entry.notes
    });
    setShowPalmaresForm(true);
  }

  function cancelPalmaresEdit() {
    setPalmaresEditingId(null);
    setPalmForm({
      match_date: new Date().toISOString().slice(0, 10),
      opponent_id: null,
      opponent_name: "",
      opponent_ranking: "",
      won: true,
      notes: ""
    });
    setPalmaresQuery("");
    setPalmaresResults([]);
    setShowPalmaresForm(false);
  }

  function startCreatePalmares() {
    setPalmaresEditingId(null);
    setPalmForm({
      match_date: new Date().toISOString().slice(0, 10),
      opponent_id: null,
      opponent_name: "",
      opponent_ranking: "",
      won: true,
      notes: ""
    });
    setPalmaresQuery("");
    setPalmaresResults([]);
    setShowPalmaresForm(true);
  }

  async function toDataUrl(file: File): Promise<string> {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(new Error("Impossible de lire le fichier"));
      reader.readAsDataURL(file);
    });
  }

  async function onTenupFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    const selected = Array.from(files).slice(0, 12);
    setTenupFileNames(selected.map((f) => f.name));
    const dataUrls = await Promise.all(selected.map((f) => toDataUrl(f)));
    setTenupFiles(dataUrls.filter(Boolean));
  }

  function resetTenupImportFlow() {
    setTenupImportStep(1);
    setTenupFiles([]);
    setTenupFileNames([]);
    setTenupRows([]);
    setTenupPostParseNotice(false);
    tenupAppendNextParseRef.current = false;
    if (tenupFileInputRef.current) tenupFileInputRef.current.value = "";
  }

  async function parseTenupCaptures() {
    if (!sessionId || tenupFiles.length === 0) return;
    setTenupParsing(true);
    try {
      const res = await fetch(`${API}/tenup-import/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          current_ranking: tenupCurrentRanking.trim(),
          origin_ranking: tenupOriginRanking.trim(),
          target_ranking: tenupTargetRanking.trim(),
          gender: tenupGender,
          images_data_urls: tenupFiles
        })
      });
      const data = (await res.json()) as { rows?: TenupParsedRow[]; detected_current_ranking?: string; detail?: string };
      if (!res.ok) throw new Error(data.detail ?? "Erreur import captures");
      const newRows = Array.isArray(data.rows) ? data.rows : [];
      const append = tenupAppendNextParseRef.current;
      tenupAppendNextParseRef.current = false;

      if (!append && newRows.length === 0) {
        window.alert("Aucun match détecté sur ces captures. Réessaie avec d'autres images.");
        return;
      }
      if (append && newRows.length === 0) {
        window.alert("Aucun nouveau match détecté sur ces captures.");
        setTenupImportStep(2);
        return;
      }

      setTenupRows((prev) => (append ? mergeTenupParsedRows(prev, newRows) : newRows));
      if (!tenupCurrentRanking.trim() && data.detected_current_ranking) {
        setTenupCurrentRanking(data.detected_current_ranking);
      }

      setTenupFiles([]);
      setTenupFileNames([]);
      if (tenupFileInputRef.current) tenupFileInputRef.current.value = "";
      setTenupPostParseNotice(true);
      window.setTimeout(() => {
        setTenupPostParseNotice(false);
        setTenupImportStep(2);
      }, 1800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur import captures";
      window.alert(msg);
    } finally {
      setTenupParsing(false);
    }
  }

  async function commitTenupImport() {
    if (!sessionId || tenupRows.length === 0) return;
    setTenupCommitting(true);
    try {
      const res = await fetch(`${API}/tenup-import/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          current_ranking: tenupCurrentRanking.trim(),
          origin_ranking: tenupOriginRanking.trim() || tenupCurrentRanking.trim(),
          target_ranking: tenupTargetRanking.trim(),
          gender: tenupGender,
          matches: sanitizeTenupMatchesForCommit(tenupRows)
        })
      });
      const data = (await res.json()) as {
        imported?: number;
        detail?: string;
        entries?: PalmaresEntry[];
      };
      if (!res.ok) throw new Error(data.detail ?? "Erreur import final");
      const n = data.imported ?? 0;
      if (n === 0 && tenupRows.length > 0) {
        window.alert(
          "Aucune ligne n’a été enregistrée. Vérifie que chaque match a un classement adversaire reconnu (ex. 30/2)."
        );
        return;
      }
      if (Array.isArray(data.entries)) {
        setPalmaresEntries(data.entries);
      } else {
        await loadPalmares(sessionId);
      }
      await loadDashboard(sessionId);
      setShowTenupImport(false);
      resetTenupImportFlow();
      window.alert(`Import terminé: ${n || tenupRows.length} matchs ajoutés.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur import final";
      window.alert(msg);
    } finally {
      setTenupCommitting(false);
    }
  }

  function updateTenupRow(index: number, patch: Partial<TenupParsedRow>) {
    setTenupRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeTenupRow(index: number) {
    setTenupRows((prev) => prev.filter((_, i) => i !== index));
  }

  useEffect(() => {
    if (!sessionId) return;
    void loadPalmares(sessionId);
  }, [sessionId, loadPalmares]);

  useEffect(() => {
    if (!showPalmares) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [showPalmares]);

  useEffect(() => {
    setRankingHistoryPortalReady(true);
  }, []);

  useEffect(() => {
    return () => {
      chatDictationActiveRef.current = false;
      if (speechRestartTimeoutRef.current) {
        clearTimeout(speechRestartTimeoutRef.current);
      }
      const r = speechRecognitionRef.current;
      speechRecognitionRef.current = null;
      if (r) {
        try {
          r.abort();
        } catch {
          /* */
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!chatExpanded) stopChatDictation();
  }, [chatExpanded, stopChatDictation]);

  useEffect(() => {
    const q = scoutQuery.trim();
    if (!q) {
      setScoutResults([]);
      return;
    }
    const t = setTimeout(() => {
      void searchPlayersCatalog(q).then(setScoutResults);
    }, 180);
    return () => clearTimeout(t);
  }, [scoutQuery, searchPlayersCatalog]);

  useEffect(() => {
    const q = palmaresQuery.trim();
    if (!q) {
      setPalmaresResults([]);
      return;
    }
    const t = setTimeout(() => {
      void searchPlayersCatalog(q).then(setPalmaresResults);
    }, 180);
    return () => clearTimeout(t);
  }, [palmaresQuery, searchPlayersCatalog]);

  useEffect(() => {
    if (!toastMessage) return;
    const t = window.setTimeout(() => setToastMessage(null), 2600);
    return () => window.clearTimeout(t);
  }, [toastMessage]);

  const taskDetailActionsEnabled =
    !!taskDetail &&
    taskDetailAllowActions &&
    taskDetail.task_date === todayIso;

  async function patchTask(
    task: ProgramTask,
    patch: {
      status?: string;
      task_date?: string;
    }
  ) {
    if (!sessionId) return;
    await fetch(`${API}/tasks/${sessionId}/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    await loadDashboard(sessionId);
    setTaskEdit(null);
  }

  async function deleteTask(task: ProgramTask) {
    if (!sessionId) return;
    const res = await fetch(`${API}/tasks/${sessionId}/${task.id}`, { method: "DELETE" });
    if (!res.ok) return;
    await loadDashboard(sessionId);
    setTaskEdit(null);
  }

  async function patchSessionTaskFeeling(task: ProgramTask, feeling: string, notes?: string) {
    if (!sessionId) return;
    const payload: Record<string, unknown> = {
      session_task_feeling: feeling,
      session_task_feeling_at: new Date().toISOString().slice(0, 10),
      session_task_feeling_task_id: task.id
    };
    const n = notes?.trim();
    if (n) payload.session_task_feeling_notes = n;
    await fetch(`${API}/context-memory/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  async function handleTaskModalComplete() {
    if (!sessionId || !taskDetail) return;
    if (!taskDetailAllowActions || taskDetail.task_date !== todayIso) return;
    if (taskFeedbackLoading) return;
    const isPending = taskDetail.status !== "done";
    if (!isPending && !taskFeedbackChoice) return;
    setTaskFeedbackLoading(true);
    try {
      if (isPending) {
        await patchTask(taskDetail, { status: "done" });
        void fireMicroConfetti();
      }
      if (taskFeedbackChoice) {
        const note = taskFeedbackNote.trim();
        await patchSessionTaskFeeling(taskDetail, taskFeedbackChoice, note || undefined);
        await loadDashboard(sessionId);
        let msg = `Ressenti sur la tâche id ${taskDetail.id} "${taskDetail.title}" (${TASK_TYPE_LABEL[taskDetail.task_type]}): ${taskFeedbackPhrase(
          taskFeedbackChoice
        )}. Mets à jour la mémoire si besoin et ajuste charge / longueur des prochains contenus si pertinent.`;
        if (note)
          msg += ` Précision du joueur : ${note}`;
        await sendQuickChatMessage(
          msg,
          undefined,
          "Mon ressenti sur la séance",
          "program_adjustment",
          "program_adjustment"
        );
      }
    } finally {
      setTaskFeedbackLoading(false);
      setTaskDetailAllowActions(false);
      setTaskDetail(null);
      setTaskFeedbackChoice(null);
      setTaskFeedbackNote("");
      setTaskModalView("full");
    }
  }

  async function runSuggestForAddTask() {
    if (!sessionId) return;
    const intent = addTaskIntent.trim();
    if (intent.length < 2) return;
    setAddTaskLoading(true);
    setAddTaskError(null);
    try {
      const res = await fetch(`${API}/program-tasks/suggest-add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, intent })
      });
      const data = (await res.json()) as {
        suggestions?: { title: string; description: string; task_type: string; duration_min: number }[];
        detail?: unknown;
      };
      if (!res.ok) {
        const msg =
          typeof data.detail === "string"
            ? data.detail
            : Array.isArray(data.detail)
              ? "Requête invalide"
              : "Erreur suggestions";
        throw new Error(msg);
      }
      const list = data.suggestions ?? [];
      if (!list.length) throw new Error("Aucune suggestion reçue.");
      setAddTaskSuggestions(list);
      setAddTaskStep("pick");
    } catch (e) {
      setAddTaskError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setAddTaskLoading(false);
    }
  }

  function openManualTaskSuggestionModal() {
    setAddTaskIntent("");
    setAddTaskStep("intent");
    setAddTaskSuggestions([]);
    setAddTaskError(null);
    setShowAddTaskModal(true);
  }

  async function confirmManualTask(s: {
    title: string;
    description: string;
    task_type: string;
    duration_min: number;
  }) {
    if (!sessionId) return;
    setAddTaskLoading(true);
    setAddTaskError(null);
    try {
      const res = await fetch(`${API}/program-tasks/add-manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          title: s.title,
          description: s.description,
          task_type: s.task_type,
          duration_min: s.duration_min,
          task_date: new Date().toISOString().slice(0, 10)
        })
      });
      const data = (await res.json()) as { detail?: unknown };
      if (!res.ok) {
        const msg = typeof data.detail === "string" ? data.detail : "Erreur lors de l’ajout de la tâche";
        throw new Error(msg);
      }
      await loadDashboard(sessionId);
      setShowAddTaskModal(false);
      setAddTaskStep("intent");
      setAddTaskIntent("");
      setAddTaskSuggestions([]);
    } catch (e) {
      setAddTaskError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setAddTaskLoading(false);
    }
  }

  async function runSimulate() {
    if (!sessionId) return;
    setSimLoading(true);
    setSimResult(null);
    try {
      const res = await fetch(`${API}/simulate-ranking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          hypothetical_victories: hypoRows.filter((r) => r.opponent_ranking.trim())
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as { detail?: string }).detail ?? "Erreur");
      setSimResult(data as Record<string, unknown>);
    } catch (e) {
      setSimResult({ error: e instanceof Error ? e.message : "Erreur" });
    } finally {
      setSimLoading(false);
    }
  }

  async function saveStaffPoles(next: Record<string, boolean>) {
    if (!sessionId) return;
    setStaffPoles(next);
    try {
      const res = await fetch(`${API}/staff/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next)
      });
      if (!res.ok) {
        // rollback visuel en cas d'erreur backend
        await loadDashboard(sessionId);
        return;
      }
      await loadDashboard(sessionId);
    } catch {
      await loadDashboard(sessionId);
    }
  }

  async function saveMatchTiming() {
    if (!sessionId || !dashboard?.match || !matchTimingValue) return;
    setMatchTimingSaveError(null);
    const parsed = new Date(matchTimingValue);
    if (Number.isNaN(parsed.getTime())) {
      setMatchTimingSaveError("Date ou heure invalide.");
      return;
    }
    const nextIso = parsed.toISOString();
    const selectedFormat =
      matchMetaForm.match_format === "Autre (personnalisé)"
        ? matchMetaForm.custom_match_format.trim() || "Match classique"
        : matchMetaForm.match_format || "Match classique";
    setMatchTimingSaving(true);
    try {
      const res = await fetch(`${API}/match/${sessionId}/${dashboard.match.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match_datetime: nextIso,
          surface: matchMetaForm.surface,
          match_format: selectedFormat,
          club_location: matchMetaForm.club_location
        })
      });
      const payload = (await res.json().catch(() => ({}))) as { detail?: string | unknown[] };
      if (!res.ok) {
        const msg = Array.isArray(payload.detail)
          ? "Données invalides"
          : typeof payload.detail === "string"
            ? payload.detail
            : "Impossible d'enregistrer le match.";
        setMatchTimingSaveError(msg);
        return;
      }
      await loadDashboard(sessionId);
      setShowMatchTimingEdit(false);
    } finally {
      setMatchTimingSaving(false);
    }
  }

  async function saveScoutInfo() {
    if (!sessionId || !scoutForm.opponent_name.trim()) return;
    setScoutSaveError(null);
    setScoutSaving(true);
    try {
      if (dashboard?.match) {
        const res = await fetch(`${API}/match/${sessionId}/${dashboard.match.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            opponent_id: scoutForm.opponent_id,
            opponent_name: scoutForm.opponent_name,
            opponent_ranking: scoutForm.opponent_ranking,
            opponent_style: scoutForm.opponent_style,
            opponent_notes: scoutForm.opponent_notes
          })
        });
        const payload = (await res.json().catch(() => ({}))) as { detail?: string | unknown[] };
        if (!res.ok) {
          const msg = Array.isArray(payload.detail)
            ? "Données invalides"
            : typeof payload.detail === "string"
              ? payload.detail
              : "Impossible d'enregistrer l'adversaire.";
          setScoutSaveError(msg);
          return;
        }
      } else {
        const res = await fetch(`${API}/opponents/${sessionId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: scoutForm.opponent_name,
            rank: scoutForm.opponent_ranking,
            play_style: scoutForm.opponent_style,
            notes_perso: scoutForm.opponent_notes
          })
        });
        const payload = (await res.json().catch(() => ({}))) as { detail?: string | unknown[] };
        if (!res.ok) {
          const msg = Array.isArray(payload.detail)
            ? "Données invalides"
            : typeof payload.detail === "string"
              ? payload.detail
              : "Impossible d'enregistrer l'adversaire.";
          setScoutSaveError(msg);
          return;
        }
      }
      setScoutQuery("");
      setScoutResults([]);
      await loadDashboard(sessionId);
      closeScoutModal();
    } finally {
      setScoutSaving(false);
    }
  }

  function openOpponentEditor() {
    const m = dashboard?.match;
    if (!m || !m.opponent_name?.trim()) return;
    setScoutSaveError(null);
    setScoutQuery("");
    setScoutResults([]);
    setScoutForm({
      opponent_id: m.opponent_id ?? m.catalog_player_id ?? null,
      opponent_name: m.opponent_name || "",
      opponent_ranking: m.opponent_ranking || "",
      opponent_style: m.opponent_style || "",
      opponent_notes: m.opponent_notes || ""
    });
    setShowScoutModal(true);
  }

  function closeScoutModal() {
    setShowScoutModal(false);
    setScoutSaveError(null);
    setScoutQuery("");
    setScoutResults([]);
  }

  async function saveCreateMatch() {
    if (!sessionId || !createMatchForm.date || !createMatchForm.time) return;
    setCreateMatchError(null);
    const dt = new Date(`${createMatchForm.date}T${createMatchForm.time}`);
    if (Number.isNaN(dt.getTime())) {
      setCreateMatchError("Date ou heure invalide.");
      return;
    }
    const res = await fetch(`${API}/match/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        match_datetime: dt.toISOString(),
        surface: createMatchForm.surface,
        match_format: createMatchForm.match_format,
        club_location: createMatchForm.club_location,
        opponent_name: createMatchForm.opponent_name,
        opponent_ranking: createMatchForm.opponent_ranking,
        opponent_style: createMatchForm.opponent_style,
        opponent_notes: createMatchForm.opponent_notes
      })
    });
    const payload = (await res.json().catch(() => ({}))) as { detail?: string | unknown[] };
    if (!res.ok) {
      const msg = Array.isArray(payload.detail)
        ? "Données invalides"
        : typeof payload.detail === "string"
          ? payload.detail
          : "Impossible de créer le match.";
      setCreateMatchError(msg);
      return;
    }
    await loadDashboard(sessionId);
    setShowCreateMatchModal(false);
  }

  async function prepareNextMatchWithAce() {
    if (!dashboard?.match) return;
    const hiddenContext = [
      `Preparation du prochain match id ${dashboard.match.id}.`,
      `Date/heure: ${dashboard.match.match_datetime}.`,
      `Adversaire: ${dashboard.match.opponent_name || "inconnu"}.`,
      `Classement adverse: ${dashboard.match.opponent_ranking || "inconnu"}.`,
      `Surface: ${dashboard.match.surface || "non renseignee"}.`,
      `Format: ${dashboard.match.match_format || "Match classique"}.`,
      `Lieu: ${dashboard.match.club_location || "non renseigne"}.`,
      `Objectif: definir uniquement les cles du match (focus_text / strategie).`,
      `Ne pas appeler replace_program_tasks: le joueur utilisera le bouton "Generer mon planning jusqu'au match" ensuite.`
    ].join(" ");
    await sendQuickChatMessage(
      "On prépare ton prochain match",
      hiddenContext,
      "On prépare ton prochain match",
      "general",
      "match_preparation"
    );
  }

  async function generatePlanningUntilMatchWithAce() {
    if (!dashboard?.match) return;
    const hiddenContext = [
      `Generation du programme jusqu'au match id ${dashboard.match.id}.`,
      `La strategie (focus_text / cles du match) est deja dans le dashboard: s'appuyer dessus.`,
      `Utiliser exclusivement le module planning: taches atomiques, un task_type par tache, outil replace_program_tasks apres validation utilisateur.`,
      `Ne pas redefinir la strategie sauf si une donnee critique manque vraiment.`
    ].join(" ");
    await sendQuickChatMessage(
      "Génère mon planning jusqu'au prochain match à partir de ma stratégie.",
      hiddenContext,
      "Génère mon planning jusqu'au match",
      "planning",
      "planning"
    );
  }

  async function saveMatchKeysManual() {
    if (!sessionId || !dashboard?.match) return;
    const res = await fetch(`${API}/match/${sessionId}/${dashboard.match.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ focus_text: matchKeysDraft.trim() })
    });
    if (!res.ok) return;
    await loadDashboard(sessionId);
    setShowMatchKeysEdit(false);
  }

  async function submitDebriefAndOpenChat() {
    if (!sessionId || !dashboard?.match || !debriefScore.trim()) return;
    if (!debriefOpponentAnonymous && !debriefOpponentName.trim()) {
      setShowAnonConfirmToast(true);
      return;
    }
    setShowAnonConfirmToast(false);
    const oppName = debriefOpponentAnonymous
      ? "Anonyme"
      : (debriefOpponentName.trim() || "À définir");
    const oppRanking = debriefOpponentAnonymous
      ? (debriefOpponentRanking.trim() || "À définir")
      : (debriefOpponentRanking.trim() || "À définir");
    const outcomeText = debriefOutcome === "won" ? "victoire" : "défaite";
    try {
      const res = await fetch(`${API}/match/${sessionId}/${dashboard.match.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "completed",
          result_score: debriefScore.trim(),
          outcome: debriefOutcome,
          opponent_name: oppName,
          opponent_ranking: oppRanking
        })
      });
      if (res.ok) {
        setToastMessage("Resultat enregistre. Synchronisation en cours...");
        const memPatch: Record<string, unknown> = {};
        if (debriefProgramHelpful) {
          memPatch.program_week_helpful = debriefProgramHelpful;
          memPatch.program_feedback_at = new Date().toISOString().slice(0, 10);
          memPatch.program_feedback_match_id = dashboard.match.id;
        }
        if (debriefProgramNotes.trim()) {
          memPatch.program_week_notes = debriefProgramNotes.trim();
        }
        if (Object.keys(memPatch).length > 0) {
          await fetch(`${API}/context-memory/${sessionId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(memPatch)
          });
          await loadDashboard(sessionId);
        }
      }
    } catch {
      // L'envoi chat ci-dessous suffit a enclencher le flow assistant.
    }

    const programFb = debriefProgramHelpful
      ? `Feedback programme de la semaine: ${debriefProgramHelpful === "yes" ? "utile" : debriefProgramHelpful === "somewhat" ? "mitige" : "peu utile"}.`
      : "Feedback programme de la semaine: non renseigne.";
    const programNotesLine = debriefProgramNotes.trim()
      ? `Commentaire programme: ${debriefProgramNotes.trim()}.`
      : "";

    const autoMessage = [
      `Voici le resultat de mon dernier match.`,
      `Match id: ${dashboard.match.id}.`,
      `Adversaire: ${oppName}.`,
      `Classement adversaire: ${oppRanking}.`,
      `Issue: ${outcomeText}.`,
      `Score: ${debriefScore.trim()}.`,
      `Surface: ${dashboard.match.surface || "non renseignee"}.`,
      `Format: ${dashboard.match.match_format || "match classique"}.`,
      `Lieu: ${dashboard.match.club_location || "non renseigne"}.`,
      programFb,
      programNotesLine,
      `Merci de me feliciter/reconforter selon le resultat, me poser une question sur mon ressenti, puis me demander quand est mon prochain match et si j'ai des infos pour le renseigner. Si je ne sais pas, laisse l'etat 'Ajouter mon prochain match'. Si je donne des infos, complete la fiche du prochain match.`
    ]
      .filter(Boolean)
      .join(" ");

    setShowDebriefModal(false);
    setDebriefScore("");
    setDebriefOpponentName("");
    setDebriefOpponentRanking("");
    setDebriefOpponentAnonymous(false);
    setDebriefProgramHelpful("");
    setDebriefProgramNotes("");
    await sendQuickChatMessage(
      `Je confirme. Traite le debrief du match ${dashboard.match.id}. Contexte utilisateur caché: ${autoMessage}`,
      "Débrief match terminé",
      "Débrief de mon dernier match",
      "debrief",
      "match_debrief"
    );
  }

  function openMatchEditor() {
    if (!dashboard?.match) return;
    setMatchTimingSaveError(null);
    const dt = new Date(dashboard.match.match_datetime);
    const pad = (n: number) => String(n).padStart(2, "0");
    setMatchTimingValue(
      `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(
        dt.getMinutes()
      )}`
    );
    const format = dashboard.match.match_format || "Match classique";
    const presetExists = MATCH_FORMAT_OPTIONS.some((opt) => opt === format);
    setMatchMetaForm({
      surface: dashboard.match.surface || "",
      match_format: presetExists ? format : "Autre (personnalisé)",
      club_location: dashboard.match.club_location || "",
      custom_match_format: presetExists ? "" : format
    });
    setShowMatchTimingEdit(true);
  }

  const matchUi = dashboard?.match?.ui_state ?? "no_match";
  const surfaceMeta = useMemo(
    () => surfaceChipFromText(dashboard?.match?.surface),
    [dashboard?.match?.surface]
  );
  const gamePlanKeys = useMemo(() => {
    const raw = dashboard?.match?.focus_text?.trim() ?? "";
    if (!raw) return [];
    return raw
      .split(/\n+/)
      .map((line) => line.replace(/^[\s\-•*]+/u, "").trim())
      .filter(Boolean);
  }, [dashboard?.match?.focus_text]);
  const hasMatchKeys = gamePlanKeys.length > 0;
  const profile = dashboard?.profile;

  const rankingHistoryRows = useMemo(() => {
    const sorted = [...palmaresEntries].sort((a, b) => a.match_date.localeCompare(b.match_date));
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let startMonth: Date;
    const createdRaw = dashboard?.profile?.profile_created_at?.trim();
    if (createdRaw) {
      const normalized = createdRaw.includes("T") ? createdRaw : `${createdRaw}T12:00:00`;
      const d = new Date(normalized);
      if (!Number.isNaN(d.getTime())) {
        startMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      } else {
        startMonth = currentMonthStart;
      }
    } else if (sorted.length > 0) {
      const d = new Date(`${sorted[0].match_date}T12:00:00`);
      if (!Number.isNaN(d.getTime())) {
        startMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      } else {
        startMonth = currentMonthStart;
      }
    } else {
      startMonth = currentMonthStart;
    }

    if (startMonth.getTime() > currentMonthStart.getTime()) {
      startMonth = new Date(currentMonthStart);
    }

    const rows: Array<{
      monthEnd: string;
      monthLabel: string;
      matchCount: number;
      wins: number;
      deltaMonth: number;
      cumulative: number;
      projected: string;
    }> = [];

    for (
      let cursor = new Date(startMonth.getFullYear(), startMonth.getMonth(), 1);
      cursor.getTime() <= currentMonthStart.getTime();
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    ) {
      const y = cursor.getFullYear();
      const m = cursor.getMonth();
      const m1 = m + 1;
      const monthStart = `${y}-${String(m1).padStart(2, "0")}-01`;
      const lastDay = new Date(y, m + 1, 0).getDate();
      const monthEnd = `${y}-${String(m1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const inMonth = sorted.filter((e) => e.match_date >= monthStart && e.match_date <= monthEnd);
      const deltaMonth = inMonth.reduce((s, e) => s + (e.points_delta ?? 0), 0);
      const wins = inMonth.filter((e) => e.won).length;
      const cumulative = sorted
        .filter((e) => e.match_date <= monthEnd)
        .reduce((s, e) => s + (e.points_delta ?? 0), 0);
      const monthLabel = cursor
        .toLocaleDateString("fr-FR", { month: "long", year: "numeric" })
        .replace(/^\p{L}/u, (c) => c.toUpperCase());
      rows.push({
        monthEnd,
        monthLabel,
        matchCount: inMonth.length,
        wins,
        deltaMonth,
        cumulative,
        projected: projectedRankingFromPoints(Math.max(0, cumulative))
      });
    }
    return rows;
  }, [palmaresEntries, dashboard?.profile?.profile_created_at]);

  function dismissOnboardingCue() {
    setOnboardingAcePopup(false);
    router.replace("/dashboard", { scroll: false });
  }
  const fftSummary = profile?.fft_points_summary_12m;
  const winRate = fftSummary?.win_rate_pct ?? 0;
  const bestPerfLabel = fftSummary?.best_win
    ? `${fftSummary.best_win.opponent_ranking}${fftSummary.best_win.opponent_name ? ` · ${fftSummary.best_win.opponent_name}` : ""}`
    : "—";
  const recentResults = useMemo(() => {
    const fromPalmares = palmaresEntries
      // Auto entries from debrief already exist in match_history; skip to avoid duplicates in streak bubbles.
      .filter((e) => !String(e.notes || "").startsWith("[AUTO_MATCH:"))
      .map((e) => ({
        key: `p-${e.id}`,
        match_date: e.match_date,
        won: !!e.won,
        opponent: (e.opponent_name || "").trim().toLowerCase()
      }));
    const fromHistory = (dashboard?.match_history ?? [])
      .filter((h) => h.outcome === "won" || h.outcome === "lost")
      .map((h) => ({
        key: `h-${h.match_id}`,
        match_date: h.match_date,
        won: h.outcome === "won",
        opponent: (h.opponent_name || "").trim().toLowerCase()
      }));
    const seen = new Set<string>();
    const merged = [...fromHistory, ...fromPalmares].filter((r) => {
      const id = `${r.match_date}-${r.won ? "w" : "l"}-${r.opponent || "-"}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    merged.sort((a, b) => (a.match_date < b.match_date ? 1 : -1));
    // In UI, newest result must be on the right.
    return merged.slice(0, 5).reverse();
  }, [dashboard?.match_history, palmaresEntries]);
  const totalMatchesPlayed = useMemo(() => {
    const fromPalmares = palmaresEntries
      .filter((e) => !String(e.notes || "").startsWith("[AUTO_MATCH:"))
      .map((e) => ({
        match_date: e.match_date,
        won: !!e.won,
        opponent: (e.opponent_name || "").trim().toLowerCase()
      }));
    const fromHistory = (dashboard?.match_history ?? [])
      .filter((h) => h.outcome === "won" || h.outcome === "lost")
      .map((h) => ({
        match_date: h.match_date,
        won: h.outcome === "won",
        opponent: (h.opponent_name || "").trim().toLowerCase()
      }));
    const seen = new Set<string>();
    return [...fromHistory, ...fromPalmares].filter((r) => {
      const id = `${r.match_date}-${r.won ? "w" : "l"}-${r.opponent || "-"}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).length;
  }, [dashboard?.match_history, palmaresEntries]);
  const palmaresDisplayRows = useMemo(() => {
    const autoMatchIds = new Set<number>(
      palmaresEntries
        .map((e) => {
          const raw = String(e.notes || "");
          const m = raw.match(/^\[AUTO_MATCH:(\d+)\]/);
          return m ? Number(m[1]) : null;
        })
        .filter((v): v is number => Number.isFinite(v))
    );
    const manual = palmaresEntries.map((e) => ({
      kind: "manual" as const,
      id: `manual-${e.id}`,
      match_date: e.match_date,
      opponent_label: e.opponent_name?.trim() ? `${e.opponent_name}` : "Adversaire",
      rank_label: (e.opponent_ranking || "").trim() || "À définir",
      won: e.won,
      points_delta: e.points_delta,
      notes: String(e.notes || ""),
      source_label: String(e.notes || "").startsWith("[AUTO_MATCH:")
        ? "source Ace"
        : String(e.notes || "").toLowerCase().includes("tenup import")
          ? "source Ten'Up import"
          : "source Ace",
      opponent_name_key: (e.opponent_name || "").trim().toLowerCase(),
      opponent_ranking_key: (e.opponent_ranking || "").trim().toLowerCase(),
      manualEntry: e
    }));
    const manualNameOnlyKeys = new Set(
      manual.map((m) => `${m.match_date}|${m.won ? "won" : "lost"}|${m.opponent_name_key}`)
    );
    const manualKeys = new Set(manual.map((m) => `${m.match_date}|${m.won ? "won" : "lost"}|${m.opponent_name_key}|${m.opponent_ranking_key}`));
    const history = (dashboard?.match_history ?? [])
      .filter((h) => h.outcome === "won" || h.outcome === "lost")
      .map((h) => ({
        kind: "history" as const,
        id: `history-${h.match_id}`,
        match_id: h.match_id,
        match_date: h.match_date,
        opponent_label: h.opponent_name ? `${h.opponent_name}` : "Adversaire",
        rank_label: "À définir",
        won: h.outcome === "won",
        points_delta: null as number | null,
        notes: [h.score ? `Score: ${h.score}` : "", h.sensations ? `Sensations: ${h.sensations}` : ""]
          .filter(Boolean)
          .join(" · "),
        source_label: "source Ace",
        opponent_name_key: (h.opponent_name || "").trim().toLowerCase(),
        opponent_ranking_key: "",
        manualEntry: null as PalmaresEntry | null
      }))
      .filter((h) => {
        if (autoMatchIds.has(h.match_id)) return false;
        const kExact = `${h.match_date}|${h.won ? "won" : "lost"}|${h.opponent_name_key}|${h.opponent_ranking_key}`;
        const kNameOnly = `${h.match_date}|${h.won ? "won" : "lost"}|${h.opponent_name_key}|`;
        const kNameOnlyNoRank = `${h.match_date}|${h.won ? "won" : "lost"}|${h.opponent_name_key}`;
        const kWithUnknownName = `${h.match_date}|${h.won ? "won" : "lost"}||`;
        const kWithUnknownRank = `${h.match_date}|${h.won ? "won" : "lost"}|${h.opponent_name_key}|à définir`;
        const kWithUnknownRankAscii = `${h.match_date}|${h.won ? "won" : "lost"}|${h.opponent_name_key}|a definir`;
        const kWithUnknownRankDash = `${h.match_date}|${h.won ? "won" : "lost"}|${h.opponent_name_key}|—`;
        const kWithUnknownRankQ = `${h.match_date}|${h.won ? "won" : "lost"}|${h.opponent_name_key}|??`;
        return !(
          manualKeys.has(kExact) ||
          manualKeys.has(kNameOnly) ||
          manualNameOnlyKeys.has(kNameOnlyNoRank) ||
          manualKeys.has(kWithUnknownName) ||
          manualKeys.has(kWithUnknownRank) ||
          manualKeys.has(kWithUnknownRankAscii) ||
          manualKeys.has(kWithUnknownRankDash) ||
          manualKeys.has(kWithUnknownRankQ)
        );
      });
    const out = [...manual, ...history];
    out.sort((a, b) => (a.match_date < b.match_date ? 1 : -1));
    return out;
  }, [dashboard?.match_history, palmaresEntries]);

  const programByDate = useMemo(() => {
    const list = dashboard?.program_until_match ?? [];
    const map = new Map<string, ProgramTask[]>();
    for (const t of list) {
      const arr = map.get(t.task_date) ?? [];
      arr.push(t);
      map.set(t.task_date, arr);
    }
    return map;
  }, [dashboard?.program_until_match]);
  const weekDates = useMemo(() => {
    const existing = Array.from(new Set((dashboard?.program_until_match ?? []).map((t) => t.task_date)));
    if (existing.length > 0) return existing.sort();
    const out: string[] = [];
    const start = new Date();
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }, [dashboard?.program_until_match]);
  const weekDatesFromToday = useMemo(() => {
    const out: string[] = [];
    const start = new Date();
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }, []);

  const programDayStory = useMemo(() => {
    const matchIso = dashboard?.match?.match_datetime;
    const matchDay = matchIso?.slice(0, 10);
    if (!matchDay || !selectedProgramDay) {
      return { band: "", why: "" };
    }
    const d = daysBetweenIso(selectedProgramDay, matchDay);
    if (d < 0) {
      return {
        band: "Après le match",
        why: "Ce jour est après la date du match : vérifie la date du match ou recale ton programme."
      };
    }
    if (d === 0) {
      return {
        band: "Jour J",
        why: "Rituel pré-match : activation légère, clarté mentale, sans surcharger."
      };
    }
    if (d === 1) {
      return {
        band: "J-1",
        why: "Veille : récupération, sommeil et image mentale avant le match."
      };
    }
    if (d <= 3) {
      return {
        band: `J-${d}`,
        why: "Préparation spécifique : charge et contenus adaptés à la fenêtre restante."
      };
    }
    return {
      band: `J-${d}`,
      why: "Phase amont : bases techniques, volume physique modéré, progression vers le match."
    };
  }, [dashboard?.match?.match_datetime, selectedProgramDay]);
  const todayTasksSorted = useMemo(() => {
    const list = [...(dashboard?.program_today ?? [])];
    list.sort((a, b) => {
      const aDone = a.status === "done" ? 1 : 0;
      const bDone = b.status === "done" ? 1 : 0;
      return aDone - bDone;
    });
    return list;
  }, [dashboard?.program_today]);
  const todayTaskStats = useMemo(() => {
    const list = dashboard?.program_today ?? [];
    const total = list.length;
    const done = list.filter((t) => t.status === "done").length;
    return { total, done, pending: total - done };
  }, [dashboard?.program_today]);
  useEffect(() => {
    if (!selectedProgramDay && weekDates.length > 0) setSelectedProgramDay(weekDates[0]);
  }, [selectedProgramDay, weekDates]);
  useEffect(() => {
    if (!taskEdit) return;
    const firstDifferent =
      weekDatesFromToday.find((d) => d !== taskEdit.task_date) ?? weekDatesFromToday[0];
    setTaskEditDate(firstDifferent);
  }, [taskEdit, weekDatesFromToday]);
  useEffect(() => {
    const id = taskDetail?.id;
    if (id == null) {
      setTaskModalView("full");
      return;
    }
    setTaskFeedbackChoice(null);
    setTaskFeedbackNote("");
  }, [taskDetail?.id]);
  useEffect(() => {
    if (!dashboard?.match) return;
    setMatchMetaForm({
      surface: dashboard.match.surface || "",
      match_format: dashboard.match.match_format || "",
      club_location: dashboard.match.club_location || "",
      custom_match_format: ""
    });
    setScoutForm({
      opponent_id: dashboard.match.opponent_id ?? dashboard.match.catalog_player_id ?? null,
      opponent_name: dashboard.match.opponent_name || "",
      opponent_ranking: dashboard.match.opponent_ranking || "",
      opponent_style: dashboard.match.opponent_style || "",
      opponent_notes: dashboard.match.opponent_notes || ""
    });
  }, [dashboard?.match]);

  const pointsHint =
    profile?.points_to_next_echelon != null && profile?.next_echelon_label
      ? `${profile.points_to_next_echelon} points nécessaires pour passer ${profile.next_echelon_label}`
      : profile?.points_to_target != null && profile?.target_ranking
        ? `${profile.points_to_target} points nécessaires pour l’objectif ${profile.target_ranking}`
        : null;
  const goalProgressPercent = Math.round((profile?.goal_progress_ratio ?? 0) * 100);

  if (sessionStatus === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <Loader2 className="h-8 w-8 animate-spin text-[#e67e22]" />
      </div>
    );
  }
  if (sessionStatus === "unauthenticated" || !session?.user?.id) {
    return null;
  }

  return (
    <div className="min-h-screen bg-black pb-8 text-neutral-100">
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-6">
        {/* Header — bandeau synthèse */}
        <header className="mb-8 rounded-[1.25rem] border border-white/[0.06] px-4 py-4 md:px-6 md:py-5">
          <div className="grid gap-4 md:grid-cols-[1.1fr_1.6fr_1.4fr_0.9fr] md:gap-5">
            <button
              type="button"
              onClick={() => {
                setProfileSaveError(null);
                setProfileDeleteExpanded(false);
                setDeleteAccountPassword("");
                setDeleteAccountError(null);
                setShowProfile(true);
              }}
              className="group flex min-h-[130px] w-full flex-col items-start justify-start rounded-2xl px-2 text-left transition hover:bg-white/[0.02]"
            >
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-neutral-200">
                Profil
              </p>
              <div className="mt-3 flex flex-col items-start gap-2">
                <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-zinc-600 to-zinc-900 text-xl font-bold text-white ring-2 ring-white/15">
                  {profile?.avatar_data_url ? (
                    <img
                      src={profile.avatar_data_url}
                      alt="Profil"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    (profile?.display_name || "J").slice(0, 1).toUpperCase()
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-base font-bold leading-tight text-white">
                    {profile?.display_name || "Joueur"}
                  </p>
                  <p className="mt-1 truncate text-xs font-medium text-neutral-400">
                    {profile?.playing_style || "Décris ton style de jeu"}
                  </p>
                </div>
              </div>
            </button>

            <div className="flex min-h-[130px] flex-col justify-start border-white/15 md:border-l md:pl-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-neutral-200">
                Mon classement
              </p>
              <div className="mt-3">
                <button
                  type="button"
                  title="Voir et compléter le palmarès"
                  onClick={() => {
                    cancelPalmaresEdit();
                    setShowPalmares(true);
                  }}
                  className="h-[56px] rounded-full border border-white/12 bg-[#3a3a3a] px-8 text-[2.1rem] font-extrabold leading-none tracking-tight text-white transition hover:border-white/25 hover:bg-[#454545]"
                >
                  {profile?.current_ranking || "—"}
                </button>
              </div>
              {pointsHint && (
                <p className="mt-2 truncate whitespace-nowrap text-[11px] font-medium leading-snug text-[#9cffbd]">
                  <span className="mr-1 inline-flex align-middle text-[#58d68d]">
                    <TrendingUp className="inline h-3.5 w-3.5" />
                  </span>
                  {pointsHint}
                </p>
              )}
              <button
                type="button"
                onClick={() => setShowSimulate(true)}
                className={cn(
                  buttonSecondary,
                  "mt-auto h-8 self-start rounded-full px-3.5 py-0 text-xs font-medium"
                )}
              >
                Simuler mes prochains matchs
              </button>
            </div>

            <div className="flex min-h-[130px] flex-col justify-start gap-[5px] border-white/15 md:border-l md:pl-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-neutral-200">
                Mes résultats
              </p>
              <div className="mt-2 flex items-center gap-2">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className={`flex h-[30px] w-[30px] items-center justify-center rounded-full text-xs font-bold ${
                      i < recentResults.length
                        ? recentResults[i].won
                          ? "bg-[#58d68d] text-black shadow-[0_0_12px_rgba(88,214,141,0.45)]"
                          : "bg-red-500/80 text-white shadow-[0_0_10px_rgba(239,68,68,0.35)]"
                        : "border border-white/10 bg-[#1a1a1a] text-neutral-600"
                    }`}
                  >
                    {i < recentResults.length ? (recentResults[i].won ? "V" : "D") : ""}
                  </div>
                ))}
              </div>
              <div className="mt-2.5 flex w-full min-w-[8.2rem] flex-col gap-2.5 rounded-xl border border-white/10 bg-gradient-to-br from-[#58d68d]/12 to-black/20 px-3 py-1.5">
                <div className="flex items-end justify-between gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-neutral-300">
                    Ratio V/D
                  </span>
                  <span className="tabular-nums text-xl font-black leading-none text-[#58d68d]">
                    {winRate.toFixed(1)}
                    <span className="text-sm font-bold">%</span>
                  </span>
                </div>
                <div
                  className="relative h-1.5 w-full overflow-hidden rounded-full bg-black/50 ring-1 ring-white/10"
                  role="progressbar"
                  aria-valuenow={Math.round(winRate * 10) / 10}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Ratio victoires-défaites ${winRate.toFixed(1)} pour cent`}
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#58d68d] to-[#8eeda8] transition-[width] duration-300"
                    style={{ width: `${Math.min(100, Math.max(0, winRate))}%` }}
                  />
                </div>
                <p className="truncate text-[10px] leading-tight text-neutral-300">
                  {totalMatchesPlayed} matchs joués
                  <span className="px-1 text-neutral-500">•</span>
                  <span className="text-neutral-400">Top victoire: {bestPerfLabel}</span>
                </p>
              </div>
            </div>

            <div className="flex min-h-[130px] flex-col justify-start border-white/15 md:border-l md:pl-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-neutral-200">
                Mon objectif
              </p>
              <div className="mt-2 flex flex-col items-start gap-1.5">
                <GoalRing
                  label={profile?.target_ranking || "—"}
                  ratio={profile?.goal_progress_ratio ?? 0}
                  size={106}
                />
                <p className="text-xs font-medium text-neutral-400">{goalProgressPercent}% complété</p>
              </div>
            </div>
          </div>
        </header>

        {/* Grille principale */}
        <div className="grid gap-5 md:grid-cols-5 md:items-stretch">
          {/* Prochain match */}
          <section className="flex h-full min-h-0 flex-col md:col-span-2 rounded-3xl border border-white/10 bg-[#1e1e1e] p-5 shadow-xl">
            <div className="mb-4 flex items-center gap-2 text-white">
              <TennisBall className="h-5 w-5 shrink-0 text-neutral-400" aria-hidden />
              <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-white">
                Prochain match
              </h2>
            </div>

            {isBootstrapping && <p className="text-sm text-neutral-500">Chargement…</p>}

            {!isBootstrapping && matchUi === "no_match" && (
              <div className="space-y-3.5 rounded-[20px] px-0">
                <div className="rounded-[20px] border border-dashed border-white/15 bg-black/20 px-4 py-10 text-center">
                  <p className="text-sm font-semibold text-white">Aucun match à venir</p>
                </div>
                <div
                  className={
                    onboardingTour && matchUi === "no_match"
                      ? "relative rounded-full shadow-[0_0_0_3px_rgba(230,126,34,0.8),0_0_28px_rgba(230,126,34,0.45)]"
                      : ""
                  }
                >
                  <button
                    type="button"
                    id="ace-onboarding-add-match"
                    onClick={() => {
                      setCreateMatchError(null);
                      setCreateMatchForm((prev) => ({
                        ...prev,
                        date: new Date().toISOString().slice(0, 10),
                        time: "18:00",
                        surface: "",
                        match_format: "Match classique",
                        club_location: ""
                      }));
                      setShowCreateMatchModal(true);
                    }}
                    className="w-full rounded-full bg-[#e67e22] py-2.5 text-sm font-semibold text-white shadow-lg shadow-black/40 transition hover:brightness-110"
                  >
                    Ajouter mon prochain match
                  </button>
                </div>
              </div>
            )}

            {!isBootstrapping && matchUi !== "no_match" && (
              <div className="space-y-3.5 rounded-[20px] px-0">
                <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3">
                  <div className="min-w-0 justify-self-end text-center">
                    <p className="mb-2 text-[11px] text-neutral-300">{profile?.display_name || "Toi"}</p>
                    <div className="relative mx-auto h-16 w-16">
                      {profile?.avatar_data_url ? (
                        <img
                          src={profile.avatar_data_url}
                          alt="Ton profil"
                          className="h-16 w-16 rounded-full object-cover ring-2 ring-white/10"
                        />
                      ) : (
                        <UserCircle2 className="h-16 w-16 text-neutral-200" />
                      )}
                      <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-[#3f3f43] px-2.5 py-0.5 text-[10px] font-bold text-white">
                        {profile?.current_ranking || "—"}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-center justify-center gap-0.5">
                    <p className="text-[30px] font-extrabold leading-none text-white">VS</p>
                    <div className="mt-2 inline-flex rounded-xl bg-[#86f7b4] px-3 py-1 text-sm font-bold text-[#1a1a1a]">
                      {dashboard?.match?.points_if_win != null ? `+${dashboard.match.points_if_win} Pts` : "+Pts"}
                    </div>
                  </div>
                  {dashboard?.match?.opponent_name?.trim() ? (
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={openOpponentEditor}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openOpponentEditor();
                        }
                      }}
                      className="min-w-0 cursor-pointer justify-self-start rounded-lg text-center outline-none transition hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-[#e67e22]/60"
                    >
                      <p className="mb-2 text-[11px] text-neutral-300">{dashboard.match.opponent_name}</p>
                      <div className="relative mx-auto h-16 w-16">
                        <UserCircle2 className="h-16 w-16 text-neutral-300" />
                        <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-[#3f3f43] px-2.5 py-0.5 text-[10px] font-bold text-white">
                          {dashboard.match.opponent_ranking || "À définir"}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="min-w-0 cursor-default justify-self-start rounded-lg text-center opacity-80"
                      aria-label="Adversaire non renseigné"
                    >
                      <p className="mb-2 text-[11px] text-neutral-300">À définir</p>
                      <div className="relative mx-auto h-16 w-16">
                        <ShieldQuestion className="h-16 w-16 text-neutral-500" />
                        <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-[#3f3f43] px-2.5 py-0.5 text-[10px] font-bold text-white">
                          À définir
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {matchUi === "past" && (
                  <button
                    type="button"
                    onClick={() => {
                      setDebriefOutcome("won");
                      setDebriefScore("");
                      setShowDebriefModal(true);
                    }}
                    className="w-full rounded-full bg-[#e67e22] py-2.5 text-sm font-semibold text-white shadow-lg shadow-black/40 transition hover:brightness-110"
                  >
                    Match terminé - Débriefer
                  </button>
                )}

                {matchUi === "upcoming" && dashboard?.match && (
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={openMatchEditor}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openMatchEditor();
                      }
                    }}
                    className="!mt-6 cursor-pointer rounded-[20px] border border-white/10 bg-black/25 p-3 outline-none transition hover:bg-black/35 focus-visible:ring-2 focus-visible:ring-[#e67e22]/60"
                  >
                    <div className="flex w-full items-center justify-between gap-2 text-left">
                      <p className="truncate text-base font-semibold text-white">
                        {matchDateLong(dashboard.match.match_datetime)}
                      </p>
                      <p className="shrink-0 text-xs font-medium text-neutral-300">
                        {countdownToMatch(dashboard.match.match_datetime)}
                      </p>
                    </div>
                    <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
                      <div className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-white/20 bg-[#2a2a2a] px-2 py-1 text-[10px] font-semibold text-white">
                        <img src={surfaceMeta.icon} alt={surfaceMeta.label} className="h-3.5 w-3.5 rounded-sm object-cover" />
                        {dashboard.match.surface || surfaceMeta.label}
                      </div>
                      <div className="shrink-0 rounded-md border border-white/20 bg-[#2a2a2a] px-2 py-1 text-[10px] font-semibold text-neutral-100">
                        {dashboard.match.match_format || "Format à renseigner"}
                      </div>
                      <div className="shrink-0 rounded-md border border-white/20 bg-[#2a2a2a] px-2 py-1 text-[10px] font-semibold text-neutral-100">
                        {dashboard.match.club_location || "Lieu à renseigner"}
                      </div>
                    </div>
                  </div>
                )}

                {matchUi === "past" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (dashboard?.match) openMatchEditor();
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-white/20 bg-[#2a2a2a] px-2 py-1 text-[10px] font-semibold text-white"
                    >
                      <img src={surfaceMeta.icon} alt={surfaceMeta.label} className="h-3.5 w-3.5 rounded-sm object-cover" />
                      {dashboard?.match?.surface || surfaceMeta.label}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (dashboard?.match) openMatchEditor();
                      }}
                      className="rounded-md border border-white/20 bg-[#2a2a2a] px-2 py-1 text-[10px] font-semibold text-neutral-100"
                    >
                      {dashboard?.match?.match_format || "Match classique"}
                    </button>
                  </div>
                )}

                <div className="rounded-[20px] border border-white/10 bg-black/25 p-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (!dashboard?.match) return;
                      setMatchKeysDraft(dashboard.match.focus_text || "");
                      setShowMatchKeysEdit(true);
                    }}
                    className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#e67e22]"
                  >
                    Clés du match
                  </button>
                  {matchUi === "upcoming" && !hasMatchKeys ? (
                    <>
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] py-10 text-center text-sm text-neutral-500">
                        Aucune stratégie pour le moment
                      </div>
                      <button
                        type="button"
                        onClick={() => void prepareNextMatchWithAce()}
                        className="mt-4 w-full rounded-full bg-[#e67e22] py-2.5 text-sm font-semibold text-white hover:brightness-110"
                      >
                        Préparer mon prochain match
                      </button>
                    </>
                  ) : (
                    <ul className="space-y-2.5">
                      {(gamePlanKeys.length > 0 ? gamePlanKeys : ["Clarifie ton plan avec Ace."]).map((k, idx) => (
                        <li key={idx} className="text-sm leading-relaxed text-neutral-100">
                          <span className="mr-2 text-neutral-400">→</span>
                          {k}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Programme du jour */}
          <section className="flex h-full min-h-0 max-h-[420px] flex-col md:max-h-none md:col-span-3 rounded-3xl border border-white/10 bg-[#1e1e1e] p-5 shadow-xl">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-neutral-400" />
                <h2 className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-400">
                  Programme du jour
                </h2>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowStaff(true)}
                  className="rounded-lg px-2 py-1 text-[11px] font-medium text-[#e67e22]/85 transition hover:bg-[#e67e22]/10 hover:text-[#e67e22]"
                >
                  Mon staff
                </button>
                {(dashboard?.program_until_match?.length ?? 0) > 0 ? (
                  <>
                    <span className="text-neutral-600 select-none" aria-hidden>
                      ·
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowProgramFull(true)}
                      className="rounded-lg px-2 py-1 text-[11px] font-medium text-[#e67e22]/85 transition hover:bg-[#e67e22]/10 hover:text-[#e67e22]"
                    >
                      Voir plus
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {(dashboard?.program_today?.length ?? 0) === 0 && (
                <li className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] py-8 text-center text-sm text-neutral-500">
                  Aucune tâche aujourd’hui. Demande un plan à Ace.
                </li>
              )}
              {dashboard?.program_today?.map((task) => {
                const styles = taskTypeStyles(task);
                const typeLabel = TASK_TYPE_LABEL[task.task_type] ?? TASK_TYPE_LABEL.technique;
                const objectivePreview = taskObjectivePreview(task.description);
                return (
                <li key={task.id} className={`rounded-xl border-l-4 bg-[#2a2a2a] ${styles.border}`}>
                  <div className="flex items-stretch gap-2.5 px-3 py-3">
                    <button
                      type="button"
                      aria-label={
                        task.status === "done"
                          ? "Remettre la tâche en à faire"
                          : "Valider la séance — ressenti uniquement"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        if (task.status === "done") {
                          void patchTask(task, { status: "pending" });
                        } else {
                          setTaskModalView("feedback");
                          setTaskFeedbackChoice(null);
                          setTaskFeedbackNote("");
                          setTaskDetailAllowActions(task.task_date === todayIso);
                          setTaskDetail(task);
                        }
                      }}
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 self-start ${
                        task.status === "done"
                          ? "border-[#22c55e] bg-[#22c55e] text-white"
                          : "border-neutral-500 bg-transparent"
                      }`}
                    >
                      {task.status === "done" && <Check className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#e67e22]/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#2a2a2a] rounded-md"
                      onClick={() => {
                        setTaskModalView("full");
                        setTaskFeedbackChoice(null);
                        setTaskFeedbackNote("");
                        setTaskDetailAllowActions(task.task_date === todayIso);
                        setTaskDetail(task);
                      }}
                    >
                      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0 text-[10px] font-bold uppercase tracking-[0.12em]">
                        <span className={`inline-flex items-center gap-1.5 ${styles.label}`}>
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${styles.dot}`} />
                          {typeLabel}
                        </span>
                        <span className="text-neutral-500">•</span>
                        <span className="font-semibold text-neutral-400">
                          {task.duration_min || 30} min
                        </span>
                      </p>
                      <p className="mt-1 text-sm font-semibold leading-snug text-white">{task.title}</p>
                      {objectivePreview ? (
                        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-neutral-400">
                          {objectivePreview}
                        </p>
                      ) : null}
                    </button>
                  </div>
                </li>
              );
              })}
            </ul>
            <div className="mt-3 shrink-0 space-y-2 border-t border-white/10 pt-3">
              {matchUi === "upcoming" &&
                dashboard?.match &&
                hasMatchKeys &&
                (dashboard.program_until_match?.length ?? 0) === 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => void generatePlanningUntilMatchWithAce()}
                      disabled={isLoading || isBootstrapping}
                      className="w-full rounded-2xl bg-[#e67e22] px-3 py-2.5 text-center text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Générer mon planning jusqu&apos;au match
                    </button>
                    <p className="text-center text-[10px] text-neutral-500">
                      À partir de ta stratégie (clés du match). Tu pourras valider avec Ace avant mise à jour
                      des tâches.
                    </p>
                  </>
                )}
              {matchUi === "upcoming" &&
                dashboard?.match &&
                hasMatchKeys &&
                (dashboard.program_until_match?.length ?? 0) > 0 && (
                  <p className="text-center text-[10px] text-neutral-500">
                    Ton planning jusqu&apos;au match est en place (
                    {(dashboard.program_until_match?.length ?? 0) > 1
                      ? `${dashboard.program_until_match?.length} séances`
                      : "1 séance"}
                    ). Ouvre Ace pour ajuster ou regénérer.
                  </p>
                )}
              <button
                type="button"
                onClick={() => openManualTaskSuggestionModal()}
                disabled={isBootstrapping || !sessionId}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[#e67e22]/40 bg-transparent px-3 py-2.5 text-center text-sm font-semibold text-neutral-100 transition hover:border-[#e67e22]/60 hover:bg-[#e67e22]/10 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Plus className="h-4 w-4 shrink-0 text-[#e67e22]" />
                Ajouter une tâche
              </button>
            </div>
          </section>
        </div>
      </div>

      {onboardingAcePopup && matchUi === "no_match" && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="flex gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#e67e22]/20">
                <Bot className="h-6 w-6 text-[#e67e22]" />
              </div>
              <div>
                <p className="font-semibold text-white">Ace</p>
                <p className="mt-2 text-sm leading-relaxed text-neutral-300">
                  Ta préparation commence ici. Dis-moi quand est ton prochain match pour que je crée ton
                  programme de guerrier.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={dismissOnboardingCue}
              className="mt-6 w-full rounded-2xl bg-[#e67e22] py-3 text-sm font-semibold text-white hover:brightness-110"
            >
              C&apos;est noté !
            </button>
          </div>
        </div>
      )}

      {/* Modal profil */}
      {showProfile && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Profil</h3>
              <button
                type="button"
                onClick={() => {
                  setShowProfile(false);
                  setShowRankingHistoryModal(false);
                  setProfileDeleteExpanded(false);
                  setDeleteAccountPassword("");
                  setDeleteAccountError(null);
                }}
                className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3 text-sm">
              {/* 1. Photo */}
              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  Photo de profil
                </p>
                <div className="flex items-center gap-3">
                  <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-zinc-800 ring-1 ring-white/10">
                    {profileForm.avatar_data_url ? (
                      <img
                        src={profileForm.avatar_data_url}
                        alt="Aperçu profil"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <UserCircle2 className="h-7 w-7 text-neutral-400" />
                    )}
                  </div>
                  <div className="flex-1">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => onAvatarSelected(e.target.files?.[0] ?? null)}
                      className="block w-full text-xs text-neutral-300 file:mr-3 file:rounded-lg file:border-0 file:bg-[#e67e22] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:brightness-110"
                    />
                    <p className="mt-1 text-[11px] text-neutral-500">PNG/JPG/WebP, max 2 Mo.</p>
                  </div>
                </div>
              </div>

              {/* 2. Prénom et nom */}
              <label className="block text-neutral-300">
                Prénom et nom
                <input
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white outline-none focus:ring-1 focus:ring-[#e67e22]"
                  value={profileForm.display_name}
                  onChange={(e) =>
                    setProfileForm((p) => ({ ...p, display_name: e.target.value }))
                  }
                  placeholder="ex. Jean Dupont"
                  autoComplete="name"
                />
              </label>

              {/* 3. Objectif + classement */}
              <label className="block text-neutral-300">
                Objectif (classement visé)
                <EchelonSelect
                  value={profileForm.target_ranking}
                  onChange={(v) => setProfileForm((p) => ({ ...p, target_ranking: v }))}
                  placeholder="— Choisir un échelon cible —"
                />
              </label>
              <div>
                <label className="block text-neutral-300">
                  Classement du mois en cours (FFT / Ten&apos;Up)
                  <EchelonSelect
                    value={profileForm.current_ranking}
                    onChange={(v) => setProfileForm((p) => ({ ...p, current_ranking: v }))}
                    placeholder="— Choisir l&apos;échelon affiché ce mois (FFT / Ten&apos;Up) —"
                  />
                </label>
                <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">
                  Les <strong className="text-neutral-400">points</strong> et la{" "}
                  <strong className="text-neutral-400">projection d&apos;échelon</strong> du modèle évoluent
                  avec ton <strong className="text-neutral-400">palmarès</strong> et tes matchs saisis. L&apos;
                  <strong className="text-neutral-400">échelon FFT du mois</strong> reste une saisie manuelle :
                  actualise-le sur Ace lorsque Ten&apos;Up ou la FFT affichent un changement.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowRankingHistoryModal(true)}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/20 py-2.5 text-sm font-semibold text-white transition hover:bg-white/5"
              >
                <TrendingUp className="h-4 w-4 text-[#58d68d]" />
                Historique des classements
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowProfile(false);
                  setShowRankingHistoryModal(false);
                  setProfileDeleteExpanded(false);
                  setDeleteAccountPassword("");
                  setDeleteAccountError(null);
                  cancelPalmaresEdit();
                  setShowPalmares(true);
                }}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/20 py-2.5 text-sm font-semibold text-white transition hover:bg-white/5"
              >
                <Trophy className="h-4 w-4 text-[#e67e22]" />
                Palmarès (matchs passés)
              </button>

              {/* 4. Style de jeu */}
              <label className="block text-neutral-300">
                Style de jeu
                <input
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  value={profileForm.playing_style}
                  onChange={(e) =>
                    setProfileForm((p) => ({ ...p, playing_style: e.target.value }))
                  }
                  placeholder="ex. puissant fond de court"
                />
              </label>

              {/* 5. Surface favorite */}
              <label className="block text-neutral-300">
                Surface favorite
                <input
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  value={profileForm.preferred_surface}
                  onChange={(e) =>
                    setProfileForm((p) => ({ ...p, preferred_surface: e.target.value }))
                  }
                  placeholder="ex. Terre battue"
                />
              </label>

              <details className="rounded-xl border border-white/10 bg-black/10 px-3 py-2">
                <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  Disponibilités & santé (optionnel)
                </summary>
                <div className="mt-3 space-y-3 pb-1">
                  <label className="block text-neutral-300">
                    Disponibilité hebdomadaire
                    <input
                      className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                      value={profileForm.weekly_availability}
                      onChange={(e) =>
                        setProfileForm((p) => ({ ...p, weekly_availability: e.target.value }))
                      }
                      placeholder="ex. mar. et jeu. soir"
                    />
                  </label>
                  <label className="block text-neutral-300">
                    Blessures / limitations
                    <input
                      className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                      value={profileForm.injury_notes}
                      onChange={(e) =>
                        setProfileForm((p) => ({ ...p, injury_notes: e.target.value }))
                      }
                      placeholder="Optionnel"
                    />
                  </label>
                </div>
              </details>

              {/* 6. Gestion du compte */}
              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  Gestion du compte
                </p>
                <p className="text-sm text-neutral-200">
                  <span className="text-neutral-500">Email : </span>
                  {session?.user?.email ?? "—"}
                </p>
                <div className="mt-3 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => void signOut({ callbackUrl: "/login" })}
                    className="rounded-xl border border-white/15 bg-white/5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
                  >
                    Me déconnecter
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      router.push(
                        session?.user?.email
                          ? `/reset-password?email=${encodeURIComponent(session.user.email)}`
                          : "/reset-password"
                      )
                    }
                    className="rounded-xl border border-white/15 bg-white/5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
                  >
                    Changer de mot de passe
                  </button>
                  {!profileDeleteExpanded ? (
                    <button
                      type="button"
                      onClick={() => {
                        setProfileDeleteExpanded(true);
                        setDeleteAccountError(null);
                      }}
                      className="rounded-xl border border-red-500/35 bg-red-500/10 py-2.5 text-sm font-semibold text-red-200 transition hover:bg-red-500/20"
                    >
                      Supprimer mon compte
                    </button>
                  ) : (
                    <div className="space-y-3 rounded-xl border border-red-500/35 bg-red-500/5 p-3">
                      <p className="text-xs leading-snug text-red-200/90">
                        Suppression définitive du compte et des données. Saisis ton mot de passe actuel pour
                        confirmer.
                      </p>
                      <label className="block text-xs text-neutral-400">
                        Mot de passe
                        <input
                          type="password"
                          autoComplete="current-password"
                          value={deleteAccountPassword}
                          onChange={(e) => {
                            setDeleteAccountPassword(e.target.value);
                            setDeleteAccountError(null);
                          }}
                          className="mt-1 w-full rounded-xl border border-red-500/25 bg-[#2a2a2a] px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-red-500/50"
                          placeholder="Ton mot de passe"
                        />
                      </label>
                      {deleteAccountError ? (
                        <p className="text-sm text-red-400">{deleteAccountError}</p>
                      ) : null}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setProfileDeleteExpanded(false);
                            setDeleteAccountPassword("");
                            setDeleteAccountError(null);
                          }}
                          className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm font-semibold text-white transition hover:bg-white/5"
                        >
                          Annuler
                        </button>
                        <button
                          type="button"
                          disabled={deleteAccountLoading || !deleteAccountPassword.trim()}
                          onClick={() => void deleteAccount()}
                          className="flex-1 rounded-xl border border-red-500/50 bg-red-500/20 py-2.5 text-sm font-semibold text-red-100 transition hover:bg-red-500/30 disabled:opacity-60"
                        >
                          {deleteAccountLoading ? "Suppression…" : "Supprimer définitivement"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            {profileSaveError && (
              <p className="mt-3 text-sm text-red-400">{profileSaveError}</p>
            )}
            <button
              type="button"
              onClick={saveProfile}
              className="mt-5 w-full rounded-2xl bg-[#e67e22] py-3 font-semibold text-white hover:brightness-110"
            >
              Enregistrer
            </button>
          </div>
        </div>
      )}

      {rankingHistoryPortalReady && showRankingHistoryModal
        ? createPortal(
            <div
              className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/70 p-4 sm:items-center"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ranking-history-title"
            >
              <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#1e1e1e] shadow-2xl">
                <div className="flex shrink-0 items-center justify-between border-b border-white/10 p-4">
                  <h3 id="ranking-history-title" className="text-lg font-bold text-white">
                    Historique des classements
                  </h3>
                  <button
                    type="button"
                    onClick={() => setShowRankingHistoryModal(false)}
                    className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="min-h-0 overflow-y-auto p-4 text-sm">
                  <p className="mb-3 text-xs leading-relaxed text-neutral-400">
                    Période affichée : depuis ta <strong className="text-neutral-300">première connexion sur Ace</strong>{" "}
                    (ou le premier mois avec des matchs au palmarès), jusqu&apos;au mois en cours — pas de mois vides
                    avant. L&apos;historique <strong className="text-neutral-300">officiel</strong> mois par mois reste
                    sur <strong className="text-neutral-300">FFT</strong> et{" "}
                    <strong className="text-neutral-300">Ten&apos;Up</strong>. Ci-dessous : ton{" "}
                    <strong className="text-neutral-300">palmarès dans Ace</strong>, la somme des points enregistrés par
                    mois, et une <strong className="text-neutral-300">projection d&apos;échelon indicative</strong>{" "}
                    (même barème que le tableau de bord ; peut différer des « Points » Ace si le moteur applique
                    capital / fenêtre 12 mois autrement que la simple somme des Δ palmarès).
                  </p>
                  <RankingCumulativeChart values={rankingHistoryRows.map((r) => r.cumulative)} />
                  <div className="overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full min-w-[420px] border-collapse text-left text-xs">
                  <thead className="sticky top-0 bg-[#262626] text-[11px] uppercase tracking-wide text-neutral-400">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Mois</th>
                      <th className="px-3 py-2 font-semibold">Matchs</th>
                      <th className="px-3 py-2 font-semibold">Δ pts</th>
                      <th className="px-3 py-2 font-semibold">Cumul</th>
                      <th className="px-3 py-2 font-semibold">Proj.</th>
                    </tr>
                  </thead>
                  <tbody className="text-neutral-200">
                    {rankingHistoryRows.map((r) => (
                      <tr key={r.monthEnd} className="border-t border-white/[0.06]">
                        <td className="px-3 py-2 font-medium text-white">{r.monthLabel}</td>
                        <td className="px-3 py-2 tabular-nums text-neutral-300">
                          {r.matchCount === 0
                            ? "—"
                            : `${r.matchCount} (${r.wins} V)`}
                        </td>
                        <td className={`px-3 py-2 tabular-nums ${r.deltaMonth > 0 ? "text-[#86f7b4]" : r.deltaMonth < 0 ? "text-red-300/90" : "text-neutral-500"}`}>
                          {r.deltaMonth > 0 ? "+" : ""}
                          {r.deltaMonth}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{r.cumulative}</td>
                        <td className="px-3 py-2 font-semibold text-white">{r.projected}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
                    Échelon saisi (profil) :{" "}
                    <strong className="text-neutral-300">{profileForm.current_ranking.trim() || "—"}</strong>
                    {" · "}Projection Ace (points moteur) :{" "}
                    <strong className="text-neutral-300">
                      {dashboard?.profile.projected_ranking_from_points ?? "—"}
                    </strong>
                    {" · "}Points Ace :{" "}
                    <strong className="text-neutral-300">{dashboard?.profile.current_points ?? "—"}</strong>
                  </p>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {/* Création du premier match (état sans match à venir) */}
      {showCreateMatchModal && (
        <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Ajouter mon prochain match</h3>
              <button
                type="button"
                onClick={() => {
                  setShowCreateMatchModal(false);
                  setCreateMatchError(null);
                }}
                className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-4 text-xs text-neutral-400">
              Indique la date, l&apos;heure, le lieu et l&apos;adversaire. Tu pourras affiner les clés du match avec
              Ace ensuite.
            </p>
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-neutral-300">
                  Date
                  <input
                    type="date"
                    value={createMatchForm.date}
                    onChange={(e) => setCreateMatchForm((p) => ({ ...p, date: e.target.value }))}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  />
                </label>
                <label className="text-neutral-300">
                  Heure
                  <input
                    type="time"
                    value={createMatchForm.time}
                    onChange={(e) => setCreateMatchForm((p) => ({ ...p, time: e.target.value }))}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  />
                </label>
              </div>
              <label className="block text-neutral-300">
                Surface (ex. Terre battue, Dur intérieur…)
                <input
                  value={createMatchForm.surface}
                  onChange={(e) => setCreateMatchForm((p) => ({ ...p, surface: e.target.value }))}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  placeholder="Optionnel"
                />
              </label>
              <label className="block text-neutral-300">
                Format
                <select
                  value={createMatchForm.match_format}
                  onChange={(e) => setCreateMatchForm((p) => ({ ...p, match_format: e.target.value }))}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                >
                  {MATCH_FORMAT_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-neutral-300">
                Lieu / club
                <input
                  value={createMatchForm.club_location}
                  onChange={(e) => setCreateMatchForm((p) => ({ ...p, club_location: e.target.value }))}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  placeholder="Optionnel"
                />
              </label>
              <div className="border-t border-white/10 pt-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Adversaire
                </p>
                <label className="block text-neutral-300">
                  Nom
                  <input
                    value={createMatchForm.opponent_name}
                    onChange={(e) => setCreateMatchForm((p) => ({ ...p, opponent_name: e.target.value }))}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                    placeholder="Optionnel"
                  />
                </label>
                <label className="mt-2 block text-neutral-300">
                  Classement
                  <input
                    value={createMatchForm.opponent_ranking}
                    onChange={(e) => setCreateMatchForm((p) => ({ ...p, opponent_ranking: e.target.value }))}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                    placeholder="ex. 30/1"
                    list="echelons-list-match-create"
                  />
                </label>
                <datalist id="echelons-list-match-create">
                  {FFT_ECHELONS.map((e) => (
                    <option key={e} value={e} />
                  ))}
                </datalist>
                <label className="mt-2 block text-neutral-300">
                  Style de jeu
                  <input
                    value={createMatchForm.opponent_style}
                    onChange={(e) => setCreateMatchForm((p) => ({ ...p, opponent_style: e.target.value }))}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                    placeholder="Optionnel"
                  />
                </label>
                <label className="mt-2 block text-neutral-300">
                  Notes
                  <textarea
                    value={createMatchForm.opponent_notes}
                    onChange={(e) => setCreateMatchForm((p) => ({ ...p, opponent_notes: e.target.value }))}
                    rows={2}
                    className="mt-1 w-full resize-none rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                    placeholder="Optionnel"
                  />
                </label>
              </div>
              {createMatchError ? <p className="text-sm text-red-400">{createMatchError}</p> : null}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateMatchModal(false);
                    setCreateMatchError(null);
                  }}
                  className="flex-1 rounded-2xl border border-white/15 py-3 text-sm font-semibold text-white hover:bg-white/5"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={() => void saveCreateMatch()}
                  className="flex-1 rounded-2xl bg-[#e67e22] py-3 text-sm font-semibold text-white hover:brightness-110"
                >
                  Enregistrer le match
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Édition date / lieu / format du match à venir */}
      {showMatchTimingEdit && (
        <div className="fixed inset-0 z-[56] flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Modifier le match</h3>
              <button
                type="button"
                onClick={() => {
                  setShowMatchTimingEdit(false);
                  setMatchTimingSaveError(null);
                }}
                className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-4 text-xs text-neutral-400">
              Date, heure, surface, format et lieu. Les infos adversaire se gèrent depuis le bloc VS (profil
              adverse).
            </p>
            <div className="space-y-3 text-sm">
              <label className="block text-neutral-300">
                Date et heure
                <input
                  type="datetime-local"
                  value={matchTimingValue}
                  onChange={(e) => setMatchTimingValue(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                />
              </label>
              <label className="block text-neutral-300">
                Surface (ex. Terre battue, Dur intérieur…)
                <input
                  value={matchMetaForm.surface}
                  onChange={(e) => setMatchMetaForm((p) => ({ ...p, surface: e.target.value }))}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  placeholder="Optionnel"
                />
              </label>
              <label className="block text-neutral-300">
                Format
                <select
                  value={matchMetaForm.match_format}
                  onChange={(e) =>
                    setMatchMetaForm((p) => ({
                      ...p,
                      match_format: e.target.value,
                      custom_match_format:
                        e.target.value === "Autre (personnalisé)" ? p.custom_match_format : ""
                    }))
                  }
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                >
                  {MATCH_FORMAT_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                  <option value="Autre (personnalisé)">Autre (personnalisé)</option>
                </select>
              </label>
              {matchMetaForm.match_format === "Autre (personnalisé)" && (
                <label className="block text-neutral-300">
                  Format personnalisé
                  <input
                    value={matchMetaForm.custom_match_format}
                    onChange={(e) =>
                      setMatchMetaForm((p) => ({ ...p, custom_match_format: e.target.value }))
                    }
                    className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                    placeholder="Décris le format"
                  />
                </label>
              )}
              <label className="block text-neutral-300">
                Lieu / club
                <input
                  value={matchMetaForm.club_location}
                  onChange={(e) =>
                    setMatchMetaForm((p) => ({ ...p, club_location: e.target.value }))
                  }
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  placeholder="Optionnel"
                />
              </label>
              {matchTimingSaveError ? (
                <p className="text-sm text-red-400">{matchTimingSaveError}</p>
              ) : null}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowMatchTimingEdit(false);
                    setMatchTimingSaveError(null);
                  }}
                  className="flex-1 rounded-2xl border border-white/15 py-3 text-sm font-semibold text-white hover:bg-white/5"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  disabled={matchTimingSaving}
                  onClick={() => void saveMatchTiming()}
                  className="flex-1 rounded-2xl bg-[#e67e22] py-3 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
                >
                  {matchTimingSaving ? "Enregistrement…" : "Enregistrer"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Édition profil adverse (match en cours) */}
      {showScoutModal && (
        <div className="fixed inset-0 z-[57] flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Modifier l&apos;adversaire</h3>
              <button
                type="button"
                onClick={closeScoutModal}
                className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-4 text-xs text-neutral-400">
              Nom, classement, style et notes. Tu peux lier un joueur du catalogue pour préremplir.
            </p>
            <div className="space-y-3 text-sm">
              <label className="block text-neutral-300">
                Rechercher dans le catalogue
                <input
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  value={scoutQuery}
                  onChange={(e) => setScoutQuery(e.target.value)}
                  placeholder="Tape un nom…"
                />
              </label>
              {scoutResults.length > 0 && (
                <div className="max-h-32 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-2">
                  {scoutResults.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setScoutForm((prev) => ({
                          ...prev,
                          opponent_id: p.id,
                          opponent_name: p.display_name,
                          opponent_ranking: p.current_rank || prev.opponent_ranking,
                          opponent_style: p.play_style || prev.opponent_style
                        }));
                        setScoutQuery(p.display_name);
                      }}
                      className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
                    >
                      <span className="font-semibold text-white">{p.display_name}</span>
                      {p.current_rank ? (
                        <span className="ml-2 text-neutral-400">({p.current_rank})</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
              <label className="block text-neutral-300">
                Nom
                <input
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  value={scoutForm.opponent_name}
                  onChange={(e) =>
                    setScoutForm((prev) => ({
                      ...prev,
                      opponent_id: null,
                      opponent_name: e.target.value
                    }))
                  }
                  placeholder="Nom et prénom"
                />
              </label>
              <label className="block text-neutral-300">
                Classement
                <input
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  value={scoutForm.opponent_ranking}
                  onChange={(e) =>
                    setScoutForm((prev) => ({ ...prev, opponent_ranking: e.target.value }))
                  }
                  placeholder="ex. 30/1"
                  list="echelons-list-scout-modal"
                />
              </label>
              <datalist id="echelons-list-scout-modal">
                {FFT_ECHELONS.map((e) => (
                  <option key={e} value={e} />
                ))}
              </datalist>
              <label className="block text-neutral-300">
                Style de jeu
                <input
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  value={scoutForm.opponent_style}
                  onChange={(e) =>
                    setScoutForm((prev) => ({ ...prev, opponent_style: e.target.value }))
                  }
                  placeholder="Optionnel"
                />
              </label>
              <label className="block text-neutral-300">
                Notes
                <textarea
                  rows={2}
                  className="mt-1 w-full resize-none rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  value={scoutForm.opponent_notes}
                  onChange={(e) =>
                    setScoutForm((prev) => ({ ...prev, opponent_notes: e.target.value }))
                  }
                  placeholder="Optionnel"
                />
              </label>
              {scoutSaveError ? <p className="text-sm text-red-400">{scoutSaveError}</p> : null}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeScoutModal}
                  className="flex-1 rounded-2xl border border-white/15 py-3 text-sm font-semibold text-white hover:bg-white/5"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  disabled={scoutSaving || !scoutForm.opponent_name.trim()}
                  onClick={() => void saveScoutInfo()}
                  className="flex-1 rounded-2xl bg-[#e67e22] py-3 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
                >
                  {scoutSaving ? "Enregistrement…" : "Enregistrer"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Palmarès */}
      {showPalmares && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto overscroll-contain bg-black/70 p-4"
          role="presentation"
        >
          <div className="my-auto max-h-[min(90vh,900px)] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Trophy className="h-5 w-5 text-[#e67e22]" />
                <h3 className="text-lg font-bold text-white">Mon palmarès</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowPalmares(false)}
                className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-4 text-xs text-neutral-400">
              Vue homologuée des matchs enregistrés sur les 12 derniers mois.
            </p>
            {palmaresLoading && palmaresDisplayRows.length === 0 ? (
              <p className="text-sm text-neutral-500">Chargement…</p>
            ) : (
              <ul className="mb-5 space-y-2.5">
                {palmaresDisplayRows.length === 0 && (
                  <li className="rounded-xl border border-dashed border-white/15 py-6 text-center text-sm text-neutral-500">
                    Aucun match enregistré dans le palmarès.
                  </li>
                )}
                {palmaresDisplayRows.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-stretch overflow-hidden rounded-2xl border border-white/10 bg-[#262626]"
                  >
                    <div className="flex w-full items-center justify-between px-3 py-3">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                          {new Date(row.match_date).toLocaleDateString("fr-FR", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric"
                          })}
                        </p>
                        <div className="mt-1 flex items-center gap-2">
                          <p className="truncate text-base font-semibold text-white">{row.opponent_label}</p>
                          <span className="rounded-md border border-white/10 bg-[#3d3d3d] px-2 py-0.5 text-[11px] font-semibold text-neutral-100">
                            {row.rank_label}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <span
                            className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                              Number(row.points_delta ?? 0) > 0 ? "bg-[#6fd8a7] text-black" : "bg-[#4b5563] text-neutral-100"
                            }`}
                          >
                            {((row.points_delta ?? 0) >= 0 ? "+" : "") + (row.points_delta ?? 0)} pts
                          </span>
                          <span className="text-[11px] text-neutral-500">{row.source_label}</span>
                        </div>
                      </div>
                      <div className="ml-3 flex items-center gap-2">
                        {row.kind === "manual" && row.manualEntry ? (
                          <>
                            <button
                              type="button"
                              onClick={() => startEditPalmares(row.manualEntry)}
                              className="rounded-lg px-2 py-1 text-xs text-[#e67e22] hover:bg-white/10"
                            >
                              Modifier
                            </button>
                            <button
                              type="button"
                              onClick={() => void deletePalmaresEntry(row.manualEntry.id)}
                              className="rounded-lg p-1.5 text-neutral-500 hover:bg-red-500/20 hover:text-red-400"
                              aria-label="Supprimer"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        ) : (
                          <span className="rounded-lg border border-white/15 px-2 py-1 text-[11px] text-neutral-400">
                            Match suivi
                          </span>
                        )}
                        <div
                          className={`flex h-10 w-10 items-center justify-center rounded-lg text-base font-bold ${
                            row.won ? "bg-[#6fd8a7] text-white" : "bg-[#ef4444] text-white"
                          }`}
                        >
                          {row.won ? "V" : "D"}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  tenupAppendNextParseRef.current = false;
                  resetTenupImportFlow();
                  if (dashboard?.profile) {
                    setTenupCurrentRanking(dashboard.profile.current_ranking ?? "");
                    setTenupTargetRanking(dashboard.profile.target_ranking ?? "");
                    setTenupOriginRanking("");
                  }
                  setShowTenupImport(true);
                }}
                className="flex-1 rounded-2xl border border-white/15 py-3 text-sm font-semibold text-white hover:bg-white/5"
              >
                Importer Ten'Up
              </button>
              <button
                type="button"
                onClick={startCreatePalmares}
                className="flex-1 rounded-2xl bg-[#e67e22] py-3 text-sm font-semibold text-white hover:brightness-110"
              >
                Ajouter un match
              </button>
            </div>
          </div>
        </div>
      )}

      {showTenupImport && (
        <div className="fixed inset-0 z-[62] flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Importer mes captures Ten&apos;Up</h3>
              <button
                type="button"
                onClick={() => {
                  setShowTenupImport(false);
                  resetTenupImportFlow();
                }}
                className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {tenupImportStep === 1 ? (
              <>
                <p className="mb-4 text-xs text-neutral-400">
                  <span className="font-semibold text-neutral-300">Étape 1.</span> Choisis les captures d&apos;écran de
                  ton palmarès Ten&apos;Up, puis lance l&apos;analyse. Les réglages FFT (classements, sexe) se règlent à
                  l&apos;étape suivante si besoin.
                </p>
                {tenupPostParseNotice ? (
                  <div className="mb-4 rounded-2xl border border-[#58d68d]/40 bg-[#58d68d]/15 px-4 py-5 text-center">
                    <p className="text-sm font-semibold text-white">Analyse réussie</p>
                    <p className="mt-1 text-xs text-[#b8f5d0]">
                      Les matchs ont été extraits. Passage à la vérification…
                    </p>
                  </div>
                ) : null}
                <input
                  ref={tenupFileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => void onTenupFilesSelected(e.target.files)}
                />
                <button
                  type="button"
                  disabled={tenupParsing || tenupPostParseNotice}
                  onClick={() => tenupFileInputRef.current?.click()}
                  className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-white/25 bg-black/25 px-4 py-10 text-center transition hover:border-[#e67e22]/60 hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="text-base font-semibold text-white">Sélectionner mes captures</span>
                  <span className="text-[11px] text-neutral-500">PNG, JPG ou WebP — jusqu&apos;à 12 fichiers</span>
                </button>
                {tenupFileNames.length > 0 && !tenupPostParseNotice ? (
                  <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                      Fichiers ({tenupFileNames.length})
                    </p>
                    <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-neutral-200">
                      {tenupFileNames.map((name, i) => (
                        <li key={`${name}-${i}`} className="truncate rounded-md bg-white/5 px-2 py-1.5">
                          {name}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <button
                  type="button"
                  disabled={tenupParsing || tenupFiles.length === 0 || tenupPostParseNotice}
                  onClick={() => void parseTenupCaptures()}
                  className="mt-4 w-full rounded-2xl bg-[#e67e22] py-3.5 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {tenupParsing ? "Analyse en cours…" : "Analyser mes captures"}
                </button>
              </>
            ) : (
              <>
                <p className="mb-3 text-xs text-neutral-400">
                  <span className="font-semibold text-neutral-300">Étape 2.</span> Vérifie les matchs détectés, corrige
                  si nécessaire, puis importe dans ton palmarès Ace.
                </p>
                <p className="mb-1 text-sm font-semibold text-white">
                  {tenupRows.length} match{tenupRows.length > 1 ? "s" : ""} à importer
                </p>

                <details className="mt-3 rounded-xl border border-white/10 bg-black/15 p-3 text-xs open:bg-black/25">
                  <summary className="cursor-pointer font-semibold text-neutral-200">
                    Paramètres utilisés pour le barème des points (optionnel)
                  </summary>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <label className="text-neutral-300">
                      Classement actuel
                      <input
                        className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                        value={tenupCurrentRanking}
                        onChange={(e) => setTenupCurrentRanking(e.target.value)}
                        list="echelons-list-palm"
                        placeholder="ex: 30/2"
                      />
                    </label>
                    <label className="text-neutral-300">
                      Classement objectif
                      <input
                        className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                        value={tenupTargetRanking}
                        onChange={(e) => setTenupTargetRanking(e.target.value)}
                        list="echelons-list-palm"
                        placeholder="ex: 15/5"
                      />
                    </label>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="text-neutral-300">
                      Classement d&apos;origine (capital)
                      <input
                        className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                        value={tenupOriginRanking}
                        onChange={(e) => setTenupOriginRanking(e.target.value)}
                        list="echelons-list-palm"
                        placeholder="par défaut = actuel"
                      />
                    </label>
                    <label className="text-neutral-300">
                      Sexe
                      <select
                        className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                        value={tenupGender}
                        onChange={(e) => setTenupGender((e.target.value as "M" | "F") || "M")}
                      >
                        <option value="M">Homme</option>
                        <option value="F">Femme</option>
                      </select>
                    </label>
                  </div>
                </details>

                <div className="mt-3 max-h-64 space-y-2 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-2">
                  {tenupRows.length === 0 ? (
                    <p className="text-xs text-neutral-500">Aucun match dans la liste.</p>
                  ) : (
                    tenupRows.map((r, idx) => (
                      <div key={`${r.match_date}-${r.opponent_name}-${idx}`} className="rounded-lg bg-white/5 p-2 text-xs">
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="date"
                            max={todayIso}
                            value={String(r.match_date ?? "")}
                            onChange={(e) => updateTenupRow(idx, { match_date: e.target.value })}
                            className="w-full rounded-md border border-white/10 bg-[#2a2a2a] px-2 py-1 text-white"
                          />
                          <input
                            value={String(r.opponent_ranking ?? "")}
                            onChange={(e) => updateTenupRow(idx, { opponent_ranking: e.target.value })}
                            list="echelons-list-palm"
                            className="w-full rounded-md border border-white/10 bg-[#2a2a2a] px-2 py-1 text-white"
                          />
                        </div>
                        <div className="mt-2 grid grid-cols-[1fr_auto_auto] items-center gap-2">
                          <input
                            value={String(r.opponent_name ?? "")}
                            onChange={(e) => updateTenupRow(idx, { opponent_name: e.target.value })}
                            placeholder="Nom adversaire"
                            className="w-full rounded-md border border-white/10 bg-[#2a2a2a] px-2 py-1 text-white"
                          />
                          <select
                            value={r.won ? "v" : "d"}
                            onChange={(e) => updateTenupRow(idx, { won: e.target.value === "v" })}
                            className="rounded-md border border-white/10 bg-[#2a2a2a] px-2 py-1 text-white"
                          >
                            <option value="v">V</option>
                            <option value="d">D</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => removeTenupRow(idx)}
                            className="rounded-md p-1 text-neutral-400 hover:bg-red-500/20 hover:text-red-400"
                            aria-label="Retirer la ligne"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    disabled={tenupParsing || tenupCommitting}
                    onClick={() => {
                      tenupAppendNextParseRef.current = true;
                      setTenupImportStep(1);
                      setTenupFiles([]);
                      setTenupFileNames([]);
                      if (tenupFileInputRef.current) tenupFileInputRef.current.value = "";
                    }}
                    className="flex-1 rounded-2xl border border-white/15 py-3 text-sm font-semibold text-white hover:bg-white/5 disabled:opacity-50"
                  >
                    Ajouter d&apos;autres captures
                  </button>
                  <button
                    type="button"
                    disabled={tenupCommitting || tenupRows.length === 0}
                    onClick={() => void commitTenupImport()}
                    className="flex-1 rounded-2xl bg-[#e67e22] py-3 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {tenupCommitting ? "Import…" : "Importer ces matchs"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showPalmaresForm && (
        <div className="fixed inset-0 z-[61] flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">
                {palmaresEditingId != null ? "Modifier un match" : "Ajouter un match"}
              </h3>
              <button
                type="button"
                onClick={cancelPalmaresEdit}
                className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={submitPalmares} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-neutral-300">
                  Date
                  <input
                    type="date"
                    required
                    max={todayIso}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                    value={palmForm.match_date}
                    onChange={(e) => setPalmForm((p) => ({ ...p, match_date: e.target.value }))}
                  />
                </label>
                <label className="text-neutral-300">
                  Classement adversaire
                  <input
                    className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                    placeholder="ex. 30/2"
                    required
                    list="echelons-list-palm"
                    value={palmForm.opponent_ranking}
                    onChange={(e) => setPalmForm((p) => ({ ...p, opponent_ranking: e.target.value }))}
                  />
                </label>
              </div>
              <label className="block text-neutral-300">
                Rechercher un adversaire existant
                <input
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  value={palmaresQuery}
                  onChange={(e) => setPalmaresQuery(e.target.value)}
                  placeholder="Tape un nom (ex: Kevin Dufresne)"
                />
              </label>
              {palmaresResults.length > 0 && (
                <div className="max-h-32 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-2">
                  {palmaresResults.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setPalmForm((prev) => ({
                          ...prev,
                          opponent_id: p.id,
                          opponent_name: p.display_name,
                          opponent_ranking: p.current_rank || prev.opponent_ranking
                        }));
                        setPalmaresQuery(p.display_name);
                      }}
                      className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
                    >
                      <span className="font-semibold text-white">{p.display_name}</span>
                      {p.current_rank ? <span className="ml-2 text-neutral-400">({p.current_rank})</span> : null}
                    </button>
                  ))}
                </div>
              )}
              <label className="block text-neutral-300">
                Nom et prénom adversaire
                <input
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  value={palmForm.opponent_name}
                  onChange={(e) => setPalmForm((p) => ({ ...p, opponent_id: null, opponent_name: e.target.value }))}
                  placeholder="ex: Kevin Dufresne"
                />
              </label>
              <datalist id="echelons-list-palm">
                {FFT_ECHELONS.map((ec) => (
                  <option key={ec} value={ec} />
                ))}
              </datalist>
              <label className="flex items-center gap-2 text-neutral-300">
                <span>Résultat</span>
                <select
                  className="rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  value={palmForm.won ? "v" : "d"}
                  onChange={(e) => setPalmForm((p) => ({ ...p, won: e.target.value === "v" }))}
                >
                  <option value="v">Victoire</option>
                  <option value="d">Défaite</option>
                </select>
              </label>
              <label className="block text-neutral-300">
                Notes (optionnel)
                <input
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                  value={palmForm.notes}
                  onChange={(e) => setPalmForm((p) => ({ ...p, notes: e.target.value }))}
                />
              </label>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={cancelPalmaresEdit}
                  className="flex-1 rounded-xl border border-white/15 py-2 text-sm text-white hover:bg-white/5"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="flex-1 rounded-xl bg-[#e67e22] py-2 text-sm font-semibold text-white hover:brightness-110"
                >
                  {palmaresEditingId != null ? "Mettre à jour" : "Ajouter"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Simulateur */}
      {showSimulate && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Simulation de points</h3>
              <button
                type="button"
                onClick={() => {
                  setShowSimulate(false);
                  setSimResult(null);
                }}
                className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-4 text-xs text-neutral-400">
              Ajoute des matchs fictifs pour découvrir ton futur classement
            </p>
            <div className="max-h-48 space-y-2 overflow-y-auto">
              {hypoRows.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <div className="min-w-0 flex-1">
                    <EchelonSelect
                      className="mt-0 px-2 py-2 text-sm"
                      value={row.opponent_ranking}
                      onChange={(v) => {
                        const next = [...hypoRows];
                        next[i] = { ...next[i], opponent_ranking: v };
                        setHypoRows(next);
                      }}
                      placeholder="Échelon adversaire"
                    />
                  </div>
                  <select
                    className="rounded-xl border border-white/10 bg-[#2a2a2a] px-2 text-sm text-white"
                    value={row.won ? "v" : "d"}
                    onChange={(e) => {
                      const next = [...hypoRows];
                      next[i] = { ...next[i], won: e.target.value === "v" };
                      setHypoRows(next);
                    }}
                  >
                    <option value="v">V</option>
                    <option value="d">D</option>
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      setHypoRows((prev) =>
                        prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)
                      )
                    }
                    className="rounded-xl border border-white/10 bg-[#2a2a2a] px-2 text-neutral-300 hover:bg-red-500/20 hover:text-red-300"
                    aria-label="Retirer ce match"
                    title="Retirer ce match"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setHypoRows([...hypoRows, { opponent_ranking: "", won: true }])}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[#e67e22] hover:underline"
            >
              <Plus className="h-3 w-3" /> Ajouter un match
            </button>
            <button
              type="button"
              disabled={simLoading}
              onClick={runSimulate}
              className="mt-4 w-full rounded-2xl bg-[#e67e22] py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {simLoading ? "Calcul…" : "Lancer la simulation"}
            </button>
            {simResult && !("error" in simResult && simResult.error) && (
              <div className="mt-4 space-y-3 rounded-2xl border border-white/10 bg-gradient-to-b from-[#2c2c2c] to-[#1f1f1f] p-4 text-neutral-100">
                <div className="rounded-xl border border-[#58d68d]/30 bg-[#58d68d]/10 p-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-300">
                        Classement obtenu
                      </p>
                      <p className="mt-2 text-xs text-neutral-300">
                        {String((simResult as Record<string, unknown>).projected_points_cumules ?? "—")} cumulés pour{" "}
                        {String((simResult as Record<string, unknown>).projected_points_minimum ?? "—")} nécessaires
                        {" "}
                        (
                        {(() => {
                          const c = Number((simResult as Record<string, unknown>).projected_points_cumules ?? 0);
                          const m = Number((simResult as Record<string, unknown>).projected_points_minimum ?? 0);
                          const d = c - m;
                          return `${d >= 0 ? "+" : ""}${d}`;
                        })()}
                        )
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Classement</p>
                      <p className="mt-1 text-3xl font-extrabold leading-none text-[#9cffbd]">
                        {String((simResult as Record<string, unknown>).projected_label ?? "—")}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-neutral-400">Classement du dessus</p>
                    <p className="mt-2 text-base font-semibold text-[#e67e22]">
                      {String((simResult as Record<string, unknown>).points_to_next_label ?? "—")} pts manquants pour passer{" "}
                      {String((simResult as Record<string, unknown>).next_label ?? "—")}
                    </p>
                    {typeof (simResult as Record<string, unknown>).next_perf_hint === "object" &&
                      (simResult as Record<string, unknown>).next_perf_hint != null && (
                        <p className="mt-2 text-[11px] text-neutral-400">
                          {String(
                            ((simResult as Record<string, unknown>).next_perf_hint as Record<string, unknown>).text ?? ""
                          )}
                        </p>
                      )}
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-neutral-400">Taux de victoire</p>
                    <div className="mt-2 flex items-center gap-3">
                      {(() => {
                        const pctRaw = Number((simResult as Record<string, unknown>).projected_win_rate_pct ?? 0);
                        const pct = Math.max(0, Math.min(100, pctRaw));
                        const r = 26;
                        const c = 2 * Math.PI * r;
                        const offset = c * (1 - pct / 100);
                        return (
                          <svg width="70" height="70" viewBox="0 0 70 70" className="shrink-0">
                            <circle cx="35" cy="35" r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="8" />
                            <circle
                              cx="35"
                              cy="35"
                              r={r}
                              fill="none"
                              stroke="#60a5fa"
                              strokeWidth="8"
                              strokeLinecap="round"
                              strokeDasharray={c}
                              strokeDashoffset={offset}
                              transform="rotate(-90 35 35)"
                            />
                            <text x="35" y="39" textAnchor="middle" fontSize="14" fontWeight="700" fill="#dbeafe">
                              {pct.toFixed(0)}%
                            </text>
                          </svg>
                        );
                      })()}
                      <div>
                        <p className="text-sm font-semibold text-white">
                          {String((simResult as Record<string, unknown>).projected_matches_count ?? "—")} matchs
                        </p>
                        <p className="text-xs text-neutral-400">pris en compte</p>
                      </div>
                    </div>
                  </div>
                </div>
                <p className="text-[11px] text-neutral-500">
                  {String((simResult as Record<string, unknown>).disclaimer ?? "")}
                </p>
              </div>
            )}
            {simResult &&
 typeof simResult === "object" &&
              "error" in simResult &&
              simResult.error != null && (
                <p className="mt-3 text-sm text-red-400">
                  {String(simResult.error as string)}
                </p>
              )}
          </div>
        </div>
      )}

      {/* Programme complet */}
      {showProgramFull && dashboard && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="flex h-[min(85vh,640px)] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#1e1e1e] p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <h3 className="min-w-0 font-bold leading-snug text-white">Programme jusqu’au match</h3>
              <div className="flex shrink-0 items-center gap-0.5">
                {dashboard.match ? (
                  <button
                    type="button"
                    onClick={() => {
                      setShowProgramFull(false);
                      openMatchEditor();
                    }}
                    className="rounded-lg px-2 py-1 text-[11px] font-medium text-neutral-500 transition hover:bg-white/5 hover:text-neutral-300"
                  >
                    Revoir le programme
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setShowProgramFull(false)}
                  className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
                  aria-label="Fermer"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div
              className={`flex flex-wrap gap-2 ${programDayStory.band ? "mb-2" : "mb-6"}`}
            >
              {weekDates.map((d) => {
                const day = new Date(`${d}T00:00:00`).toLocaleDateString("fr-FR", {
                  weekday: "short"
                });
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setSelectedProgramDay(d)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase transition ${
                      selectedProgramDay === d
                        ? "bg-[#e67e22] text-white"
                        : "border border-white/20 text-neutral-300 hover:bg-white/10"
                    }`}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
            {programDayStory.band ? (
              <div className="mb-6 shrink-0 rounded-2xl border border-[#e67e22]/30 bg-[#e67e22]/10 px-3 py-2">
                <p className="line-clamp-1 text-[13px] font-bold uppercase leading-tight tracking-wide text-[#ffbe84]">
                  {programDayStory.band}
                </p>
                <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-neutral-400">
                  {programDayStory.why}
                </p>
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="space-y-6">
              {(programByDate.get(selectedProgramDay) ?? []).length === 0 && (
                <p className="rounded-xl border border-dashed border-white/15 px-3 py-5 text-center text-sm text-neutral-500">
                  Aucune tâche prévue pour ce jour.
                </p>
              )}
              {(programByDate.get(selectedProgramDay) ?? []).map((t) => {
                const objectivePrev = taskObjectivePreview(t.description);
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-label={`Ouvrir le détail : ${t.title}`}
                    onClick={() => {
                      setTaskModalView("full");
                      setTaskFeedbackChoice(null);
                      setTaskFeedbackNote("");
                      setTaskDetailAllowActions(false);
                      setTaskDetail(t);
                    }}
                    className={cn(
                      "w-full rounded-xl border-l-4 bg-[#2a2a2a] px-3 py-3 text-left text-sm text-neutral-200 outline-none transition hover:bg-[#323232] focus-visible:ring-2 focus-visible:ring-[#e67e22]/50",
                      taskTypeStyles(t).border
                    )}
                  >
                    <p className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase">
                      <span className={`h-2 w-2 rounded-full ${taskTypeStyles(t).dot}`} />
                      <span className={taskTypeStyles(t).label}>{TASK_TYPE_LABEL[t.task_type] ?? TASK_TYPE_LABEL.technique}</span>
                      <span className="text-neutral-500">•</span>
                      <span className="text-neutral-400">{t.duration_min || 30} min</span>
                    </p>
                    <p className="text-sm font-medium text-white">{t.title}</p>
                    {objectivePrev ? (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-neutral-400">{objectivePrev}</p>
                    ) : null}
                  </button>
                );
              })}
              </div>
            </div>
          </div>
        </div>
      )}

      {showAddTaskModal && (
        <div className="fixed inset-0 z-[58] flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="max-h-[min(90vh,560px)] w-full max-w-md overflow-y-auto rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Ajouter une tâche</h3>
              <button
                type="button"
                onClick={() => {
                  setShowAddTaskModal(false);
                  setAddTaskError(null);
                }}
                className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {addTaskStep === "intent" ? (
              <div className="space-y-3">
                <label className="block text-sm text-neutral-300">
                  Que veux-tu faire ?
                  <textarea
                    value={addTaskIntent}
                    onChange={(e) => setAddTaskIntent(e.target.value)}
                    rows={4}
                    disabled={addTaskLoading}
                    placeholder="ex : J'aimerais travailler mon service"
                    className="mt-1 w-full resize-none rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-sm text-white placeholder:text-neutral-600"
                  />
                </label>
                {addTaskError ? <p className="text-sm text-red-400">{addTaskError}</p> : null}
                <button
                  type="button"
                  onClick={() => void runSuggestForAddTask()}
                  disabled={addTaskLoading || addTaskIntent.trim().length < 2}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#e67e22] py-3 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
                >
                  {addTaskLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Ace prépare des idées…
                    </>
                  ) : (
                    "Voir des suggestions d’Ace"
                  )}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-neutral-400">Choisis une proposition (même format que tes autres tâches) :</p>
                {addTaskError ? <p className="text-sm text-red-400">{addTaskError}</p> : null}
                <ul className="space-y-2">
                  {addTaskSuggestions.map((s, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => void confirmManualTask(s)}
                        disabled={addTaskLoading}
                        className="w-full rounded-xl border border-white/10 bg-[#2a2a2a] p-3 text-left transition hover:border-[#e67e22]/50 hover:bg-[#333] disabled:opacity-50"
                      >
                        <p className="text-sm font-semibold text-white">{s.title}</p>
                        <p className="mt-1 text-[11px] text-neutral-500">
                          {TASK_TYPE_LABEL[(s.task_type as ProgramTask["task_type"]) ?? "technique"] ?? s.task_type} · {s.duration_min} min
                        </p>
                        <p className="mt-2 line-clamp-3 text-xs text-neutral-400">
                          {s.description.replace(/#{1,3}\s*[^\n]+\n/g, " ").replace(/\s+/g, " ").trim()}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setAddTaskStep("intent");
                      setAddTaskError(null);
                    }}
                    disabled={addTaskLoading}
                    className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm text-white hover:bg-white/5"
                  >
                    Modifier mon idée
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showStaff && (
        <div className="fixed inset-0 z-[56] flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Mon Staff</h3>
              <button
                type="button"
                onClick={() => setShowStaff(false)}
                className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-4 text-xs text-neutral-400">
              Désactive un pôle pour empêcher Ace de générer ce type de tâches.
            </p>
            <div className="space-y-2">
              {(["technique", "physical", "mental", "nutrition", "recovery"] as const).map((k) => (
                <label
                  key={k}
                  className="flex items-center justify-between rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-sm text-white"
                >
                  <span>{TASK_TYPE_LABEL[k]}</span>
                  <input
                    type="checkbox"
                    checked={!!staffPoles[k]}
                    onChange={(e) =>
                      void saveStaffPoles({ ...staffPoles, [k]: e.target.checked })
                    }
                    className="h-4 w-4 accent-[#e67e22]"
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {taskDetail && (
        <div className="fixed inset-0 z-[57] flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-1.5 text-[10px] font-bold uppercase tracking-[0.12em]">
                  <span
                    className={`inline-flex items-center gap-1.5 ${taskTypeStyles(taskDetail).label}`}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${taskTypeStyles(taskDetail).dot}`} />
                    {TASK_TYPE_LABEL[taskDetail.task_type] ?? TASK_TYPE_LABEL.technique}
                  </span>
                  <span className="text-neutral-500">•</span>
                  <span className="font-semibold text-neutral-400">
                    {taskDetail.duration_min || 30} min
                  </span>
                </p>
                <h3 className="mt-1.5 text-lg font-bold leading-snug text-white">{taskDetail.title}</h3>
                {taskModalView === "feedback" && taskDetailActionsEnabled && taskDetail.status !== "done" ? (
                  <p className="mt-2 text-sm text-neutral-400">
                    Indique comment tu as vécu cette séance. Tu peux préciser en une phrase ci-dessous après
                    avoir choisi une option.
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => {
                  setTaskDetailAllowActions(false);
                  setTaskDetail(null);
                  setTaskFeedbackChoice(null);
                  setTaskFeedbackNote("");
                  setTaskModalView("full");
                }}
                className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {(taskModalView === "full" || !taskDetailActionsEnabled) ? (
              <div
                className={cn(
                  "space-y-1 rounded-2xl border border-white/10 border-l-4 bg-[#252525] p-4",
                  taskTypeStyles(taskDetail).border
                )}
              >
                {renderMarkdownTaskDescription(
                  taskDetail.description ||
                    "## Objectif\nMieux préparer ta séance.\n## Protocole\n1. Exécute la tâche avec concentration.\n2. Respecte la durée prévue.\n3. Observe ton ressenti.\n## Le Tip de Ace\nGarde une intensité régulière plutôt qu’un départ trop fort."
                )}
              </div>
            ) : null}

            {taskDetailActionsEnabled ? (
              <>
            <div className="mt-4 rounded-2xl border border-[#e67e22]/25 bg-gradient-to-br from-[#e67e22]/10 to-transparent p-4">
              <p className="text-sm font-semibold text-white">C&apos;était comment ?</p>
              <p className="mt-1 text-xs text-neutral-400">
                Un clic suffit — ça calibre ton prochain programme. Optionnel mais précieux pour Ace.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {TASK_FEEDBACK_OPTIONS.map((opt) => {
                  const active = taskFeedbackChoice === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      disabled={taskFeedbackLoading}
                      onClick={() =>
                        setTaskFeedbackChoice((c) => {
                          const next = c === opt.id ? null : opt.id;
                          if (next === null) setTaskFeedbackNote("");
                          return next;
                        })
                      }
                      className={`flex flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 text-center text-xs font-semibold transition disabled:opacity-50 ${
                        active
                          ? "border-[#e67e22] bg-[#e67e22]/25 text-white shadow-[0_0_20px_rgba(230,126,34,0.25)]"
                          : "border-white/15 bg-[#2a2a2a] text-neutral-200 hover:border-white/25 hover:bg-white/5"
                      }`}
                    >
                      <span className="text-xl leading-none" aria-hidden>
                        {opt.emoji}
                      </span>
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
              {taskFeedbackChoice ? (
                <label className="mt-3 block text-xs text-neutral-400">
                  Précise ton ressenti (optionnel)
                  <textarea
                    value={taskFeedbackNote}
                    onChange={(e) => setTaskFeedbackNote(e.target.value)}
                    rows={2}
                    disabled={taskFeedbackLoading}
                    placeholder="ex. un peu court, trop dense, j’ai adoré le protocole…"
                    className="mt-1.5 w-full resize-none rounded-xl border border-white/10 bg-[#1a1a1a] px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-[#e67e22]/40"
                  />
                </label>
              ) : null}
            </div>

            {taskDetail.status !== "done" ? (
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={() => {
                    const t = taskDetail;
                    setTaskDetailAllowActions(false);
                    setTaskDetail(null);
                    setTaskFeedbackChoice(null);
                    setTaskFeedbackNote("");
                    setTaskModalView("full");
                    setTaskEdit(t);
                  }}
                  disabled={taskFeedbackLoading}
                  className="flex-1 rounded-2xl border border-white/15 py-3 text-sm font-semibold text-white transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Reporter la tâche
                </button>
                <button
                  type="button"
                  onClick={() => void handleTaskModalComplete()}
                  disabled={taskFeedbackLoading}
                  className="flex-1 rounded-2xl bg-[#e67e22] py-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
                >
                  {taskFeedbackChoice ? "Valider avec mon ressenti" : "Valider la tâche"}
                </button>
              </div>
            ) : (
              <div className="mt-5 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setTaskDetailAllowActions(false);
                    setTaskDetail(null);
                    setTaskFeedbackChoice(null);
                    setTaskFeedbackNote("");
                    setTaskModalView("full");
                  }}
                  className="flex-1 rounded-2xl border border-white/15 py-3 text-sm font-semibold text-white hover:bg-white/5"
                >
                  Fermer
                </button>
                <button
                  type="button"
                  onClick={() => void handleTaskModalComplete()}
                  disabled={taskFeedbackLoading || !taskFeedbackChoice}
                  className="flex-1 rounded-2xl bg-[#e67e22] py-3 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
                >
                  Enregistrer le ressenti
                </button>
              </div>
            )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {taskEdit && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#1e1e1e] p-6">
            <h3 className="font-bold text-white">Modifier la tâche</h3>
            <p className="mt-1 text-sm text-neutral-400">{taskEdit.title}</p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void deleteTask(taskEdit)}
                className="rounded-xl border border-red-500/40 py-2 text-sm text-red-300 hover:bg-red-500/10"
              >
                Supprimer
              </button>
              <label className="text-sm text-neutral-300">
                Reporter à
                <select
                  value={taskEditDate}
                  onChange={(e) => setTaskEditDate(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                >
                  {weekDatesFromToday
                    .filter((d) => d !== taskEdit.task_date)
                    .map((d) => {
                    const label = new Date(`${d}T00:00:00`).toLocaleDateString("fr-FR", {
                      weekday: "long",
                      day: "numeric",
                      month: "short"
                    });
                    return (
                      <option key={d} value={d}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void patchTask(taskEdit, { task_date: taskEditDate, status: "pending" })}
                className="rounded-xl border border-white/10 py-2 text-sm text-white hover:bg-white/5"
              >
                Valider le report
              </button>
              <button
                type="button"
                onClick={() => setTaskEdit(null)}
                className="mt-2 text-sm text-neutral-500 underline"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ace — pastille bas-droite + panneau latéral (type Cursor) */}
      {chatExpanded && (
        <button
          type="button"
          aria-label="Fermer l’arrière-plan du chat"
          className="fixed inset-0 z-[47] cursor-default bg-black/55 backdrop-blur-[1px] transition-opacity"
          onClick={() => setChatExpanded(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 right-0 z-[48] flex w-full max-w-[420px] flex-col border-l border-white/10 bg-[#141414] shadow-[-12px_0_48px_rgba(0,0,0,0.45)] transition-transform duration-300 ease-out md:max-w-[440px] ${
          chatExpanded ? "translate-x-0" : "pointer-events-none translate-x-full"
        }`}
        aria-hidden={!chatExpanded}
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#e67e22]/15">
              <Bot className="h-5 w-5 text-[#e67e22]" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">Ace</p>
              <p className="truncate text-[11px] text-neutral-500">Coach — ton programme & ton match</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setChatExpanded(false)}
            className="shrink-0 rounded-lg p-2 text-neutral-400 transition hover:bg-white/10 hover:text-white"
            aria-label="Fermer le chat"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="space-y-3">
            {messages.map((m, i) => {
              const matchSheetCtas =
                m.role === "assistant" && !m.inlineActionsDismissed
                  ? inferMatchSheetUpdateCta(m.text)
                  : [];
              return (
              <div
                key={i}
                className={`flex gap-2 text-sm ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {m.role === "assistant" && (
                  <Bot className="mt-0.5 h-4 w-4 shrink-0 text-[#e67e22]" />
                )}
                <div
                  className={`max-w-[90%] rounded-2xl px-3.5 py-2 leading-relaxed ${
                    m.role === "user"
                      ? "bg-[#e67e22] text-white"
                      : "bg-[#252525] text-neutral-100"
                  }`}
                >
                  {m.role === "assistant" ? (
                    <ChatMarkdown text={m.text} />
                  ) : (
                    <span className="whitespace-pre-wrap">{m.text}</span>
                  )}
                  {matchSheetCtas.length > 0 && (
                    <div className="mt-3 border-t border-white/10 pt-2.5">
                      <div className="flex flex-wrap gap-2">
                        {matchSheetCtas.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            disabled={isLoading}
                            className={cn(buttonPrimary, "px-3 py-1.5 text-xs")}
                            onClick={() => void executeInlineChatAction(i, a)}
                          >
                            {a.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
            })}
            {isLoading && (
              <p className="flex items-center gap-2 text-xs text-neutral-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#e67e22]" />
                Ace réfléchit…
              </p>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="shrink-0 border-t border-white/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {planningComposerCta && (
            <div className="mb-2">
              <button
                type="button"
                disabled={isLoading || isBootstrapping}
                className="w-full rounded-full border-2 border-[#e67e22] bg-transparent px-4 py-2.5 text-center text-[12px] font-semibold leading-snug text-neutral-100 transition hover:bg-[#e67e22]/12 disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => void executePlanningComposerCta(planningComposerCta)}
              >
                {planningComposerCta.label}
              </button>
            </div>
          )}
          {!hasInput && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() =>
                  openChat(
                    "L'utilisateur veut ajuster son programme du jour ou jusqu'au match. Propose des changements concrets et mets à jour les tâches après confirmation.",
                    { contextType: "program_adjustment", moduleTag: "program_adjustment" }
                  )
                }
                className="rounded-full border border-white/20 bg-black/30 px-2.5 py-1.5 text-[11px] font-semibold text-white/95 transition hover:bg-white/10"
              >
                Ajuster mon programme
              </button>
              <button
                type="button"
                onClick={() =>
                  openChat(
                    "L'utilisateur veut revoir son objectif de classement et ses points. Conseille avec le rappel mensuel FFT.",
                    { contextType: "general", moduleTag: null }
                  )
                }
                className="rounded-full border border-white/20 bg-black/30 px-2.5 py-1.5 text-[11px] font-semibold text-white/95 transition hover:bg-white/10"
              >
                Revoir mon objectif
              </button>
              <button
                type="button"
                onClick={() => {
                  openManualTaskSuggestionModal();
                  setChatExpanded(true);
                }}
                className="rounded-full border border-[#e67e22]/50 bg-black/30 px-2.5 py-1.5 text-[11px] font-semibold text-[#f4d4bc] transition hover:bg-[#e67e22]/15"
              >
                Ajouter une tâche
              </button>
            </div>
          )}
          <form
            onSubmit={onSubmit}
            className="flex items-end gap-2 rounded-2xl border border-white/12 bg-[#1a1a1a] px-3 py-2"
          >
            <textarea
              ref={chatTextareaRef}
              value={input}
              onChange={(e) => {
                if (chatDictationActiveRef.current && dictationModeRef.current === "live") {
                  stopChatDictation();
                }
                setInput(e.target.value);
              }}
              onFocus={() => setChatExpanded(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Message à Ace…"
              rows={1}
              autoComplete="off"
              className="min-h-[2.5rem] max-h-[10rem] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-2 text-sm leading-snug text-white placeholder:text-neutral-500 outline-none"
            />
            <button
              type="button"
              disabled={isLoading || isBootstrapping || chatDictationTranscribing}
              onClick={() => {
                if (chatDictationActiveRef.current) {
                  if (dictationModeRef.current === "record") {
                    stopChatDictation({ discardTranscription: false });
                  } else {
                    stopChatDictation();
                  }
                } else {
                  void startChatDictation();
                }
              }}
              aria-label={
                chatDictationTranscribing
                  ? "Transcription en cours"
                  : chatDictationActive
                    ? "Arrêter la dictée vocale"
                    : "Dicter le message"
              }
              aria-busy={chatDictationTranscribing}
              aria-pressed={chatDictationActive || chatDictationTranscribing}
              title={
                chatDictationTranscribing
                  ? "Transcription…"
                  : chatDictationActive
                    ? "Arrêter la dictée"
                    : "Dicter (micro)"
              }
              className={cn(
                "shrink-0 rounded-xl border p-2.5 transition disabled:cursor-not-allowed disabled:opacity-40",
                chatDictationTranscribing
                  ? "border-amber-400/50 bg-amber-500/15 text-amber-100"
                  : chatDictationActive
                    ? "animate-pulse border-red-400/50 bg-red-500/20 text-red-100"
                    : "border-white/15 bg-[#2a2a2a] text-white hover:bg-white/10"
              )}
            >
              {chatDictationTranscribing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </button>
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Envoyer"
              className="shrink-0 rounded-xl bg-[#e67e22] p-2.5 text-white transition disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      </aside>

      {!chatExpanded && (
        <button
          type="button"
          onClick={() => setChatExpanded(true)}
          className="fixed bottom-5 right-5 z-[49] flex h-12 max-w-[calc(100vw-2.5rem)] items-center gap-2 rounded-full border border-white/15 bg-[#e67e22] px-3.5 pr-4 text-white shadow-[0_8px_32px_rgba(0,0,0,0.4)] transition hover:brightness-110 md:bottom-6 md:right-6 md:h-14 md:gap-2.5 md:px-5 md:pr-6"
          aria-label="Parler avec Ace"
        >
          <MessageCircle className="h-5 w-5 shrink-0 md:h-6 md:w-6" />
          <span className="truncate text-sm font-semibold tracking-tight md:text-[15px]">
            Parler avec Ace
          </span>
        </button>
      )}
    </div>
  );
}
