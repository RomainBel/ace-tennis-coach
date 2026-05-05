/**
 * Aligné sur backend/app/tennis_logic.py : projected_ranking_label + MIN_POINTS_FOR_ECHELON.
 * Sert à une projection indicative à partir de la somme des points palmarès.
 */
const ECHELONS = [
  "40",
  "30/5",
  "30/4",
  "30/3",
  "30/2",
  "30/1",
  "30",
  "15/5",
  "15/4",
  "15/3",
  "15/2",
  "15/1",
  "15",
  "5/6",
  "4/6",
  "3/6",
  "2/6",
  "1/6",
  "0",
  "-2/6",
  "-4/6",
  "-15",
  "-30",
  "Promotion",
  "1ère Série"
] as const;

const STARTING_CAPITAL: Record<string, number> = {
  "40": 2,
  "30/5": 5,
  "30/4": 10,
  "30/3": 20,
  "30/2": 30,
  "30/1": 50,
  "30": 80,
  "15/5": 120,
  "15/4": 160,
  "15/3": 200,
  "15/2": 240,
  "15/1": 280,
  "15": 330,
  "5/6": 370,
  "4/6": 410,
  "3/6": 450,
  "2/6": 490,
  "1/6": 530,
  "0": 570,
  "-2/6": 620,
  "-4/6": 660,
  "-15": 700,
  "-30": 740,
  Promotion: 780,
  "1ère Série": 840
};

const MIN_POINTS: Record<string, number> = {};
for (const e of ECHELONS) {
  MIN_POINTS[e] = STARTING_CAPITAL[e] ?? 0;
}
MIN_POINTS["40"] = 0;

export const FFT_ECHELONS: readonly string[] = ECHELONS as unknown as readonly string[];

export function projectedRankingFromPoints(totalPoints: number): string {
  let best: string = ECHELONS[0];
  for (const e of ECHELONS) {
    if (totalPoints >= (MIN_POINTS[e] ?? 0)) best = e;
  }
  return best;
}
