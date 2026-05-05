"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Loader2 } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API}/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password })
      });
      const data = (await res.json().catch(() => ({}))) as { detail?: string };
      if (!res.ok) {
        setError(typeof data.detail === "string" ? data.detail : "Inscription impossible.");
        return;
      }
      router.push("/login?registered=1");
      router.refresh();
    } catch {
      setError("Réseau indisponible ou serveur arrêté.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#121212] px-4 text-white">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#1e1e1e] p-8 shadow-2xl">
        <h1 className="text-center text-2xl font-bold">Créer un compte</h1>
        <p className="mb-8 mt-2 text-center text-sm text-neutral-400">
          Un espace personnel pour ton suivi tennis.
        </p>
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
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
          <label className="block text-sm text-neutral-300">
            Mot de passe (min. 8 caractères)
            <input
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
            S&apos;inscrire
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-neutral-500">
          <Link href="/login" className="text-[#e67e22] hover:underline">
            Déjà un compte ? Connexion
          </Link>
        </p>
        <p className="mt-4 text-center text-sm text-neutral-500">
          <Link href="/" className="text-neutral-400 hover:text-neutral-200 hover:underline">
            ← Retour à l&apos;accueil
          </Link>
        </p>
      </div>
    </div>
  );
}
