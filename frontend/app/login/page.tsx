"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { Loader2 } from "lucide-react";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const registered = searchParams?.get("registered");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await signIn("credentials", {
      email: email.trim(),
      password,
      redirect: false
    });
    setLoading(false);
    if (res?.error) {
      setError("Email ou mot de passe incorrect.");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#121212] px-4 text-white">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#1e1e1e] p-8 shadow-2xl">
        <h1 className="text-center text-2xl font-bold">Connexion</h1>
        <p className="mb-8 mt-2 text-center text-sm text-neutral-400">
          Accède à ton tableau de bord et à Ace.
        </p>
        {registered ? (
          <p className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-center text-sm text-emerald-200">
            Compte créé. Tu peux te connecter.
          </p>
        ) : null}
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
            Mot de passe
            <input
              type="password"
              autoComplete="current-password"
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
            Se connecter
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-neutral-500">
          <Link href="/reset-password" className="text-[#e67e22] hover:underline">
            Mot de passe oublié
          </Link>
          {" · "}
          <Link href="/signup" className="text-neutral-300 hover:underline">
            Créer un compte
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#121212] text-white">
          <Loader2 className="h-8 w-8 animate-spin text-[#e67e22]" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
