import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

const apiBase =
  process.env.BACKEND_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8000";

/**
 * Auth.js exige AUTH_SECRET. Sans lui, l’API route /api/auth/* renvoie une erreur de configuration.
 * En prod : définir AUTH_SECRET (ex. openssl rand -base64 32) dans l’hébergeur.
 * En dev : repli local si la variable manque (évite de bloquer npm run dev).
 */
function authSecret(): string | undefined {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (process.env.NODE_ENV !== "production") {
    return "dev-only-insecure-secret-set-env-auth-secret-in-production";
  }
  return undefined;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: authSecret(),
  pages: {
    signIn: "/login"
  },
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Mot de passe", type: "password" }
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }
        const res = await fetch(`${apiBase}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: credentials.email,
            password: credentials.password
          })
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { user_id: string; email: string };
        return { id: data.user_id, email: data.email };
      }
    })
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.email = user.email;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.email = (token.email as string) ?? session.user.email;
      }
      return session;
    }
  }
});
