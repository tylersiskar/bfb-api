"""
Fantasy Football Keeper Value Model
=====================================
Pulls historical NFL data via nflreadpy, builds positional aging curves,
and scores every player's multi-year keeper value for a 0.5 PPR league
with 8 keepers out of 16-man rosters.

Usage:
    pip install nflreadpy
    python keeper_value_model.py
"""

import nflreadpy as nflr
import pandas as pd
import numpy as np
import json
import os
from datetime import datetime
from collections import defaultdict

# ── CONFIG ──────────────────────────────────────────────────────────────────

SEASONS = list(range(2018, 2026))  # pull 8 years of data (2018-2025)
KEEPER_SLOTS = 8
ROSTER_SIZE = 16
PROJECTION_YEARS = 4              # how far ahead to project
DISCOUNT_RATE = 0.18              # annual uncertainty discount
MIN_GAMES = 10                    # must play 10+ games to qualify
POSITIONS = ["QB", "RB", "WR", "TE"]
NUM_TEAMS = 12

# Draft capital — how much weight to give draft position for rookies
# Top picks at premium positions are valuable keeper assets even before playing
DRAFT_CAPITAL_DECAY = 0.5         # draft capital loses 50% value per year without production
DRAFT_BLEND_GAMES = 17            # full season of games before production fully replaces draft capital

# Starting lineup — drives positional scarcity calculation
STARTERS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 1}
# FLEX-eligible positions get extra demand
FLEX_ELIGIBLE = ["RB", "WR", "TE"]

# positional weights for composite score
WEIGHTS = {
    "current_season": 0.50,
    "longevity":      0.25,
    "scarcity":       0.15,
    "durability":     0.10,
}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "..", "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# OTC draft pick values (pick# -> value), embedded since nflreadpy doesn't have import_draft_values
# Source: Over The Cap trade value chart
OTC_DRAFT_VALUES = {
    1: 3000, 2: 2635, 3: 2421, 4: 2270, 5: 2152, 6: 2053, 7: 1967, 8: 1890,
    9: 1821, 10: 1758, 11: 1700, 12: 1646, 13: 1596, 14: 1549, 15: 1504,
    16: 1462, 17: 1422, 18: 1384, 19: 1348, 20: 1314, 21: 1281, 22: 1250,
    23: 1220, 24: 1191, 25: 1163, 26: 1137, 27: 1111, 28: 1087, 29: 1063,
    30: 1040, 31: 1018, 32: 997, 33: 976, 34: 956, 35: 937, 36: 919,
    37: 901, 38: 884, 39: 867, 40: 851, 41: 835, 42: 820, 43: 806,
    44: 792, 45: 778, 46: 765, 47: 752, 48: 740, 49: 728, 50: 716,
    51: 705, 52: 694, 53: 683, 54: 673, 55: 663, 56: 653, 57: 644,
    58: 635, 59: 626, 60: 617, 61: 609, 62: 601, 63: 593, 64: 585,
    65: 578, 66: 571, 67: 564, 68: 557, 69: 550, 70: 544, 71: 538,
    72: 532, 73: 526, 74: 520, 75: 515, 76: 509, 77: 504, 78: 499,
    79: 494, 80: 489, 81: 484, 82: 480, 83: 475, 84: 471, 85: 467,
    86: 463, 87: 459, 88: 455, 89: 451, 90: 447, 91: 443, 92: 440,
    93: 436, 94: 433, 95: 429, 96: 426, 97: 423, 98: 419, 99: 416,
    100: 413, 101: 410, 102: 407, 103: 404, 104: 401, 105: 399, 106: 396,
    107: 393, 108: 391, 109: 388, 110: 385, 111: 383, 112: 381, 113: 378,
    114: 376, 115: 373, 116: 371, 117: 369, 118: 366, 119: 364, 120: 362,
    121: 360, 122: 358, 123: 356, 124: 354, 125: 352, 126: 350, 127: 348,
    128: 346, 129: 344, 130: 342, 131: 340, 132: 338, 133: 337, 134: 335,
    135: 333, 136: 331, 137: 330, 138: 328, 139: 326, 140: 325, 141: 323,
    142: 321, 143: 320, 144: 318, 145: 317, 146: 315, 147: 314, 148: 312,
    149: 311, 150: 309, 151: 308, 152: 306, 153: 305, 154: 304, 155: 302,
    156: 301, 157: 299, 158: 298, 159: 297, 160: 295, 161: 294, 162: 293,
    163: 291, 164: 290, 165: 289, 166: 288, 167: 286, 168: 285, 169: 284,
    170: 283, 171: 281, 172: 280, 173: 279, 174: 278, 175: 277, 176: 276,
    177: 274, 178: 273, 179: 272, 180: 271, 181: 270, 182: 269, 183: 268,
    184: 267, 185: 266, 186: 265, 187: 264, 188: 263, 189: 262, 190: 261,
    191: 260, 192: 259, 193: 258, 194: 257, 195: 256, 196: 255, 197: 254,
    198: 253, 199: 252, 200: 251, 201: 250, 202: 249, 203: 249, 204: 248,
    205: 247, 206: 246, 207: 245, 208: 244, 209: 244, 210: 243, 211: 242,
    212: 241, 213: 240, 214: 240, 215: 239, 216: 238, 217: 237, 218: 237,
    219: 236, 220: 235, 221: 235, 222: 234, 223: 233, 224: 232, 225: 232,
    226: 231, 227: 230, 228: 230, 229: 229, 230: 228, 231: 228, 232: 227,
    233: 226, 234: 226, 235: 225, 236: 225, 237: 224, 238: 223, 239: 223,
    240: 222, 241: 221, 242: 221, 243: 220, 244: 220, 245: 219, 246: 218,
    247: 218, 248: 217, 249: 217, 250: 216, 251: 215, 252: 215, 253: 214,
    254: 214, 255: 213, 256: 213, 257: 212, 258: 211, 259: 211, 260: 210,
    261: 210, 262: 209,
}


# ── 1. PULL & PREPARE DATA ─────────────────────────────────────────────────

def pull_data():
    """Pull seasonal stats, roster info, draft data, and player descriptors via nflreadpy."""
    print("Pulling seasonal player stats...")
    stats_pl = nflr.load_player_stats(seasons=SEASONS, summary_level="reg")
    stats = stats_pl.to_pandas()

    print("Pulling roster data...")
    rosters_pl = nflr.load_rosters(seasons=SEASONS)
    rosters = rosters_pl.to_pandas()

    print("Pulling player descriptors (all players including rookies)...")
    all_players_pl = nflr.load_players()
    all_players = all_players_pl.to_pandas()

    print("Pulling draft picks...")
    draft_picks_pl = nflr.load_draft_picks()
    draft_picks = draft_picks_pl.to_pandas()

    return stats, rosters, all_players, draft_picks


def calculate_fantasy_points(stats_df):
    """
    Calculate 0.5 PPR fantasy points.
    nflreadpy provides fantasy_points (standard) and fantasy_points_ppr (full PPR).
    0.5 PPR = standard + 0.5 * receptions
    """
    df = stats_df.copy()

    if "fantasy_points" in df.columns and "receptions" in df.columns:
        df["receptions"] = pd.to_numeric(df["receptions"], errors="coerce").fillna(0)
        std_fp = pd.to_numeric(df["fantasy_points"], errors="coerce").fillna(0)
        df["fantasy_points_half_ppr"] = std_fp + 0.5 * df["receptions"]
    else:
        # Fallback: manual calculation
        SCORING = {
            "passing_yards": 0.04, "passing_tds": 4, "passing_interceptions": -2,
            "rushing_yards": 0.1, "rushing_tds": 6, "receptions": 0.5,
            "receiving_yards": 0.1, "receiving_tds": 6,
            "rushing_fumbles_lost": -2, "receiving_fumbles_lost": -2,
        }
        df["fantasy_points_half_ppr"] = 0.0
        for col, mult in SCORING.items():
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
                df["fantasy_points_half_ppr"] += df[col] * mult

    return df


def merge_bio_data(stats_df, rosters_df):
    """Merge age/position/birthday from roster data onto stats."""
    # nflreadpy rosters use 'gsis_id' and 'full_name', stats use 'player_id' and 'player_display_name'
    # Deduplicate rosters to one row per player per season
    roster_dedup = rosters_df.drop_duplicates(subset=["gsis_id", "season"])
    roster_cols = ["gsis_id", "season", "position", "birth_date", "full_name", "rookie_year", "years_exp", "draft_number"]
    available = [c for c in roster_cols if c in roster_dedup.columns]

    if "player_id" in stats_df.columns and "gsis_id" in roster_dedup.columns:
        merged = stats_df.merge(
            roster_dedup[available],
            left_on=["player_id", "season"],
            right_on=["gsis_id", "season"],
            how="left",
            suffixes=("", "_roster"),
        )
    else:
        # Fallback: name merge
        print("Warning: falling back to name merge")
        merged = stats_df.merge(
            roster_dedup.drop_duplicates(subset=["full_name", "season"]),
            left_on=["player_display_name", "season"],
            right_on=["full_name", "season"],
            how="left",
            suffixes=("", "_roster"),
        )

    # Calculate age from birth_date
    if "birth_date" in merged.columns:
        merged["birth_date"] = pd.to_datetime(merged["birth_date"], errors="coerce")
        merged["age"] = merged.apply(
            lambda r: r["season"] - r["birth_date"].year
            if pd.notna(r["birth_date"]) else np.nan,
            axis=1,
        )

    # Consolidate position: prefer stats position, fill gaps from roster
    if "position_roster" in merged.columns:
        merged["position"] = merged["position"].fillna(merged["position_roster"])

    # Normalize player name column
    if "player_display_name" in merged.columns:
        merged["player_name"] = merged["player_display_name"]
    elif "full_name" in merged.columns and "player_name" not in merged.columns:
        merged["player_name"] = merged["full_name"]

    return merged


# ── 2. AGING CURVES ────────────────────────────────────────────────────────

def build_aging_curves(df):
    """
    Build positional aging curves using the delta method:
    For each player-season pair, compute the year-over-year change in
    fantasy points and average those deltas by position and age.
    Returns a dict of {position: {age: expected_pct_of_peak}}.
    """
    curves = {}

    for pos in POSITIONS:
        pos_df = df[df["position"] == pos].copy()
        pos_df = pos_df.dropna(subset=["age", "fantasy_points_half_ppr"])
        pos_df = pos_df.sort_values(["player_name", "season"])

        # Year-over-year deltas
        pos_df["prev_fp"] = pos_df.groupby("player_name")["fantasy_points_half_ppr"].shift(1)
        pos_df["delta"] = pos_df["fantasy_points_half_ppr"] - pos_df["prev_fp"]
        pos_df = pos_df.dropna(subset=["delta"])

        # Average delta by age
        avg_delta = pos_df.groupby("age")["delta"].mean()

        # Build cumulative curve, normalized so peak = 1.0
        ages = sorted(avg_delta.index)
        if not ages:
            curves[pos] = {}
            continue

        cumulative = {}
        running = 0
        for a in ages:
            running += avg_delta.get(a, 0)
            cumulative[int(a)] = running

        # Normalize to peak
        peak = max(cumulative.values()) if cumulative else 1
        if peak <= 0:
            peak = 1
        curves[pos] = {a: round(v / peak, 3) for a, v in cumulative.items()}

    return curves


def get_expected_production_curve(curves, position, current_age):
    """
    Given aging curves, return a list of expected production multipliers
    for the next PROJECTION_YEARS years.
    """
    curve = curves.get(position, {})
    if not curve:
        # Fallback: gentle linear decline
        return [max(0, 1.0 - 0.05 * y) for y in range(PROJECTION_YEARS)]

    current_pct = curve.get(current_age, 0.85)
    if current_pct <= 0:
        current_pct = 0.5

    multipliers = []
    for y in range(PROJECTION_YEARS):
        future_age = current_age + y
        future_pct = curve.get(future_age, None)
        if future_pct is None:
            # Extrapolate decline
            last_known = max([a for a in curve if a <= future_age], default=future_age)
            years_past = future_age - last_known
            future_pct = max(0, curve.get(last_known, 0.5) - 0.08 * years_past)
        multipliers.append(round(future_pct / current_pct, 3))

    return multipliers


# ── 3. SCARCITY & DURABILITY ───────────────────────────────────────────────

def calculate_positional_scarcity(df, season):
    """
    For a given season, calculate how replaceable each position is based on
    actual league roster demand (starters × teams).
    Returns a dict of {position: scarcity_score} where higher = scarcer.
    """
    season_df = df[(df["season"] == season) & (df["position"].isin(POSITIONS))]
    scarcity = {}

    flex_share = STARTERS.get("FLEX", 0) / len(FLEX_ELIGIBLE) if FLEX_ELIGIBLE else 0
    demand = {}
    for pos in POSITIONS:
        base = STARTERS.get(pos, 0)
        flex = flex_share if pos in FLEX_ELIGIBLE else 0
        demand[pos] = int(round((base + flex) * NUM_TEAMS))

    for pos in POSITIONS:
        pos_players = season_df[season_df["position"] == pos].sort_values(
            "fantasy_points_half_ppr", ascending=False
        )
        if len(pos_players) < 5:
            scarcity[pos] = 1.0
            continue

        n_starters = demand.get(pos, 12)
        n_bench = n_starters + NUM_TEAMS

        starter_avg = pos_players.head(n_starters)["fantasy_points_half_ppr"].mean()
        replacement_avg = (
            pos_players.iloc[n_bench : n_bench + NUM_TEAMS]["fantasy_points_half_ppr"].mean()
            if len(pos_players) >= n_bench + NUM_TEAMS
            else pos_players.tail(NUM_TEAMS)["fantasy_points_half_ppr"].mean()
        )

        if replacement_avg > 0:
            scarcity[pos] = round(starter_avg / replacement_avg, 2)
        else:
            scarcity[pos] = round(starter_avg / max(1, 1), 2)

    max_s = max(scarcity.values()) if scarcity else 1
    return {pos: round(v / max_s, 3) for pos, v in scarcity.items()}


def calculate_durability(df, player_name):
    """
    Score a player's durability based on games played consistency.
    Weights recent seasons more heavily. Returns a score from 0 to 1.
    """
    player_df = df[df["player_name"] == player_name].sort_values("season")
    if player_df.empty:
        return 0.5

    games_col = "games" if "games" in player_df.columns else None
    if games_col is None:
        return 0.7

    games = pd.to_numeric(player_df[games_col], errors="coerce").dropna()
    if games.empty:
        return 0.7

    if len(games) == 1:
        return round(min(games.iloc[0] / 17, 1.0), 3)

    weights = [1.0] * len(games)
    weights[-1] = 2.0
    if len(weights) > 1:
        weights[-2] = 1.5
    weighted_avg = np.average(games.values, weights=weights)
    consistency = 1 - (games.std() / max(games.mean(), 1))

    game_score = min(weighted_avg / 17, 1.0)
    return round(0.6 * game_score + 0.4 * max(consistency, 0), 3)


# ── 3b. DRAFT CAPITAL ────────────────────────────────────────────────────

def build_draft_value_lookup():
    """
    Build a normalized 0-1 lookup from pick number to draft capital score.
    Uses embedded OTC (Over The Cap) values.
    """
    max_val = max(OTC_DRAFT_VALUES.values())
    return {pick: round(val / max_val, 4) for pick, val in OTC_DRAFT_VALUES.items()}


# Positional multiplier for draft capital in keeper leagues
# RB/WR drafted high are more valuable as keepers than QBs (1-QB league)
DRAFT_POS_MULTIPLIER = {"QB": 0.75, "RB": 1.15, "WR": 1.10, "TE": 1.0}

# Cap on draft capital score — rookies shouldn't outscore proven elite producers
DRAFT_CAPITAL_CAP = 0.55


def calculate_draft_capital_score(player_row, draft_value_lookup, latest_season):
    """
    Calculate a keeper value score based purely on draft capital for players
    without enough game history (rookies, injured players, etc.).
    Returns dict with draft_score or None if player has no draft info.
    """
    draft_pick = player_row.get("draft_pick") or player_row.get("draft_number")
    draft_round = player_row.get("draft_round")
    position = player_row.get("position", "")
    rookie_season = player_row.get("rookie_year") or player_row.get("rookie_season") or player_row.get("draft_year")

    if pd.isna(draft_pick) or pd.isna(position) or position not in POSITIONS:
        return None

    draft_pick = int(draft_pick)
    if pd.notna(rookie_season):
        rookie_season = int(rookie_season)
    else:
        return None

    base_score = draft_value_lookup.get(draft_pick, 0)
    if base_score == 0 and pd.notna(draft_round):
        round_num = int(draft_round)
        estimated_pick = (round_num - 1) * 32 + 16
        base_score = draft_value_lookup.get(estimated_pick, max(0, 0.15 - round_num * 0.02))

    pos_mult = DRAFT_POS_MULTIPLIER.get(position, 1.0)

    years_since_draft = max(0, latest_season - rookie_season)
    decay = DRAFT_CAPITAL_DECAY ** years_since_draft

    birth_date = player_row.get("birth_date")
    if pd.notna(birth_date):
        try:
            bd = pd.to_datetime(birth_date)
            age = latest_season - bd.year
        except Exception:
            age = 22 if years_since_draft == 0 else 22 + years_since_draft
    else:
        age = 22 if years_since_draft == 0 else 22 + years_since_draft

    draft_score = base_score * pos_mult * decay
    return {
        "draft_score": round(min(draft_score, DRAFT_CAPITAL_CAP), 4),
        "age": int(age),
        "position": position,
        "draft_round": int(draft_round) if pd.notna(draft_round) else None,
        "draft_pick": draft_pick,
        "years_since_draft": years_since_draft,
    }


# ── 4. COMPOSITE KEEPER VALUE ──────────────────────────────────────────────

def get_weighted_production(df, player_name, latest_season, years_exp=99, n_seasons=3, position=None):
    """
    Calculate a production average across recent seasons.
    For veterans (>=5 years exp): recency-weighted across 3 seasons (3x/2x/1x).
    For younger players (<5 years exp): only use the most recent season.
    Returns (weighted_full_season_fp, total_games) or (None, 0) if no data.
    """
    # Young players: only use the most recent season
    if years_exp <= 4:
        n_seasons = 1

    player_seasons = df[
        (df["player_name"] == player_name)
        & (df["season"] >= latest_season - n_seasons + 1)
        & (df["season"] <= latest_season)
    ].sort_values("season", ascending=False)

    if player_seasons.empty:
        return None, 0

    # Veterans 7+ years: equal weight across 3 seasons
    # Veterans 5-6 years: recency-weighted; QBs use 2x/2x/1x, others use 3x/2x/1x
    if years_exp >= 7:
        season_weights = {latest_season: 1.0, latest_season - 1: 1.0, latest_season - 2: 1.0}
    elif position == "QB":
        season_weights = {latest_season: 2.0, latest_season - 1: 2.0, latest_season - 2: 1.0}
    else:
        season_weights = {latest_season: 3.0, latest_season - 1: 2.0, latest_season - 2: 1.0}
    weighted_ppg_sum = 0.0
    weight_sum = 0.0

    for _, row in player_seasons.iterrows():
        fp = row.get("fantasy_points_half_ppr", 0)
        gp = pd.to_numeric(row.get("games", 0), errors="coerce")
        if pd.isna(gp) or gp < 1 or fp <= 0:
            continue
        ppg = fp / gp
        w = season_weights.get(row["season"], 1.0)
        weighted_ppg_sum += ppg * w
        weight_sum += w

    if weight_sum == 0:
        return None, 0

    weighted_ppg = weighted_ppg_sum / weight_sum

    # Floor: weighted average can't drop below 70% of best recent season PPG
    if n_seasons > 1:
        best_ppg = max(
            (r.get("fantasy_points_half_ppr", 0) / max(pd.to_numeric(r.get("games", 1), errors="coerce"), 1))
            for _, r in player_seasons.iterrows()
            if pd.to_numeric(r.get("games", 0), errors="coerce") >= 1 and r.get("fantasy_points_half_ppr", 0) > 0
        )
        weighted_ppg = max(weighted_ppg, best_ppg * 0.80)

    return weighted_ppg * 17, int(player_seasons["games"].sum())


def calculate_keeper_values(df, curves, scarcity, draft_value_lookup=None, all_players_df=None):
    """
    Calculate composite keeper value for every player in the most recent season.
    Includes rookies and low-sample players via draft capital scoring.
    Uses recency-weighted multi-season production for current_value.
    """
    latest_season = df["season"].max()
    current = df[
        (df["season"] == latest_season) & (df["position"].isin(POSITIONS))
    ].copy()

    if current.empty:
        print("No data for latest season!")
        return pd.DataFrame()

    # ── First pass: compute per-game normalized FP for ALL players at skill positions.
    qualified = []
    players_with_stats = set()
    for _, row in current.iterrows():
        pos = row.get("position", "UNK")
        if pos not in POSITIONS:
            continue
        fp = row.get("fantasy_points_half_ppr", 0)
        gp = int(pd.to_numeric(row.get("games", 17), errors="coerce") or 17)
        name = row.get("player_name", "Unknown")
        players_with_stats.add(name)
        if gp < 1 or fp <= 0:
            continue

        # Use weighted multi-season production instead of just latest season
        yrs_exp = row.get("years_exp")
        if pd.notna(yrs_exp):
            years_exp = int(yrs_exp)
        else:
            rookie_yr = row.get("rookie_year") or row.get("rookie_season") or row.get("draft_year")
            years_exp = max(0, latest_season - int(rookie_yr)) if pd.notna(rookie_yr) else 99
        weighted_fp, _ = get_weighted_production(df, name, latest_season, years_exp=years_exp, position=pos)
        if weighted_fp is None or weighted_fp <= 0:
            ppg = fp / max(gp, 1)
            weighted_fp = ppg * 17

        confidence = min(gp / MIN_GAMES, 1.0)
        qualified.append({"row": row, "pos": pos, "gp": gp, "full_season_fp": weighted_fp, "confidence": confidence, "name": name})

    # ── Compute replacement-level FP per position
    pos_fps = defaultdict(list)
    for q in qualified:
        if q["confidence"] >= 1.0:
            pos_fps[q["pos"]].append(q["full_season_fp"])

    KEEPER_DEPTH = {"QB": 12, "RB": 20, "WR": 20, "TE": 8}
    replacement_fp = {}
    for pos in POSITIONS:
        fps = sorted(pos_fps.get(pos, []), reverse=True)
        n_kept = KEEPER_DEPTH.get(pos, 12)
        if len(fps) > n_kept:
            replacement_fp[pos] = fps[n_kept]
        elif fps:
            replacement_fp[pos] = fps[-1]
        else:
            replacement_fp[pos] = 0

    # ── Compute max VOR across all positions for normalization
    max_vor = 1
    for q in qualified:
        vor = q["full_season_fp"] - replacement_fp.get(q["pos"], 0)
        if vor > max_vor:
            max_vor = vor

    results = []

    # ── Score players WITH stats (production-based, blended with draft capital)
    for q in qualified:
        row = q["row"]
        name = q["name"]
        pos = q["pos"]
        age = row.get("age", 27)
        gp = q["gp"]
        full_season_fp = q["full_season_fp"]
        confidence = q["confidence"]

        if pd.isna(age):
            age = 27
        age = int(age)

        repl = replacement_fp.get(pos, 0)
        vor = max(full_season_fp - repl, 0)
        current_value = vor / max_vor

        prod_curve = get_expected_production_curve(curves, pos, age)
        if vor > 0:
            future_value = 0
            for y, mult in enumerate(prod_curve):
                future_fp = full_season_fp * mult
                future_vor = max(future_fp - repl, 0)
                future_value += future_vor * ((1 - DISCOUNT_RATE) ** y)
            max_longevity = max_vor * PROJECTION_YEARS
            longevity_score = min(future_value / max(max_longevity, 1), 1.0)
        else:
            longevity_score = 0.0

        scarcity_score = scarcity.get(pos, 0.5)
        durability_score = calculate_durability(df, name)

        production_score = (
            WEIGHTS["current_season"] * current_value
            + WEIGHTS["longevity"] * longevity_score
            + WEIGHTS["scarcity"] * scarcity_score
            + WEIGHTS["durability"] * durability_score
        ) * confidence

        # Blend with draft capital for low-sample players
        draft_score = 0.0
        if draft_value_lookup and all_players_df is not None:
            player_match = all_players_df[all_players_df["display_name"] == name]
            if not player_match.empty:
                dc = calculate_draft_capital_score(player_match.iloc[0], draft_value_lookup, latest_season)
                if dc:
                    draft_score = dc["draft_score"]

        production_weight = min(gp / DRAFT_BLEND_GAMES, 1.0)
        composite = production_weight * production_score + (1 - production_weight) * draft_score

        results.append({
            "player_name": name,
            "position": pos,
            "age": age,
            "season": latest_season,
            "games_played": gp,
            "fantasy_points": round(full_season_fp, 1),
            "current_value": round(current_value, 3),
            "longevity_score": round(longevity_score, 3),
            "scarcity_score": round(scarcity_score, 3),
            "durability_score": round(durability_score, 3),
            "draft_capital_score": round(draft_score, 3),
            "keeper_value": round(composite, 3),
            "projected_years_elite": sum(1 for m in prod_curve if m > 0.7),
        })

    # ── Score players WITHOUT stats (draft capital only — rookies, injured, etc.)
    if draft_value_lookup and all_players_df is not None:
        active_statuses = {"ACT", "RES", "RSR", "PUP"}
        no_stat_players = all_players_df[
            (all_players_df["position"].isin(POSITIONS))
            & (all_players_df["status"].isin(active_statuses))
            & (~all_players_df["display_name"].isin(players_with_stats))
            & (all_players_df["draft_pick"].notna())
        ]

        draft_only_count = 0
        for _, player_row in no_stat_players.iterrows():
            dc = calculate_draft_capital_score(player_row, draft_value_lookup, latest_season)
            if dc is None or dc["draft_score"] < 0.01:
                continue

            name = player_row.get("display_name", "Unknown")
            pos = dc["position"]
            age = dc["age"]
            draft_score = dc["draft_score"]

            prod_curve = get_expected_production_curve(curves, pos, age)
            longevity_score = sum(1 for m in prod_curve if m > 0.7) / PROJECTION_YEARS

            results.append({
                "player_name": name,
                "position": pos,
                "age": age,
                "season": latest_season,
                "games_played": 0,
                "fantasy_points": 0.0,
                "current_value": 0.0,
                "longevity_score": round(longevity_score, 3),
                "scarcity_score": round(scarcity.get(pos, 0.5), 3),
                "durability_score": 0.5,
                "draft_capital_score": round(draft_score, 3),
                "keeper_value": round(draft_score, 3),
                "projected_years_elite": sum(1 for m in prod_curve if m > 0.7),
            })
            draft_only_count += 1

        print(f"  Added {draft_only_count} draft-capital-only players (rookies/no stats)")

    result_df = pd.DataFrame(results)
    result_df = result_df.sort_values("keeper_value", ascending=False).reset_index(drop=True)
    result_df.index += 1  # 1-based ranking
    result_df.index.name = "rank"

    return result_df


# ── 5. OUTPUTS ──────────────────────────────────────────────────────────────

def save_outputs(values_df, curves):
    """Save results to CSV and JSON."""
    csv_path = os.path.join(OUTPUT_DIR, "keeper_values.csv")
    values_df.to_csv(csv_path)
    print(f"Saved keeper values to {csv_path}")

    for pos in POSITIONS:
        pos_df = values_df[values_df["position"] == pos].head(30)
        pos_path = os.path.join(OUTPUT_DIR, f"top_{pos.lower()}_keepers.csv")
        pos_df.to_csv(pos_path)
        print(f"Saved top {pos} keepers to {pos_path}")

    curves_path = os.path.join(OUTPUT_DIR, "aging_curves.json")
    with open(curves_path, "w") as f:
        json.dump(curves, f, indent=2)
    print(f"Saved aging curves to {curves_path}")

    report_path = os.path.join(OUTPUT_DIR, "keeper_report.txt")
    with open(report_path, "w") as f:
        f.write("KEEPER VALUE REPORT\n")
        f.write(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
        f.write(f"Seasons analyzed: {SEASONS[0]}-{SEASONS[-1]}\n")
        f.write(f"Scoring: 0.5 PPR\n")
        f.write("=" * 70 + "\n\n")

        f.write("TOP 50 OVERALL KEEPER VALUES\n")
        f.write("-" * 70 + "\n")
        top50 = values_df.head(50)
        f.write(f"{'Rank':<6}{'Player':<25}{'Pos':<5}{'Age':<5}{'FP':<8}"
                f"{'Keeper Val':<12}{'Yrs Elite':<10}\n")
        f.write("-" * 70 + "\n")
        for rank, row in top50.iterrows():
            f.write(f"{rank:<6}{row['player_name']:<25}{row['position']:<5}"
                    f"{row['age']:<5}{row['fantasy_points']:<8}"
                    f"{row['keeper_value']:<12}{row['projected_years_elite']:<10}\n")

        for pos in POSITIONS:
            f.write(f"\n\nTOP 20 {pos} KEEPERS\n")
            f.write("-" * 70 + "\n")
            pos_df = values_df[values_df["position"] == pos].head(20)
            for rank, row in pos_df.iterrows():
                f.write(f"{rank:<6}{row['player_name']:<25}{row['age']:<5}"
                        f"{row['fantasy_points']:<8}{row['keeper_value']:<12}"
                        f"{row['projected_years_elite']:<10}\n")

    print(f"Saved report to {report_path}")


# ── MAIN ────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("FANTASY FOOTBALL KEEPER VALUE MODEL")
    print("=" * 60)

    # Pull data
    stats, rosters, all_players, draft_picks = pull_data()

    # Calculate fantasy points (0.5 PPR)
    print("\nCalculating fantasy points (0.5 PPR)...")
    stats = calculate_fantasy_points(stats)

    # Merge biographical data
    print("Merging player bio data...")
    df = merge_bio_data(stats, rosters)

    # Build aging curves
    print("Building positional aging curves...")
    curves = build_aging_curves(df)
    for pos in POSITIONS:
        peak_ages = [a for a, v in curves.get(pos, {}).items() if v > 0.9]
        if peak_ages:
            print(f"  {pos}: peak years {min(peak_ages)}-{max(peak_ages)}")

    # Calculate scarcity
    latest = df["season"].max()
    print(f"\nCalculating positional scarcity (based on {latest})...")
    scarcity = calculate_positional_scarcity(df, latest)
    for pos, s in scarcity.items():
        print(f"  {pos}: {s}")

    # Build draft value lookup
    print("\nBuilding draft capital lookup...")
    draft_value_lookup = build_draft_value_lookup()
    print(f"  {len(draft_value_lookup)} pick values loaded")

    # Score keeper values (now includes rookies via draft capital)
    print("\nScoring keeper values...")
    values = calculate_keeper_values(df, curves, scarcity, draft_value_lookup, all_players)

    if values.empty:
        print("ERROR: No keeper values calculated. Check data.")
        return

    # Display top results
    print("\n" + "=" * 60)
    print("TOP 25 KEEPER VALUES")
    print("=" * 60)
    print(values.head(25).to_string())

    # Save everything
    print("\nSaving outputs...")
    save_outputs(values, curves)

    print("\nDone! Check the 'output/' directory for full results.")


if __name__ == "__main__":
    main()
