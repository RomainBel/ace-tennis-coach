"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

function ResetPasswordInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams?.get("token");
  const emailFromQuery = searchParams?.get("email")?.trim() ?? "";
  const [email, setEmail] = useState(emailFromQuery);
  useEffect(() => {
    if (emailFromQuery) setEmail(emailFromQuery);
  }, [emailFromQuery]);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function sendLink(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setLoading(true);
    try {
      const res = await fetch(`${API}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() })
      });
      if (!res.ok) {
        setError("Requête impossible.");
        return;
      }
      setMessage(
        "Si cet email est connu, un lien a été préparé. En développement, regarde la console du serveur FastAPI pour le lien."
      );
    } catch {
      setError("Réseau indisponible ou serveur arrêté.");
    } finally {
      setLoading(false);
    }
  }

  async function resetPwd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) return;
    if (password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    if (password !== password2) {
      setError("Les mots de passe ne correspondent pas.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, new_password: password })
      });
      const data = (await res.json().catch(() => ({}))) as { detail?: string };
      if (!res.ok) {
        setError(typeof data.detail === "string" ? data.detail : "Lien invalide ou expiré.");
        return;
      }
      router.push("/login");
      router.refresh();
    } catch {
      setError("Réseau indisponible ou serveur arrêté.");
    } finally {
      setLoading(false);
    }
  }

  if (token) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#121212] px-4 text-white">
        <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#1e1e1e] p-8 shadow-2xl">
          <h1 className="text-center text-2xl font-bold">Nouveau mot de passe</h1>
          <p className="mb-8 mt-2 text-center text-sm text-neutral-400">
            Choisis un mot de passe sécurisé.
          </p>
          <form onSubmit={(e) => void resetPwd(e)} className="space-y-4">
            <label className="block text-sm text-neutral-300">
              Nouveau mot de passe
              <input
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2.5 text-white outline-none focus:ring-1 focus:ring-[#e67e22]"
              />
            </label>
            <label className="block text-sm text-neutral-300">
              Confirmer
              <input
                type="password"
                autoComplete="new-password"
                required
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2.5 text-white outline-none focus:ring-1 focus:ring-[#e67e22]"
              />
            </label>
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#e67e22] py-3 font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
              Mettre à jour
            </button>
          </form>
          <p className="mt-6 text-center text-sm">
            <Link href="/login" className="text-[#e67e22] hover:underline">
              Retour connexion
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#121212] px-4 text-white">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#1e1e1e] p-8 shadow-2xl">
        <h1 className="text-center text-2xl font-bold">Mot de passe oublié</h1>
        <p className="mb-8 mt-2 text-center text-sm text-neutral-400">
          Reçois un lien de réinitialisation (vérifie la console serveur en local).
        </p>
        <form onSubmit={(e) => void sendLink(e)} className="space-y-4">
          <label className="block text-sm text-neutral-300">
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2.5 text-white outline-none focus:ring-1 focus:ring-[#e67e22]"
            />
          </label>
          {message ? <p className="text-sm text-emerald-300">{message}</p> : null}
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#e67e22] py-3 font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
            Envoyer le lien
          </button>
        </form>
        <p className="mt-6 text-center text-sm">
          <Link href="/login" className="text-[#e67e22] hover:underline">
            Retour connexion
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#121212] text-white">
          <Loader2 className="h-8 w-8 animate-spin text-[#e67e22]" />
        </div>
      }
    >
      <ResetPasswordInner />
    </Suspense>
  );
}
