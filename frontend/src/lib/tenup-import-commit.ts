/**
 * Données brutes renvoyées par /tenup-import/parse (souvent typées laxistes).
 */
export type TenupParsedRow = Record<string, string | number | boolean | null | undefined>;

export function mergeTenupParsedRows(
  existing: TenupParsedRow[],
  incoming: TenupParsedRow[]
): TenupParsedRow[] {
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

/**
 * Corps attendu par POST /tenup-import/commit (aligné sur TenupImportParsedMatch côté API).
 * Évite les échecs silencieux (imported=0) quand won / dates arrivent dans un format JSON ambigu.
 */
export function sanitizeTenupMatchesForCommit(rows: TenupParsedRow[]) {
  return rows.map((r) => ({
    match_date: String(r.match_date ?? "")
      .trim()
      .slice(0, 10),
    opponent_name: String(r.opponent_name ?? "").trim(),
    opponent_ranking: String(r.opponent_ranking ?? "").trim(),
    won: Boolean(
      r.won === true || r.won === "true" || r.won === 1 || r.won === "1"
    ),
    notes:
      String(r.notes ?? "Import capture Ten'Up").trim() || "Import capture Ten'Up"
  }));
}
