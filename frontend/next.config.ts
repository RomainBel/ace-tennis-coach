import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Dossier du frontend comme racine (évite la résolution sur le lockfile parent).
  outputFileTracingRoot: path.join(__dirname)
};

export default nextConfig;
