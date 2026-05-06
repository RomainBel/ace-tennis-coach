"use client";

import { OnboardingPalmaresFlow } from "@/components/onboarding-palmares-flow";
import { Bot, ChevronRight, ImagePlus, Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  FormEvent,
  useCallback,
  useEffect,
  useState
} from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Image de fond (court extérieur) — chargement direct, pas besoin de domaine next/image */
const HERO_BG =
  "https://images.unsplash.com/photo-1554068865-24cecd4e34b8?auto=format&fit=crop&w=1920&q=80";

type ProfileLite = {
  current_ranking: string;
  target_ranking: string;
  points_to_target: number | null;
  target_threshold_points: number | null;
  current_points: number | null;
};

type DashboardBootstrap = {
  ranking_echelons: string[];
  profile?: {
    onboarding_completed?: boolean;
    display_name?: string;
    current_ranking?: string;
    target_ranking?: string;
    avatar_data_url?: string;
  };
};

export default function OnboardingPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const sessionId = session?.user?.id ?? "";

  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);

  const [currentRanking, setCurrentRanking] = useState("30/2");
  const [targetRanking, setTargetRanking] = useState("15/5");
  const [rankingInsight, setRankingInsight] = useState<string | null>(null);

  const [echelons, setEchelons] = useState<string[]>([]);

  const [palmaresFlowOpen, setPalmaresFlowOpen] = useState(false);
  const [palmaresCount12m, setPalmaresCount12m] = useState<number | null>(null);

  const firstName =
    displayName.trim().split(/\s+/).filter(Boolean)[0] || "toi";

  const loadBootstrap = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`${API}/dashboard/${sessionId}`);
    if (!res.ok) return;
    const data = (await res.json()) as DashboardBootstrap;
    setEchelons(data.ranking_echelons ?? []);
    const p = data.profile;
    if (p?.onboarding_completed === true) {
      router.replace("/dashboard");
      return;
    }
    // Reprendre un onboarding interrompu : aligner l’état local sur ce qui est déjà en base.
    if (p?.display_name?.trim()) setDisplayName(p.display_name.trim());
    if (p?.current_ranking?.trim()) setCurrentRanking(p.current_ranking.trim());
    if (p?.target_ranking?.trim()) setTargetRanking(p.target_ranking.trim());
    if (p?.avatar_data_url?.trim()) setAvatarDataUrl(p.avatar_data_url.trim());
  }, [sessionId, router]);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  useEffect(() => {
    if (sessionId) void loadBootstrap();
  }, [sessionId, loadBootstrap]);

  async function patchProfile(body: Record<string, unknown>) {
    const res = await fetch(`${API}/profile/${sessionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = (await res.json().catch(() => ({}))) as {
      detail?: string | unknown[];
    };
    if (!res.ok) {
      const msg = Array.isArray(payload.detail)
        ? "Données invalides"
        : typeof payload.detail === "string"
          ? payload.detail
          : "Erreur serveur";
      throw new Error(msg);
    }
    return payload as ProfileLite & { onboarding_completed?: boolean };
  }

  function onAvatarPick(file: File | null) {
    if (!file || !file.type.startsWith("image/")) return;
    if (file.size > 2 * 1024 * 1024) {
      setError("Image trop volumineuse (max 2 Mo).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : null;
      setAvatarDataUrl(url);
      setError(null);
    };
    reader.readAsDataURL(file);
  }

  async function goStep1to2(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!sessionId) {
      setError("Session pas encore prête — attends une seconde et réessaie.");
      return;
    }
    if (!displayName.trim()) {
      setError("Indique au moins ton prénom ou ton nom.");
      return;
    }
    setLoading(true);
    try {
      await patchProfile({
        display_name: displayName.trim(),
        ...(avatarDataUrl ? { avatar_data_url: avatarDataUrl } : {})
      });
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setLoading(false);
    }
  }

  const loadPalmaresCount = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`${API}/palmares/${sessionId}`);
      if (!res.ok) return;
      const data = (await res.json()) as { entries?: unknown[] };
      setPalmaresCount12m((data.entries ?? []).length);
    } catch {
      setPalmaresCount12m(null);
    }
  }, [sessionId]);

  useEffect(() => {
    if (step === 3 && sessionId) void loadPalmaresCount();
  }, [step, sessionId, loadPalmaresCount]);

  async function goStep2to3(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!sessionId) {
      setError("Session pas encore prête — attends une seconde et réessaie.");
      return;
    }
    setLoading(true);
    try {
      const profile = await patchProfile({
        current_ranking: currentRanking,
        target_ranking: targetRanking
      });
      const pts = profile.points_to_target;
      const cur = profile.current_ranking || currentRanking;
      const tgt = profile.target_ranking || targetRanking;
      if (pts != null && pts >= 0) {
        setRankingInsight(
          `Passer de ${cur} à ${tgt}, c’est l’objectif — environ ${pts} points FFT à gravir sur la saison (estimation Ace).`
        );
      } else {
        setRankingInsight(
          `Objectif : progresser de ${cur} vers ${tgt}. On affinera avec tes résultats réels.`
        );
      }
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setLoading(false);
    }
  }

  async function finishToDashboard() {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      // Un seul PUT final : comme le modal Profil, pour ne pas dépendre uniquement des étapes 1–2
      // (réseau froid, perte de requête, etc.).
      const body: Record<string, unknown> = {
        current_ranking: currentRanking,
        target_ranking: targetRanking,
        onboarding_completed: true
      };
      const name = displayName.trim();
      if (name) body.display_name = name;
      if (avatarDataUrl) body.avatar_data_url = avatarDataUrl;
      await patchProfile(body);
      router.push("/dashboard?onboarding=1");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setLoading(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <Loader2 className="h-10 w-10 animate-spin text-[#e67e22]" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-neutral-100">
      <header className="relative overflow-hidden border-b border-white/10">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${HERO_BG})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/80 to-black/40" />
        <div className="relative mx-auto max-w-3xl px-4 py-10 text-center md:py-14">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#e67e22]">
            Atteins tes objectifs tennis amateur
          </p>
          <div className="mt-4 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/20 bg-black/50 backdrop-blur">
              <Bot className="h-9 w-9 text-[#e67e22]" />
            </div>
          </div>
          <h1 className="mt-4 text-2xl font-bold text-white md:text-3xl">
            Ace — Coach tennis
          </h1>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-8 pb-16">
        {error ? (
          <p className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        ) : null}

        {step === 0 && (
          <section className="space-y-6">
            <p className="text-lg leading-relaxed text-neutral-200">
              Salut ! Je suis <strong className="text-white">Ace</strong>, ton coach
              personnel. Mon seul objectif : t&apos;aider à franchir tes prochains paliers
              au classement FFT.
            </p>
            <button
              type="button"
              onClick={() => setStep(1)}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#e67e22] py-4 text-base font-semibold text-white shadow-lg shadow-black/40 transition hover:brightness-110"
            >
              C&apos;est parti !
              <ChevronRight className="h-5 w-5" />
            </button>
          </section>
        )}

        {step === 1 && (
          <section>
            <p className="mb-6 text-neutral-300">
              Commençons par faire connaissance. Comment dois-je t&apos;appeler sur le court
              ?
            </p>
            <form onSubmit={(e) => void goStep1to2(e)} className="space-y-5">
              <label className="block text-sm text-neutral-300">
                Prénom & nom
                <input
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#1e1e1e] px-4 py-3 text-white outline-none focus:ring-1 focus:ring-[#e67e22]"
                  placeholder="ex. Romain Dupont"
                  autoComplete="name"
                />
              </label>
              <div className="rounded-xl border border-white/10 bg-[#1e1e1e] p-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Photo de profil
                </p>
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-black/40">
                    {avatarDataUrl ? (
                      <img
                        src={avatarDataUrl}
                        alt="Aperçu"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ImagePlus className="h-8 w-8 text-neutral-600" />
                    )}
                  </div>
                  <label className="cursor-pointer text-sm text-[#e67e22] hover:underline">
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => onAvatarPick(e.target.files?.[0] ?? null)}
                    />
                    Choisir une image
                  </label>
                </div>
                <p className="mt-2 text-[11px] text-neutral-500">
                  PNG / JPG, max 2 Mo. Optionnel.
                </p>
              </div>
              {displayName.trim().length > 0 && (
                <p className="rounded-xl border border-[#e67e22]/30 bg-[#e67e22]/10 px-4 py-3 text-sm text-neutral-100">
                  Ravi de te voir ici, <strong className="text-white">{firstName}</strong>{" "}
                  ! Prêt à bosser ?
                </p>
              )}
              <button
                type="submit"
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#e67e22] py-3.5 font-semibold text-white hover:brightness-110 disabled:opacity-60"
              >
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                Continuer
              </button>
            </form>
          </section>
        )}

        {step === 2 && (
          <section>
            <p className="mb-6 text-neutral-300">
              Le classement, c&apos;est le juge de paix. Dis-moi où tu en es et où on va.
            </p>
            <form onSubmit={(e) => void goStep2to3(e)} className="space-y-4">
              <label className="block text-sm text-neutral-300">
                Classement actuel
                <select
                  value={currentRanking}
                  onChange={(e) => setCurrentRanking(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#1e1e1e] px-4 py-3 text-white outline-none focus:ring-1 focus:ring-[#e67e22]"
                >
                  <option value="NC">Non classé (traité comme 40)</option>
                  {echelons.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-neutral-300">
                Objectif de fin de saison
                <select
                  value={targetRanking}
                  onChange={(e) => setTargetRanking(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#1e1e1e] px-4 py-3 text-white outline-none focus:ring-1 focus:ring-[#e67e22]"
                >
                  {echelons.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] text-neutral-500">
                Les échelons suivent le barème FFT utilisé dans ton dashboard Ace.
              </p>
              <button
                type="submit"
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#e67e22] py-3.5 font-semibold text-white hover:brightness-110 disabled:opacity-60"
              >
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                Continuer
              </button>
            </form>
          </section>
        )}

        {step === 3 && (
          <section className="space-y-5">
            {rankingInsight && (
              <p className="flex gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                {rankingInsight}
              </p>
            )}
            <p className="text-neutral-300">
              Partage tes résultats sur les 12 derniers mois ici :
            </p>
            <button
              type="button"
              onClick={() => setPalmaresFlowOpen(true)}
              className="flex min-h-[160px] w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-white/20 bg-[#1a1a1a] px-4 py-8 text-center transition hover:border-[#e67e22]/50 hover:bg-[#1e1e1e]"
            >
              <ImagePlus className="mb-3 h-8 w-8 text-neutral-500" />
              <p className="text-sm font-medium text-white">Ajouter mes résultats</p>
              <p className="mt-2 max-w-sm text-xs leading-relaxed text-neutral-500">
                Import Ten&apos;Up ou saisie manuelle — même écran que dans le tableau de bord.
              </p>
              {palmaresCount12m != null && palmaresCount12m > 0 ? (
                <p className="mt-3 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-200">
                  {palmaresCount12m === 1
                    ? "1 match déjà enregistré"
                    : `${palmaresCount12m} matchs déjà enregistrés`}
                </p>
              ) : null}
            </button>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <button
                type="button"
                onClick={() => setStep(4)}
                className="order-1 w-full rounded-2xl bg-[#e67e22] py-3.5 font-semibold text-white transition hover:brightness-110 sm:order-2 sm:flex-1"
              >
                Continuer
              </button>
              <button
                type="button"
                onClick={() => setStep(4)}
                className="order-2 w-full rounded-2xl border border-white/15 py-3.5 text-sm font-medium text-neutral-200 transition hover:bg-white/5 sm:order-1 sm:flex-1"
              >
                Ajouter plus tard
              </button>
            </div>
            <OnboardingPalmaresFlow
              open={palmaresFlowOpen}
              onClose={() => setPalmaresFlowOpen(false)}
              sessionId={sessionId}
              currentRanking={currentRanking}
              targetRanking={targetRanking}
              onDataChanged={() => void loadPalmaresCount()}
            />
          </section>
        )}

        {step === 4 && (
          <section className="space-y-6 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20">
              <Sparkles className="h-8 w-8 text-emerald-400" />
            </div>
            <h2 className="text-xl font-bold text-white">Tout est prêt.</h2>
            <p className="text-neutral-300">
              Ton dashboard est maintenant configuré pour ton niveau{" "}
              <strong className="text-white">
                {currentRanking === "NC" ? "Non classé" : currentRanking}
              </strong>
              .
            </p>
            <button
              type="button"
              disabled={loading}
              onClick={() => void finishToDashboard()}
              className="w-full rounded-2xl bg-[#e67e22] py-4 font-semibold text-white shadow-lg hover:brightness-110 disabled:opacity-60"
            >
              {loading ? <Loader2 className="mx-auto h-6 w-6 animate-spin" /> : "Voir mon dashboard"}
            </button>
          </section>
        )}

        <p className="mt-10 text-center text-xs text-neutral-600">
          <button
            type="button"
            onClick={() => void signOut({ callbackUrl: "/login" })}
            className="underline hover:text-neutral-400"
          >
            Se déconnecter
          </button>
        </p>
      </main>
    </div>
  );
}
