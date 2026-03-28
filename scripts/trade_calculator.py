"""
Fantasy Football Trade Calculator
===================================
Evaluates trades using non-linear value curves, package tax (penalty for
multi-player sides), lineup optimization, and keeper value projection.

Designed for keeper leagues — "four quarters never equal a dollar."

Usage:
    # As a module
    from trade_calculator import TradeCalculator
    calc = TradeCalculator(keeper_values_path="output/keeper_values.csv")
    result = calc.evaluate_trade(team_a_roster, team_b_roster,
                                  a_gives=["Player X"], b_gives=["Player Y"])

    # Standalone CLI
    python trade_calculator.py --demo
"""

import pandas as pd
import numpy as np
import json
import sys
import os
from dataclasses import dataclass, field
from itertools import combinations

from league_config import (
    KEEPER_SLOTS, ROSTER_SIZE, STARTERS as _BASE_STARTERS,
    FLEX_ELIGIBLE,
)

# ── LEAGUE SETTINGS ─────────────────────────────────────────────────────────

# Extend shared starters with K/DEF for trade calculator lineup optimization
STARTING_SLOTS = {**_BASE_STARTERS, "K": 1, "DEF": 1}

# ── VALUE CONFIGURATION ────────────────────────────────────────────────────

# Exponent for the elite value curve.
# Applied to normalized surplus so stars are worth exponentially more.
# 1.0 = linear, 1.5 = moderate, 2.0 = aggressive
ELITE_EXPONENT = 1.5

# How much keeper/longevity value matters vs current production
KEEPER_WEIGHT_IN_TRADE = 0.45

# Positional replacement-level baselines (weekly points, 0.5 PPR)
REPLACEMENT_LEVEL = {
    "QB":  14.0,
    "RB":   6.0,
    "WR":   6.5,
    "TE":   4.5,
    "K":    7.0,
    "DEF":  6.0,
}

# Position-specific scarcity multipliers for the elite curve
POS_MULTIPLIER = {
    "QB":  0.85,   # deeper position (1-QB league)
    "RB":  1.30,   # scarce + volatile + short prime = premium (calibrated via trade history)
    "WR":  0.95,   # slight discount vs RB scarcity (calibrated via trade history)
    "TE":  1.10,   # elite TEs are rare
    "K":   0.30,   # fungible
    "DEF": 0.30,   # fungible
}

# ── PACKAGE TAX ─────────────────────────────────────────────────────────────
# Penalty applied to the multi-player side of a trade.
# The side sending MORE assets gets their total value reduced.
# This prevents "4 mediocre guys = 1 star" trades.

PACKAGE_TAX = {
    0: 0.00,   # equal number of assets — no penalty
    1: 0.10,   # 1 extra asset: -10%
    2: 0.20,   # 2 extra assets: -20%
    3: 0.30,   # 3+ extra assets: -30%
}

def get_package_tax(asset_diff):
    """Get the package tax rate for a given asset count difference."""
    diff = abs(asset_diff)
    if diff >= 3:
        return PACKAGE_TAX[3]
    return PACKAGE_TAX.get(diff, 0.0)


# ── PICK VALUATION ──────────────────────────────────────────────────────────
# Perceived-value curve: reflects market/trade value, not expected production.
# Round 1 is deliberately flat (a "first rounder" carries prestige).
# Sharp cliff between round 1 and 2 captures the psychological round premium.
# Future picks depreciate at 80%/year.

PICK_FUTURE_DEPRECIATION = 0.80

LEAGUE_SIZE = 12

# Per-slot values for rounds 1-3 (index 0 = slot 1). Mirrors calculations.js.
# Scaled below elite player values — keeper league draft pool is ~97th+ best.
ROUND_1_VALUES = [5500, 5200, 4900, 4600, 4250, 3900, 3600, 3300, 3100, 2900, 2750, 2600]
ROUND_2_VALUES = [1800, 1650, 1500, 1400, 1300, 1150, 1000, 850, 725, 650, 575, 500]
ROUND_3_VALUES = [450, 425, 400, 385, 370, 350, 325, 300, 280, 265, 255, 250]

PICK_ROUND_VALUES = {1: ROUND_1_VALUES, 2: ROUND_2_VALUES, 3: ROUND_3_VALUES}

LATE_ROUND_VALUES = {4: 200, 5: 150, 6: 100, 7: 75, 8: 50}

# Consolidation discount: multiple picks combined to match one are worth less.
CONSOLIDATION_DISCOUNT = {1: 1.0, 2: 0.85, 3: 0.70}


def get_pick_value(round_num, slot, years_out=0):
    """
    Calculate a draft pick's perceived trade value.
    Uses per-slot lookup for rounds 1-3, flat values for 4-8.
    """
    clamped_slot = max(1, min(slot, LEAGUE_SIZE))
    round_vals = PICK_ROUND_VALUES.get(round_num)

    if round_vals:
        base = round_vals[clamped_slot - 1]
    else:
        base = LATE_ROUND_VALUES.get(round_num, 50)

    return round(base * (PICK_FUTURE_DEPRECIATION ** years_out))


def apply_consolidation_discount(total_pick_value, pick_count):
    """Discount combined pick value when trading up (multiple picks for one)."""
    if pick_count <= 1:
        return total_pick_value
    factor = CONSOLIDATION_DISCOUNT.get(min(pick_count, 3), 0.70)
    return round(total_pick_value * factor)


# ── CORE: TRADE VALUE ENGINE ───────────────────────────────────────────────

class TradeCalculator:
    """
    Evaluates fantasy trades using:
    1. Non-linear value curve (elite premium)
    2. Package tax (penalizes multi-player side)
    3. Roster-context lineup optimization
    4. Multi-year keeper value projection
    """

    def __init__(self, keeper_values_path="output/keeper_values.csv"):
        """Load keeper values from the model output."""
        self.keeper_values = None
        if os.path.exists(keeper_values_path):
            self.keeper_values = pd.read_csv(keeper_values_path, index_col=0)
        else:
            pass  # keeper values not available — will use passed-in data only

    # ── Player-Level Value ──────────────────────────────────────────────

    def get_player_value(self, player_name, position=None, bfb_value=None, weekly_avg_override=None):
        """
        Get a player's complete value profile.

        Can use keeper CSV data, passed-in bfbValue, or weekly_avg — whichever
        is available. bfb_value from the API takes priority for trade value;
        keeper CSV provides longevity/keeper scores.
        """
        info = self._lookup_player(player_name)
        if info is None and position:
            info = {
                "player_name": player_name,
                "position": position,
                "fantasy_points": REPLACEMENT_LEVEL.get(position, 5) * 17,
                "keeper_value": 0.0,
                "longevity_score": 0.3,
            }

        if info is None:
            return None

        pos = info.get("position", "UNK")
        season_pts = info.get("fantasy_points", 0)
        weekly_avg = weekly_avg_override if weekly_avg_override is not None else season_pts / 17

        # Surplus over replacement
        replacement = REPLACEMENT_LEVEL.get(pos, 5.0)
        surplus = max(0, weekly_avg - replacement)

        # Apply elite curve to production surplus
        raw_trade_value = self._apply_elite_curve(surplus, pos)

        # Blend in keeper/longevity value
        keeper_val = info.get("keeper_value", 0)
        blended = (
            (1 - KEEPER_WEIGHT_IN_TRADE) * raw_trade_value
            + KEEPER_WEIGHT_IN_TRADE * keeper_val * 100
        )

        # If API provided a bfbValue, use it as the primary trade value
        # (it already incorporates keeper model + KTC normalization)
        if bfb_value is not None and bfb_value > 0:
            trade_value = bfb_value
        else:
            trade_value = blended

        return {
            "player_name": player_name,
            "position": pos,
            "weekly_avg": round(weekly_avg, 1),
            "surplus_over_replacement": round(surplus, 1),
            "raw_trade_value": round(raw_trade_value, 2),
            "keeper_value": round(keeper_val, 3),
            "blended_trade_value": round(blended, 2),
            "trade_value": round(trade_value, 2),
            "longevity_score": info.get("longevity_score", 0),
            "projected_years_elite": info.get("projected_years_elite", 0),
        }

    def _apply_elite_curve(self, surplus, position):
        """
        Apply non-linear scaling so elite surplus is worth disproportionately more.

        This is THE key mechanism that prevents "two average guys = one stud."

        Example with ELITE_EXPONENT = 1.5:
            surplus=5  -> value=11.2
            surplus=10 -> value=31.6
            surplus=15 -> value=58.1
            surplus=20 -> value=89.4

        A 20-surplus player is worth ~8x a 5-surplus player, not 4x.
        """
        if surplus <= 0:
            return 0

        multiplier = POS_MULTIPLIER.get(position, 1.0)
        return (surplus ** ELITE_EXPONENT) * multiplier

    # ── Lineup Optimization ─────────────────────────────────────────────

    def optimize_lineup(self, roster):
        """
        Given a roster (list of player dicts with 'player_name', 'position',
        'weekly_avg'), find the optimal starting lineup.

        Returns (starters, bench, total_points).
        """
        players = sorted(roster, key=lambda p: p.get("weekly_avg", 0), reverse=True)

        starters = []
        remaining = list(players)

        for pos, count in STARTING_SLOTS.items():
            if pos == "FLEX":
                continue

            pos_players = [p for p in remaining if p.get("position") == pos]
            pos_players.sort(key=lambda p: p.get("weekly_avg", 0), reverse=True)

            for i in range(min(count, len(pos_players))):
                starters.append({**pos_players[i], "slot": pos})
                remaining.remove(pos_players[i])

        flex_candidates = [
            p for p in remaining if p.get("position") in FLEX_ELIGIBLE
        ]
        flex_candidates.sort(key=lambda p: p.get("weekly_avg", 0), reverse=True)

        flex_count = STARTING_SLOTS.get("FLEX", 0)
        for i in range(min(flex_count, len(flex_candidates))):
            starters.append({**flex_candidates[i], "slot": "FLEX"})
            remaining.remove(flex_candidates[i])

        total = sum(s.get("weekly_avg", 0) for s in starters)

        return starters, remaining, round(total, 1)

    # ── Trade Evaluation ────────────────────────────────────────────────

    def evaluate_trade(self, team_a_roster, team_b_roster,
                       a_gives, b_gives,
                       team_a_name="Team A", team_b_name="Team B",
                       a_picks=None, b_picks=None):
        """
        Evaluate a trade between two teams.

        Parameters:
            team_a_roster: list of player dicts for team A's full roster
            team_b_roster: list of player dicts for team B's full roster
            a_gives: list of player names team A is trading away
            b_gives: list of player names team B is trading away
            a_picks: list of pick dicts team A is trading (optional)
            b_picks: list of pick dicts team B is trading (optional)

        Returns a TradeResult with detailed analysis.
        """
        a_picks = a_picks or []
        b_picks = b_picks or []

        # ── Build post-trade rosters
        a_after = [p for p in team_a_roster if p["player_name"] not in a_gives]
        b_after = [p for p in team_b_roster if p["player_name"] not in b_gives]

        a_receives = [p for p in team_b_roster if p["player_name"] in b_gives]
        b_receives = [p for p in team_a_roster if p["player_name"] in a_gives]

        a_after.extend(a_receives)
        b_after.extend(b_receives)

        # ── Optimize lineups before and after
        a_start_before, _, a_pts_before = self.optimize_lineup(team_a_roster)
        b_start_before, _, b_pts_before = self.optimize_lineup(team_b_roster)

        a_start_after, _, a_pts_after = self.optimize_lineup(a_after)
        b_start_after, _, b_pts_after = self.optimize_lineup(b_after)

        # ── Calculate trade values for pieces exchanged
        a_index = self._roster_lookup(team_a_roster)
        b_index = self._roster_lookup(team_b_roster)

        a_player_values = []
        for n in a_gives:
            p = a_index.get(n, {})
            pv = self.get_player_value(
                n, p.get("position"),
                bfb_value=p.get("bfb_value") or p.get("bfbValue"),
                weekly_avg_override=p.get("weekly_avg"),
            )
            if pv:
                a_player_values.append(pv)

        b_player_values = []
        for n in b_gives:
            p = b_index.get(n, {})
            pv = self.get_player_value(
                n, p.get("position"),
                bfb_value=p.get("bfb_value") or p.get("bfbValue"),
                weekly_avg_override=p.get("weekly_avg"),
            )
            if pv:
                b_player_values.append(pv)

        # Raw value sums (before package tax)
        a_raw_value = sum(pv["trade_value"] for pv in a_player_values)
        b_raw_value = sum(pv["trade_value"] for pv in b_player_values)

        # Add pick values
        a_pick_value = sum(
            get_pick_value(p.get("round", 3), p.get("slot", 6), p.get("years_out", 0))
            for p in a_picks
        )
        b_pick_value = sum(
            get_pick_value(p.get("round", 3), p.get("slot", 6), p.get("years_out", 0))
            for p in b_picks
        )

        a_total_assets = len(a_gives) + len(a_picks)
        b_total_assets = len(b_gives) + len(b_picks)

        # ── Apply package tax to the side sending more assets
        asset_diff = a_total_assets - b_total_assets
        tax_rate = get_package_tax(asset_diff)

        if asset_diff > 0:
            # Side A is sending more — tax their total
            a_taxed_value = (a_raw_value + a_pick_value) * (1 - tax_rate)
            b_taxed_value = b_raw_value + b_pick_value
        elif asset_diff < 0:
            # Side B is sending more — tax their total
            a_taxed_value = a_raw_value + a_pick_value
            b_taxed_value = (b_raw_value + b_pick_value) * (1 - tax_rate)
        else:
            a_taxed_value = a_raw_value + a_pick_value
            b_taxed_value = b_raw_value + b_pick_value

        # ── Calculate keeper impact
        a_keeper_before = self._best_keepers_value(team_a_roster)
        a_keeper_after = self._best_keepers_value(a_after)
        b_keeper_before = self._best_keepers_value(team_b_roster)
        b_keeper_after = self._best_keepers_value(b_after)

        # ── Compile result
        result = TradeResult(
            team_a_name=team_a_name,
            team_b_name=team_b_name,
            a_gives=a_gives,
            b_gives=b_gives,
            a_giving_value=round(a_taxed_value, 2),
            b_giving_value=round(b_taxed_value, 2),
            a_raw_value=round(a_raw_value + a_pick_value, 2),
            b_raw_value=round(b_raw_value + b_pick_value, 2),
            a_pick_value=round(a_pick_value, 2),
            b_pick_value=round(b_pick_value, 2),
            package_tax_rate=tax_rate,
            package_tax_side="a" if asset_diff > 0 else "b" if asset_diff < 0 else "none",
            a_player_details=a_player_values,
            b_player_details=b_player_values,
            a_lineup_before=a_pts_before,
            a_lineup_after=a_pts_after,
            b_lineup_before=b_pts_before,
            b_lineup_after=b_pts_after,
            a_lineup_delta=round(a_pts_after - a_pts_before, 1),
            b_lineup_delta=round(b_pts_after - b_pts_before, 1),
            a_keeper_before=round(a_keeper_before, 3),
            a_keeper_after=round(a_keeper_after, 3),
            b_keeper_before=round(b_keeper_before, 3),
            b_keeper_after=round(b_keeper_after, 3),
            a_starters_before=a_start_before,
            a_starters_after=a_start_after,
            b_starters_before=b_start_before,
            b_starters_after=b_start_after,
        )

        return result

    def _best_keepers_value(self, roster):
        """Sum of keeper_value for the top KEEPER_SLOTS players on a roster."""
        values = []
        for p in roster:
            info = self._lookup_player(p["player_name"])
            if info is not None:
                values.append(info.get("keeper_value", 0))
            else:
                values.append(0)
        values.sort(reverse=True)
        return sum(values[:KEEPER_SLOTS])

    @staticmethod
    def _roster_lookup(roster):
        """Build a {player_name: player_dict} index from a roster list."""
        return {p["player_name"]: p for p in roster}

    def _find_player(self, player_name, roster_index):
        """Find a player dict from a pre-built roster index."""
        return roster_index.get(player_name)

    def _lookup_player(self, player_name):
        """Look up a player in the keeper values dataframe."""
        if self.keeper_values is None:
            return None
        matches = self.keeper_values[
            self.keeper_values["player_name"].str.lower() == player_name.lower()
        ]
        if matches.empty:
            matches = self.keeper_values[
                self.keeper_values["player_name"].str.lower().str.contains(
                    player_name.lower(), na=False
                )
            ]
        if matches.empty:
            return None
        return matches.iloc[0].to_dict()

    # ── Trade Suggestions ───────────────────────────────────────────────

    def suggest_trades(self, my_roster, other_roster,
                       my_name="My Team", other_name="Other Team",
                       max_pieces=2, min_improvement=0.5):
        """
        Scan for mutually beneficial trades between two teams.
        """
        suggestions = []

        my_players = [
            (p, self.get_player_value(p["player_name"], p.get("position")))
            for p in my_roster
            if p.get("position") in ["QB", "RB", "WR", "TE"]
        ]
        other_players = [
            (p, self.get_player_value(p["player_name"], p.get("position")))
            for p in other_roster
            if p.get("position") in ["QB", "RB", "WR", "TE"]
        ]

        my_tradeable = [
            (p, v) for p, v in my_players
            if v and v.get("surplus_over_replacement", 0) > 1
        ]
        other_tradeable = [
            (p, v) for p, v in other_players
            if v and v.get("surplus_over_replacement", 0) > 1
        ]

        for my_count in range(1, max_pieces + 1):
            for other_count in range(1, max_pieces + 1):
                for my_combo in combinations(my_tradeable, my_count):
                    for other_combo in combinations(other_tradeable, other_count):
                        my_names = [p["player_name"] for p, _ in my_combo]
                        other_names = [p["player_name"] for p, _ in other_combo]

                        my_val = sum(v.get("trade_value", 0) for _, v in my_combo)
                        other_val = sum(v.get("trade_value", 0) for _, v in other_combo)

                        if my_val > 0 and other_val > 0:
                            ratio = max(my_val, other_val) / min(my_val, other_val)
                            if ratio > 3.0:
                                continue

                        result = self.evaluate_trade(
                            my_roster, other_roster,
                            my_names, other_names,
                            my_name, other_name,
                        )

                        if (result.a_lineup_delta >= min_improvement and
                                result.b_lineup_delta >= min_improvement):
                            result.mutual_benefit = round(
                                result.a_lineup_delta + result.b_lineup_delta, 1
                            )
                            suggestions.append(result)

        suggestions.sort(key=lambda r: r.mutual_benefit, reverse=True)
        return suggestions[:20]

    # ── Positional Needs Analysis ───────────────────────────────────────

    def analyze_roster_needs(self, roster, team_name="Team"):
        """Analyze a roster's strengths and weaknesses by position."""
        starters, bench, total = self.optimize_lineup(roster)

        needs = {}
        for pos in ["QB", "RB", "WR", "TE"]:
            pos_starters = [s for s in starters if s.get("position") == pos]
            pos_bench = [b for b in bench if b.get("position") == pos]
            pos_all = pos_starters + pos_bench

            starter_avg = np.mean([s.get("weekly_avg", 0) for s in pos_starters]) if pos_starters else 0
            replacement = REPLACEMENT_LEVEL.get(pos, 5)
            depth = len(pos_all)

            starter_gap = max(0, replacement * 2 - starter_avg)
            depth_penalty = max(0, 3 - depth) * 2

            need_score = starter_gap + depth_penalty

            needs[pos] = {
                "starter_avg_ppg": round(starter_avg, 1),
                "depth": depth,
                "replacement_level": replacement,
                "surplus": round(starter_avg - replacement, 1),
                "need_score": round(need_score, 1),
                "assessment": self._need_label(need_score),
            }

        return needs

    def _need_label(self, score):
        if score <= 2:
            return "STRENGTH"
        elif score <= 5:
            return "SOLID"
        elif score <= 10:
            return "NEED"
        else:
            return "CRITICAL NEED"


# ── TRADE RESULT ────────────────────────────────────────────────────────────

@dataclass
class TradeResult:
    """Container for trade evaluation results."""

    team_a_name: str
    team_b_name: str
    a_gives: list
    b_gives: list
    a_giving_value: float
    b_giving_value: float
    a_raw_value: float
    b_raw_value: float
    a_pick_value: float
    b_pick_value: float
    package_tax_rate: float
    package_tax_side: str
    a_player_details: list
    b_player_details: list
    a_lineup_before: float
    a_lineup_after: float
    b_lineup_before: float
    b_lineup_after: float
    a_lineup_delta: float
    b_lineup_delta: float
    a_keeper_before: float
    a_keeper_after: float
    b_keeper_before: float
    b_keeper_after: float
    a_starters_before: list = field(default_factory=list)
    a_starters_after: list = field(default_factory=list)
    b_starters_before: list = field(default_factory=list)
    b_starters_after: list = field(default_factory=list)
    mutual_benefit: float = 0

    @property
    def verdict(self):
        """Generate a human-readable trade verdict."""
        a_total = self.a_lineup_delta + (self.a_keeper_after - self.a_keeper_before) * 20
        b_total = self.b_lineup_delta + (self.b_keeper_after - self.b_keeper_before) * 20

        diff = a_total - b_total
        if abs(diff) < 1.0:
            return "FAIR TRADE"
        elif diff > 3:
            return f"FAVORS {self.team_a_name.upper()}"
        elif diff < -3:
            return f"FAVORS {self.team_b_name.upper()}"
        elif diff > 0:
            return f"SLIGHTLY FAVORS {self.team_a_name.upper()}"
        else:
            return f"SLIGHTLY FAVORS {self.team_b_name.upper()}"

    @property
    def win_now_verdict(self):
        """Verdict focused purely on this-season lineup impact."""
        diff = self.a_lineup_delta - self.b_lineup_delta
        if abs(diff) < 0.5:
            return "EVEN for this season"
        elif diff > 0:
            return f"{self.team_a_name} wins NOW (+{self.a_lineup_delta}/wk)"
        else:
            return f"{self.team_b_name} wins NOW (+{self.b_lineup_delta}/wk)"

    @property
    def dynasty_verdict(self):
        """Verdict focused on long-term keeper value."""
        a_keeper_delta = self.a_keeper_after - self.a_keeper_before
        b_keeper_delta = self.b_keeper_after - self.b_keeper_before

        if abs(a_keeper_delta - b_keeper_delta) < 0.05:
            return "EVEN long-term"
        elif a_keeper_delta > b_keeper_delta:
            return f"{self.team_a_name} wins LONG-TERM (keeper value +{a_keeper_delta:.3f})"
        else:
            return f"{self.team_b_name} wins LONG-TERM (keeper value +{b_keeper_delta:.3f})"

    @property
    def fairness_pct(self):
        """0-100 fairness score. 50 = perfectly fair."""
        total = abs(self.a_giving_value) + abs(self.b_giving_value)
        if total == 0:
            return 50
        return round((self.a_giving_value / total) * 100)

    def to_dict(self):
        """Serialize to dict for JSON output."""
        return {
            "verdict": self.verdict,
            "win_now_verdict": self.win_now_verdict,
            "dynasty_verdict": self.dynasty_verdict,
            "fairness_pct": self.fairness_pct,
            "package_tax_rate": self.package_tax_rate,
            "package_tax_side": self.package_tax_side,
            "side_a": {
                "giving_value": self.a_giving_value,
                "raw_value": self.a_raw_value,
                "pick_value": self.a_pick_value,
                "player_details": self.a_player_details,
                "lineup_before": self.a_lineup_before,
                "lineup_after": self.a_lineup_after,
                "lineup_delta": self.a_lineup_delta,
                "keeper_before": self.a_keeper_before,
                "keeper_after": self.a_keeper_after,
                "keeper_delta": round(self.a_keeper_after - self.a_keeper_before, 3),
                "starters_after": [
                    {
                        "player_name": s["player_name"],
                        "position": s.get("position", ""),
                        "slot": s.get("slot", ""),
                        "weekly_avg": s.get("weekly_avg", 0),
                    }
                    for s in self.a_starters_after
                ],
            },
            "side_b": {
                "giving_value": self.b_giving_value,
                "raw_value": self.b_raw_value,
                "pick_value": self.b_pick_value,
                "player_details": self.b_player_details,
                "lineup_before": self.b_lineup_before,
                "lineup_after": self.b_lineup_after,
                "lineup_delta": self.b_lineup_delta,
                "keeper_before": self.b_keeper_before,
                "keeper_after": self.b_keeper_after,
                "keeper_delta": round(self.b_keeper_after - self.b_keeper_before, 3),
                "starters_after": [
                    {
                        "player_name": s["player_name"],
                        "position": s.get("position", ""),
                        "slot": s.get("slot", ""),
                        "weekly_avg": s.get("weekly_avg", 0),
                    }
                    for s in self.b_starters_after
                ],
            },
        }

    def print_report(self):
        """Print a formatted trade analysis report."""
        print(f"\n{'='*65}")
        print(f"TRADE ANALYSIS")
        print(f"{'='*65}")

        print(f"\n{self.team_a_name} sends:")
        for name in self.a_gives:
            print(f"  → {name}")
        print(f"\n{self.team_b_name} sends:")
        for name in self.b_gives:
            print(f"  → {name}")

        print(f"\n{'─'*65}")
        print(f"TRADE VALUE (with elite premium + package tax)")
        print(f"  {self.team_a_name} gives: {self.a_giving_value:.1f}")
        print(f"  {self.team_b_name} gives: {self.b_giving_value:.1f}")

        tax_rate = self.package_tax_rate
        tax_side = self.package_tax_side
        if tax_rate > 0:
            taxed_name = self.team_a_name if tax_side == "a" else self.team_b_name
            print(f"  Package tax: -{tax_rate*100:.0f}% applied to {taxed_name} (sending more assets)")

        diff = abs(self.a_giving_value - self.b_giving_value)
        if diff < 2:
            print(f"  Gap: {diff:.1f} — values are close")
        else:
            bigger = self.team_a_name if self.a_giving_value > self.b_giving_value else self.team_b_name
            print(f"  Gap: {diff:.1f} — {bigger} is giving up more raw value")

        print(f"\n{'─'*65}")
        print(f"STARTING LINEUP IMPACT (weekly points)")
        print(f"  {self.team_a_name}: {self.a_lineup_before} → {self.a_lineup_after} "
              f"({'+' if self.a_lineup_delta >= 0 else ''}{self.a_lineup_delta}/week)")
        print(f"  {self.team_b_name}: {self.b_lineup_before} → {self.b_lineup_after} "
              f"({'+' if self.b_lineup_delta >= 0 else ''}{self.b_lineup_delta}/week)")

        print(f"\n{'─'*65}")
        print(f"KEEPER VALUE IMPACT (long-term)")
        a_kd = self.a_keeper_after - self.a_keeper_before
        b_kd = self.b_keeper_after - self.b_keeper_before
        print(f"  {self.team_a_name}: {self.a_keeper_before:.3f} → {self.a_keeper_after:.3f} "
              f"({'+' if a_kd >= 0 else ''}{a_kd:.3f})")
        print(f"  {self.team_b_name}: {self.b_keeper_before:.3f} → {self.b_keeper_after:.3f} "
              f"({'+' if b_kd >= 0 else ''}{b_kd:.3f})")

        print(f"\n{'─'*65}")
        print(f"VERDICTS")
        print(f"  Overall:   {self.verdict}")
        print(f"  Win-now:   {self.win_now_verdict}")
        print(f"  Dynasty:   {self.dynasty_verdict}")
        print(f"  Fairness:  {self.fairness_pct}% (50 = perfectly fair)")
        print(f"{'='*65}")


# ── STANDALONE CLI ──────────────────────────────────────────────────────────

def interactive_mode(calc, league_rosters_path="output/league_rosters.csv"):
    """Run an interactive trade evaluation session."""

    if not os.path.exists(league_rosters_path):
        print(f"\n{league_rosters_path} not found.")
        print("Run sleeper_integration.py first to pull your league rosters.")
        return

    rosters_df = pd.read_csv(league_rosters_path)
    teams = sorted(rosters_df["owner"].unique())

    print(f"\n{'='*60}")
    print("INTERACTIVE TRADE CALCULATOR")
    print(f"{'='*60}")
    print(f"\nTeams in league:")
    for i, team in enumerate(teams, 1):
        count = len(rosters_df[rosters_df["owner"] == team])
        print(f"  {i}. {team} ({count} players)")

    while True:
        print(f"\n{'─'*60}")
        print("Enter trade details (or 'quit' to exit, 'needs' for roster analysis)")

        cmd = input("\n> ").strip().lower()
        if cmd in ("quit", "exit", "q"):
            break

        if cmd == "needs":
            team_input = input("Team name or number: ").strip()
            team_name = _resolve_team(team_input, teams)
            if team_name:
                roster = _build_roster_list(rosters_df, team_name, calc)
                needs = calc.analyze_roster_needs(roster, team_name)
                print(f"\n{team_name} POSITIONAL NEEDS:")
                for pos, info in needs.items():
                    print(f"  {pos}: {info['starter_avg_ppg']} ppg | "
                          f"depth: {info['depth']} | {info['assessment']}")
            continue

        try:
            team_a_input = input("Team A (name or number): ").strip()
            team_a = _resolve_team(team_a_input, teams)
            if not team_a:
                continue

            team_b_input = input("Team B (name or number): ").strip()
            team_b = _resolve_team(team_b_input, teams)
            if not team_b:
                continue

            a_gives_input = input(f"\n{team_a} gives (comma-separated names): ").strip()
            a_gives = [n.strip() for n in a_gives_input.split(",")]

            b_gives_input = input(f"\n{team_b} gives (comma-separated names): ").strip()
            b_gives = [n.strip() for n in b_gives_input.split(",")]

            a_roster = _build_roster_list(rosters_df, team_a, calc)
            b_roster = _build_roster_list(rosters_df, team_b, calc)

            result = calc.evaluate_trade(
                a_roster, b_roster, a_gives, b_gives, team_a, team_b
            )
            result.print_report()

        except (EOFError, KeyboardInterrupt):
            print("\nExiting...")
            break
        except Exception as e:
            print(f"\nError: {e}")
            continue


def _resolve_team(input_str, teams):
    """Resolve a team name from input (number or partial name match)."""
    try:
        idx = int(input_str) - 1
        if 0 <= idx < len(teams):
            return teams[idx]
    except ValueError:
        pass

    matches = [t for t in teams if input_str.lower() in t.lower()]
    if len(matches) == 1:
        return matches[0]
    elif len(matches) > 1:
        print(f"  Ambiguous — did you mean: {matches}?")
        return None
    else:
        print(f"  Team '{input_str}' not found.")
        return None


def _build_roster_list(rosters_df, team_name, calc):
    """Convert a roster DataFrame slice to the list-of-dicts format."""
    team = rosters_df[rosters_df["owner"] == team_name]
    roster = []
    for _, row in team.iterrows():
        player_val = calc.get_player_value(row["player_name"], row.get("position"))
        weekly = player_val.get("weekly_avg", 0) if player_val else 0
        roster.append({
            "player_name": row["player_name"],
            "position": row.get("position", "UNK"),
            "weekly_avg": weekly,
            "age": row.get("age", 27),
        })
    return roster


# ── MAIN ────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("FANTASY FOOTBALL TRADE CALCULATOR")
    print("=" * 60)
    print(f"\nSettings:")
    print(f"  Elite exponent: {ELITE_EXPONENT}")
    print(f"  Keeper weight in trades: {KEEPER_WEIGHT_IN_TRADE}")
    print(f"  Package tax: {PACKAGE_TAX}")
    print(f"  Pick consolidation discount: {CONSOLIDATION_DISCOUNT}")
    print(f"  Starting lineup: {STARTING_SLOTS}")

    calc = TradeCalculator()

    if "--demo" in sys.argv:
        print("\nRunning demo trade evaluation...")
        demo_trade(calc)
    else:
        interactive_mode(calc)


def demo_trade(calc):
    """Run a demo trade to show how the system works."""
    team_a = [
        {"player_name": "Josh Allen", "position": "QB", "weekly_avg": 24.5},
        {"player_name": "Saquon Barkley", "position": "RB", "weekly_avg": 18.2},
        {"player_name": "Josh Jacobs", "position": "RB", "weekly_avg": 13.5},
        {"player_name": "Ja'Marr Chase", "position": "WR", "weekly_avg": 21.0},
        {"player_name": "CeeDee Lamb", "position": "WR", "weekly_avg": 19.5},
        {"player_name": "Tee Higgins", "position": "WR", "weekly_avg": 13.8},
        {"player_name": "Travis Kelce", "position": "TE", "weekly_avg": 14.0},
        {"player_name": "Tyler Bass", "position": "K", "weekly_avg": 8.0},
    ]

    team_b = [
        {"player_name": "Jalen Hurts", "position": "QB", "weekly_avg": 22.0},
        {"player_name": "Breece Hall", "position": "RB", "weekly_avg": 17.5},
        {"player_name": "Jahmyr Gibbs", "position": "RB", "weekly_avg": 16.0},
        {"player_name": "Bijan Robinson", "position": "RB", "weekly_avg": 19.0},
        {"player_name": "Amon-Ra St. Brown", "position": "WR", "weekly_avg": 17.0},
        {"player_name": "Drake London", "position": "WR", "weekly_avg": 12.5},
        {"player_name": "George Kittle", "position": "TE", "weekly_avg": 11.5},
        {"player_name": "Jake Moody", "position": "K", "weekly_avg": 7.5},
    ]

    print("\nDEMO: Trading Tee Higgins + Josh Jacobs for Bijan Robinson")
    print("(Classic '2 average for 1 stud' trade test)\n")

    result = calc.evaluate_trade(
        team_a, team_b,
        a_gives=["Tee Higgins", "Josh Jacobs"],
        b_gives=["Bijan Robinson"],
        team_a_name="Team Alpha",
        team_b_name="Team Beta",
    )
    result.print_report()


if __name__ == "__main__":
    main()
