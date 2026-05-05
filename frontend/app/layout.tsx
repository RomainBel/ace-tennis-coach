import type { Metadata } from "next";
import { AuthSessionProvider } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ace — Prépare ton prochain match",
  description:
    "Coach tennis IA : focus, programme quotidien et suivi jusqu’au match."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body>
        <AuthSessionProvider>{children}</AuthSessionProvider>
      </body>
    </html>
  );
}
