"use client";

/**
 * Flux palmarès (Ten'Up + match manuel) aligné sur le dashboard, pour l'onboarding.
 */

import { Trash2, Trophy, X } from "lucide-react";
import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

import { FFT_ECHELONS } from "@/lib/projected-ranking-from-points";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type CatalogPlayer = {
  id: number;
  display_name: string;
  current_rank: string;
  play_style: string;
  public_notes: string;
};

type TenupParsedRow = Record<string, string | number | boolean | null | undefined>;

function mergeTenupParsedRows(existing: TenupParsedRow[], incoming: TenupParsedRow[]): TenupParsedRow[] {
  const key = (r: TenupParsedRow) =>
    `${String(r.match_date ?? "")}|${String(r.opponent_name ?? "").trim().toLowerCase()}|${r.won ? "v" : "d"}`;
  const seen = new Set(existing.map(key));
  const out = [...existing];
  for (const r of incoming) {
    const k = key(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

type View = "hub" | "tenup" | "manual";

type OnboardingPalmaresFlowProps = {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  currentRanking: string;
  targetRanking: string;
  onDataChanged?: () => void;
};

export function OnboardingPalmaresFlow({
  open,
  onClose,
  sessionId,
  currentRanking,
  targetRanking,
  onDataChanged
}: OnboardingPalmaresFlowProps) {
  const [view, setView] = useState<View>("hub");
  const [hubNotice, setHubNotice] = useState<string | null>(null);

  const tenupAppendNextParseRef = useRef(false);
  const tenupFileInputRef = useRef<HTMLInputElement>(null);
  const [tenupImportStep, setTenupImportStep] = useState<1 | 2>(1);
  const [tenupFiles, setTenupFiles] = useState<string[]>([]);
  const [tenupFileNames, setTenupFileNames] = useState<string[]>([]);
  const [tenupRows, setTenupRows] = useState<TenupParsedRow[]>([]);
  const [tenupCurrentRanking, setTenupCurrentRanking] = useState("");
  const [tenupOriginRanking, setTenupOriginRanking] = useState("");
  const [tenupTargetRanking, setTenupTargetRanking] = useState("");
  const [tenupGender, setTenupGender] = useState<"M" | "F">("M");
  const [tenupParsing, setTenupParsing] = useState(false);
  const [tenupCommitting, setTenupCommitting] = useState(false);
  const [tenupPostParseNotice, setTenupPostParseNotice] = useState(false);

  const todayIso = new Date().toISOString().slice(0, 10);

  const [palmForm, setPalmForm] = useState({
    match_date: todayIso,
    opponent_id: null as number | null,
    opponent_name: "",
    opponent_ranking: "",
    won: true,
    notes: ""
  });
  const [palmaresQuery, setPalmaresQuery] = useState("");
  const [palmaresResults, setPalmaresResults] = useState<CatalogPlayer[]>([]);

  const searchPlayersCatalog = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) return [] as CatalogPlayer[];
    const res = await fetch(`${API}/players-catalog?q=${encodeURIComponent(q)}&limit=8`);
    if (!res.ok) return [];
    const data = (await res.json()) as { rows?: CatalogPlayer[] };
    return data.rows ?? [];
  }, []);

  useEffect(() => {
    if (!open) return;
    const iso = new Date().toISOString().slice(0, 10);
    setView("hub");
    setHubNotice(null);
    resetTenupOnly();
    setPalmaresQuery("");
    setPalmaresResults([]);
    setPalmForm({
      match_date: iso,
      opponent_id: null,
      opponent_name: "",
      opponent_ranking: "",
      won: true,
      notes: ""
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- réinitialiser seulement à l'ouverture
  }, [open]);

  function resetTenupOnly() {
    tenupAppendNextParseRef.current = false;
    setTenupImportStep(1);
    setTenupFiles([]);
    setTenupFileNames([]);
    setTenupRows([]);
    setTenupPostParseNotice(false);
    setTenupCurrentRanking(currentRanking === "NC" ? "" : currentRanking);
    setTenupTargetRanking(targetRanking);
    setTenupOriginRanking("");
    if (tenupFileInputRef.current) tenupFileInputRef.current.value = "";
  }

  useEffect(() => {
    const q = palmaresQuery.trim();
    if (!q) {
      setPalmaresResults([]);
      return;
    }
    const t = window.setTimeout(() => {
      void searchPlayersCatalog(q).then(setPalmaresResults);
    }, 180);
    return () => window.clearTimeout(t);
  }, [palmaresQuery, searchPlayersCatalog]);

  async function onTenupFilesSelected(files: FileList | null) {
    const selected = files ? Array.from(files) : [];
    setTenupFileNames(selected.map((f) => f.name));
    const dataUrls = await Promise.all(
      selected.map(
        (f) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
            reader.onerror = () => reject(new Error("read"));
            reader.readAsDataURL(f);
          })
      )
    );
    setTenupFiles(dataUrls.filter(Boolean));
  }

  async function parseTenupCaptures() {
    if (!sessionId || tenupFiles.length === 0) return;
    setTenupParsing(true);
    try {
      const res = await fetch(`${API}/tenup-import/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_ranking: tenupCurrentRanking.trim(),
          origin_ranking: tenupOriginRanking.trim(),
          target_ranking: tenupTargetRanking.trim(),
          gender: tenupGender,
          images_data_urls: tenupFiles
        })
      });
      const data = (await res.json()) as {
        rows?: TenupParsedRow[];
        detected_current_ranking?: string;
        detail?: string;
      };
      if (!res.ok) {
        window.alert(typeof data.detail === "string" ? data.detail : "Analyse impossible.");
        return;
      }
      const append = tenupAppendNextParseRef.current;
      tenupAppendNextParseRef.current = false;
      const newRows = data.rows ?? [];
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
      }, 800);
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
          current_ranking: tenupCurrentRanking.trim(),
          origin_ranking: tenupOriginRanking.trim() || tenupCurrentRanking.trim(),
          target_ranking: tenupTargetRanking.trim(),
          gender: tenupGender,
          matches: tenupRows
        })
      });
      const data = (await res.json().catch(() => ({}))) as { imported?: number; detail?: string };
      if (!res.ok) {
        window.alert(typeof data.detail === "string" ? data.detail : "Import impossible.");
        return;
      }
      const n = data.imported ?? tenupRows.length;
      resetTenupOnly();
      setView("hub");
      setHubNotice(`${n} match${n > 1 ? "s" : ""} importés. Tu pourras compléter ton palmarès depuis le tableau de bord.`);
      onDataChanged?.();
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

  function closeAll() {
    resetTenupOnly();
    setPalmaresQuery("");
    setPalmaresResults([]);
    onClose();
  }

  function openTenup() {
    resetTenupOnly();
    setTenupCurrentRanking(currentRanking === "NC" ? "" : currentRanking);
    setTenupTargetRanking(targetRanking);
    setView("tenup");
  }

  async function submitPalmares(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sessionId) return;
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
      const res = await fetch(`${API}/palmares/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) return;
      setPalmForm({
        match_date: todayIso,
        opponent_id: null,
        opponent_name: "",
        opponent_ranking: "",
        won: true,
        notes: ""
      });
      setPalmaresQuery("");
      setPalmaresResults([]);
      setView("hub");
      setHubNotice("Match enregistré. Tu pourras en ajouter d’autres depuis le tableau de bord.");
      onDataChanged?.();
    } catch {
      /* ignore */
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center overflow-y-auto overscroll-contain bg-black/70 p-4 sm:items-center">
      {view === "hub" ? (
        <div className="my-auto w-full max-w-lg rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-[#e67e22]" />
              <h3 className="text-lg font-bold text-white">Tes résultats (12 mois)</h3>
            </div>
            <button
              type="button"
              onClick={closeAll}
              className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              aria-label="Fermer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="mb-4 text-sm text-neutral-400">
            Importe une capture Ten&apos;Up ou saisis un match à la main — comme sur ton tableau de bord.
          </p>
          {hubNotice ? (
            <p className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
              {hubNotice}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={openTenup}
              className="flex-1 rounded-2xl border border-white/15 py-3 text-sm font-semibold text-white hover:bg-white/5"
            >
              Importer Ten&apos;Up
            </button>
            <button
              type="button"
              onClick={() => {
                setHubNotice(null);
                setView("manual");
              }}
              className="flex-1 rounded-2xl bg-[#e67e22] py-3 text-sm font-semibold text-white hover:brightness-110"
            >
              Ajouter un match
            </button>
          </div>
        </div>
      ) : null}

      {view === "tenup" ? (
        <div className="my-auto max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-bold text-white">Importer mes captures Ten&apos;Up</h3>
            <button
              type="button"
              onClick={() => {
                resetTenupOnly();
                setView("hub");
              }}
              className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              aria-label="Retour"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {tenupImportStep === 1 ? (
            <>
              <p className="mb-4 text-xs text-neutral-400">
                <span className="font-semibold text-neutral-300">Étape 1.</span> Choisis les captures d&apos;écran de
                ton palmarès Ten&apos;Up, puis lance l&apos;analyse.
              </p>
              {tenupPostParseNotice ? (
                <div className="mb-4 rounded-2xl border border-[#58d68d]/40 bg-[#58d68d]/15 px-4 py-5 text-center">
                  <p className="text-sm font-semibold text-white">Analyse réussie</p>
                  <p className="mt-1 text-xs text-[#b8f5d0]">Les matchs ont été extraits. Passage à la vérification…</p>
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
                <span className="text-[11px] text-neutral-500">PNG, JPG ou WebP — plusieurs fichiers possibles</span>
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
                <span className="font-semibold text-neutral-300">Étape 2.</span> Vérifie les matchs détectés puis
                importe.
              </p>
              <p className="mb-1 text-sm font-semibold text-white">
                {tenupRows.length} match{tenupRows.length > 1 ? "s" : ""} à importer
              </p>

              <details className="mt-3 rounded-xl border border-white/10 bg-black/15 p-3 text-xs open:bg-black/25">
                <summary className="cursor-pointer font-semibold text-neutral-200">
                  Paramètres barème FFT (optionnel)
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="text-neutral-300">
                    Classement actuel
                    <input
                      className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                      value={tenupCurrentRanking}
                      onChange={(e) => setTenupCurrentRanking(e.target.value)}
                      list="echelons-onboarding"
                      placeholder="ex: 30/2"
                    />
                  </label>
                  <label className="text-neutral-300">
                    Classement objectif
                    <input
                      className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-white"
                      value={tenupTargetRanking}
                      onChange={(e) => setTenupTargetRanking(e.target.value)}
                      list="echelons-onboarding"
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
                      list="echelons-onboarding"
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
                    <div
                      key={`${String(r.match_date)}-${String(r.opponent_name)}-${idx}`}
                      className="rounded-lg bg-white/5 p-2 text-xs"
                    >
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
                          list="echelons-onboarding"
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
                          aria-label="Retirer"
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
      ) : null}

      {view === "manual" ? (
        <div className="my-auto max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-bold text-white">Ajouter un match</h3>
            <button
              type="button"
              onClick={() => setView("hub")}
              className="rounded-lg p-1 text-neutral-400 hover:bg-white/10"
              aria-label="Retour"
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
                  list="echelons-onboarding"
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
                placeholder="Tape un nom"
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
            <datalist id="echelons-onboarding">
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
                onClick={() => setView("hub")}
                className="flex-1 rounded-xl border border-white/15 py-2 text-sm text-white hover:bg-white/5"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="flex-1 rounded-xl bg-[#e67e22] py-2 text-sm font-semibold text-white hover:brightness-110"
              >
                Ajouter
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
