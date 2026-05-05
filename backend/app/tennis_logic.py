"""
Moteur FFT renforcé (base produit) :
- normalisation étendue des classements FFT,
- capital de départ,
- barème victoire officiel (coef 1) par écart d'échelons,
- utilitaires de projection (palier, points manquants, etc).

Note:
- Le PDF FFT contient des règles additionnelles (V-E-2I-5G, limites de prises en compte,
  dispositions spécifiques matches libres, etc.) à compléter côté moteur agrégé.
"""

from __future__ import annotations

import calendar
import re
from datetime import date, timedelta
from typing import Any, List, Optional, Tuple

# Ordre : du plus bas au plus haut (indices croissants = niveau croissant).
ECHELONS: Tuple[str, ...] = (
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
    "1ère Série",
)

# Capital de départ (source FFT fournie par l'utilisateur).
STARTING_CAPITAL_BY_ECHELON: dict[str, int] = {
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
    "Promotion": 780,
    "1ère Série": 840,
}

# Seuils de projection interne (non officiels FFT). On les cale sur le capital
# de départ pour fournir une projection cohérente dans le dashboard.
MIN_POINTS_FOR_ECHELON: dict[str, int] = {
    e: STARTING_CAPITAL_BY_ECHELON.get(e, 0) for e in ECHELONS
}
MIN_POINTS_FOR_ECHELON["40"] = 0

SERIES_BY_ECHELON: dict[str, str] = {
    "40": "4e",
    "30/5": "4e",
    "30/4": "4e",
    "30/3": "4e",
    "30/2": "4e",
    "30/1": "4e",
    "30": "3e",
    "15/5": "3e",
    "15/4": "3e",
    "15/3": "3e",
    "15/2": "3e",
    "15/1": "3e",
    "15": "2e_pos",
    "5/6": "2e_pos",
    "4/6": "2e_pos",
    "3/6": "2e_pos",
    "2/6": "2e_pos",
    "1/6": "2e_pos",
    "0": "2e_pos",
    "-2/6": "2e_neg",
    "-4/6": "2e_neg",
    "-15": "2e_neg",
    "-30": "2e_neg",
    "Promotion": "1re",
    "1ère Série": "1re",
}

# Normes FFT (bilan minimum, victoires prises en compte), d'après le PDF fourni.
_NORMS_M: dict[str, tuple[int, int]] = {
    "40": (0, 6),
    "30/5": (6, 6),
    "30/4": (70, 6),
    "30/3": (120, 6),
    "30/2": (170, 6),
    "30/1": (210, 6),
    "30": (285, 8),
    "15/5": (305, 8),
    "15/4": (315, 8),
    "15/3": (325, 8),
    "15/2": (340, 8),
    "15/1": (370, 8),
    "15": (430, 9),
    "5/6": (445, 9),
    "4/6": (445, 9),
    "3/6": (485, 10),
    "2/6": (515, 10),
    "1/6": (565, 11),
    "0": (625, 12),
    "-2/6": (780, 15),
    "-4/6": (880, 17),
    "-15": (950, 19),
    "Promotion": (1000, 20),
    "1ère Série": (1100, 22),
}
_NORMS_F: dict[str, tuple[int, int]] = {
    "40": (0, 6),
    "30/5": (6, 6),
    "30/4": (70, 6),
    "30/3": (120, 6),
    "30/2": (170, 6),
    "30/1": (210, 6),
    "30": (265, 8),
    "15/5": (295, 8),
    "15/4": (305, 8),
    "15/3": (310, 8),
    "15/2": (330, 8),
    "15/1": (350, 8),
    "15": (390, 9),
    "5/6": (400, 9),
    "4/6": (430, 9),
    "3/6": (500, 10),
    "2/6": (560, 11),
    "1/6": (610, 12),
    "0": (630, 14),
    "-2/6": (750, 15),
    "-4/6": (750, 16),
    "-15": (800, 17),
    "Promotion": (900, 19),
    "1ère Série": (980, 22),
}

VE2I5G_STEPS: dict[str, list[tuple[Optional[float], Optional[float], int]]] = {
    # Calibrage Ten'Up: en 4e série, un bilan de 8 reste à +1 (6+1), le +2 démarre à 10.
    "4e": [(0.0, 9.9, 1), (10.0, 14.9, 2), (15.0, 19.9, 3), (20.0, 24.9, 4), (25.0, 29.9, 5), (30.0, None, 6)],
    # Calibrage Ten'Up: en 3e série, un bilan de 8 reste à +1 (6+1), le +2 démarre à 10.
    "3e": [(0.0, 9.9, 1), (10.0, 14.9, 2), (15.0, 22.9, 3), (23.0, 29.9, 4), (30.0, 39.9, 5), (40.0, None, 6)],
    "2e_pos": [
        (None, -41.0, -3),
        (-40.0, -30.1, -2),
        (-30.0, -20.1, -1),
        (-20.0, -0.1, 0),
        (0.0, 7.9, 1),
        (8.0, 14.9, 2),
        (15.0, 22.9, 3),
        (23.0, 29.9, 4),
        (30.0, 39.9, 5),
        (40.0, None, 6),
    ],
    "2e_neg": [
        (None, -81.0, -5),
        (-80.0, -60.1, -4),
        (-60.0, -40.1, -3),
        (-40.0, -30.1, -2),
        (-30.0, -20.1, -1),
        (-20.0, -0.1, 0),
        (0.0, 9.9, 1),
        (10.0, 19.9, 2),
        (20.0, 24.9, 3),
        (25.0, 29.9, 4),
        (30.0, 34.9, 5),
        (35.0, 44.9, 6),
        (45.0, None, 7),
    ],
}

# Barème victoire FFT (coef 1) par écart à l'échelon de calcul.
# gap = index(adversaire) - index(joueur)
_VICTORY_TABLE: dict[int, int] = {
    -4: 0,   # victoire >= 4 échelons en dessous
    -3: 15,
    -2: 20,
    -1: 30,
    0: 60,
    1: 90,
    2: 120,  # victoire >= 2 échelons au-dessus
    3: 120,
    4: 120,
}

# Défaite : approximation produit (en attente d'intégration complète V-E-2I-5G).
_DEFEAT_TABLE: dict[int, int] = {
    -4: 0,
    -3: 0,
    -2: 0,
    -1: 0,
    0: 0,
    1: 0,
    2: 0,
    3: 0,
    4: 0,
}


def normalize_label(raw: str) -> str:
    s = raw.strip().upper().replace(" ", "")
    s = s.replace("È", "E").replace("É", "E").replace("Ê", "E")
    s = s.replace("–", "-").replace("—", "-").replace(".", "")
    s = s.replace("1ERE", "1ERE").replace("SERIE", "SERIE")
    if s == "NC":
        return "40"
    if s in ("PROMO", "PROMOTION"):
        return "Promotion"
    if s in ("1ERESERIE", "1SERIE"):
        return "1ère Série"
    # 30-1 -> 30/1
    m = re.match(r"^(\d{1,2})[/\-](\d)$", s)
    if m:
        return f"{m.group(1)}/{m.group(2)}"
    if s in ("40",):
        return "40"
    if s in ("N3", "N.3"):
        return "5/6"
    if s in ("N2", "N.2"):
        return "3/6"
    if s in ("N1", "N.1"):
        return "1/6"
    if s in ("PRO",):
        return "Promotion"
    if s == "-2":
        return "-2/6"
    if s == "-4":
        return "-4/6"
    if s in ECHELONS:
        return s
    # fallback: try case-insensitive match
    for e in ECHELONS:
        if e.upper().replace(" ", "") == s:
            return e
    return raw.strip()


def echelon_index(label: str) -> int:
    n = normalize_label(label)
    try:
        return ECHELONS.index(n)
    except ValueError:
        # défaut : milieu de tableau pour ne pas bloquer le produit
        return 5


def points_threshold_for_label(label: str) -> int:
    n = normalize_label(label)
    return MIN_POINTS_FOR_ECHELON.get(n, MIN_POINTS_FOR_ECHELON["40"])


def starting_capital_for_label(label: str) -> int:
    n = normalize_label(label)
    return STARTING_CAPITAL_BY_ECHELON.get(n, STARTING_CAPITAL_BY_ECHELON["40"])


def _clamp_gap(gap: int) -> int:
    return max(-4, min(4, gap))


def _lookup_points(table: dict[int, int], gap: int) -> int:
    g = _clamp_gap(gap)
    return table.get(g, 0)


def points_for_match(player_ranking: str, opponent_ranking: str, won: bool) -> int:
    pi = echelon_index(player_ranking)
    oi = echelon_index(opponent_ranking)
    gap = oi - pi
    if won:
        return _lookup_points(_VICTORY_TABLE, gap)
    return _lookup_points(_DEFEAT_TABLE, gap)


def points_to_reach_target(current_points: int, target_label: str) -> int:
    need = points_threshold_for_label(target_label)
    return max(0, need - current_points)


def projected_ranking_label(total_points: int) -> str:
    """Dernier palier dont le seuil projeté est atteint."""
    best = ECHELONS[0]
    for e in ECHELONS:
        m = MIN_POINTS_FOR_ECHELON.get(e, 0)
        if total_points >= m:
            best = e
    return best


def target_reached(current_points: int, target_label: str) -> bool:
    return current_points >= points_threshold_for_label(target_label)


def simulate_hypothetical_matches(
    player_ranking: str,
    current_points: int,
    hypothetical: List[Tuple[str, bool]],
) -> dict:
    """
    hypothetical: liste (classement adversaire, victoire?)
    """
    breakdown: List[dict] = []
    total = current_points
    for opp, won in hypothetical:
        delta = points_for_match(player_ranking, opp, won)
        total += delta
        breakdown.append(
            {
                "opponent_ranking": opp,
                "won": won,
                "delta": delta,
            }
        )
    return {
        "starting_points": current_points,
        "projected_points": total,
        "breakdown": breakdown,
    }


def progress_ratio_to_target(current_points: int, target_label: str) -> float:
    """0–1 pour affichage anneau objectif (points / seuil objectif)."""
    if not (target_label or "").strip():
        return 0.0
    need = points_threshold_for_label(target_label)
    if need <= 0:
        return 1.0
    return max(0.0, min(1.0, current_points / need))


def first_tuesday_of_month(year: int, month: int) -> date:
    _, last = calendar.monthrange(year, month)
    for d in range(1, last + 1):
        dt = date(year, month, d)
        if dt.weekday() == 1:
            return dt
    return date(year, month, 1)


def next_fft_update_date(today: Optional[date] = None) -> date:
    today = today or date.today()
    this_month = first_tuesday_of_month(today.year, today.month)
    if today <= this_month:
        return this_month
    if today.month == 12:
        return first_tuesday_of_month(today.year + 1, 1)
    return first_tuesday_of_month(today.year, today.month + 1)


def fft_monthly_update_sentence(today: Optional[date] = None) -> str:
    nxt = next_fft_update_date(today or date.today())
    return (
        "En France, le classement FFT est mis à jour chaque mois, en général le **premier mardi** "
        f"(souvent vers le **5** du mois). Prochaine échéance indicative : **{nxt.isoformat()}**. "
        "Les points gagnés ou perdus en match sont intégrés à cette mise à jour : "
        "aide le joueur à estimer combien de victoires « à aller chercher » avant le prochain palier."
    )


def next_echelon_label(current_label: str) -> Optional[str]:
    idx = echelon_index(current_label)
    if idx + 1 < len(ECHELONS):
        return ECHELONS[idx + 1]
    return None


def points_to_next_echelon(current_points: int, current_label: str) -> Optional[int]:
    nxt = next_echelon_label(current_label)
    if not nxt:
        return None
    need = points_threshold_for_label(nxt)
    return max(0, need - current_points)


def normalize_gender(raw: str) -> str:
    g = (raw or "").strip().upper()
    if g in ("F", "FEMME", "FEMININ", "FÉMININ"):
        return "F"
    return "M"


def series_for_label(label: str) -> str:
    n = normalize_label(label)
    return SERIES_BY_ECHELON.get(n, "4e")


def norms_for_label(label: str, gender: str) -> tuple[int, int]:
    n = normalize_label(label)
    g = normalize_gender(gender)
    source = _NORMS_F if g == "F" else _NORMS_M
    return source.get(n, (0, 6))


def ve2i5g_adjustment(series: str, bilan: float) -> int:
    steps = VE2I5G_STEPS.get(series, [])
    for lo, hi, delta in steps:
        low_ok = lo is None or bilan >= lo
        high_ok = hi is None or bilan <= hi
        if low_ok and high_ok:
            return delta
    return 0


def fft_snapshot(
    *,
    current_label: str,
    origin_label: str,
    gender: str,
    win_points: List[int],
    losses_count: int,
) -> dict[str, Any]:
    """Calcule un snapshot FFT simplifié avancé (12 mois glissants)."""
    cur = normalize_label(current_label or "40")
    origin = normalize_label(origin_label or cur)
    g = normalize_gender(gender)

    base_capital = starting_capital_for_label(origin)
    min_bilan, base_wins_counted = norms_for_label(cur, g)
    wins_count = len(win_points)
    bilan = float(wins_count - losses_count)
    delta_wins = ve2i5g_adjustment(series_for_label(cur), bilan)
    wins_counted = max(0, base_wins_counted + delta_wins)
    counted_points = sum(sorted((int(v) for v in win_points), reverse=True)[:wins_counted])
    total_points = max(0, base_capital + counted_points)
    points_to_min_bilan = max(0, int(min_bilan - total_points))

    return {
        "starting_capital": base_capital,
        "gender": g,
        "current_label_calc": cur,
        "wins_count": wins_count,
        "losses_count": int(losses_count),
        "bilan_ve2i5g": bilan,
        "base_wins_counted": int(base_wins_counted),
        "ve2i5g_adjustment": int(delta_wins),
        "wins_counted": int(wins_counted),
        "counted_points": int(counted_points),
        "current_points": int(total_points),
        "min_bilan_required": int(min_bilan),
        "points_to_min_bilan": int(points_to_min_bilan),
    }


def wins_hint_generic(
    player_ranking: str,
    points_missing: int,
    typical_opponent: str,
) -> str:
    """Estimation grossière de victoires si toutes contre un profil d’adversaire typique."""
    if points_missing <= 0:
        return "Objectif palier déjà atteint avec ces points."
    per_win = max(1, points_for_match(player_ranking, typical_opponent, True))
    n = (points_missing + per_win - 1) // per_win
    return (
        f"À titre indicatif, contre un adversaire type **{typical_opponent}**, "
        f"une victoire rapporte ~**{per_win}** pts : il faudrait environ **{n}** victoire(s) "
        f"pour combler **{points_missing}** pts."
    )


def rolling_window_start(today: Optional[date] = None, months: int = 12) -> date:
    base = today or date.today()
    if months <= 0:
        months = 12
    # approximation glissante robuste en jours
    return base - timedelta(days=30 * months)
