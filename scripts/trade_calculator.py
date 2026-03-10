"""
Fantasy Football Trade Calculator
===================================
Evaluates trades using surplus value over replacement, diminishing returns
for elite talent, and full lineup optimization for both sides.

Designed for keeper leagues — factors in multi-year keeper value, not just
current-season production.

Usage:
    # As a module
    from trade_calculator import TradeCalculator
    calc = TradeCalculator(keeper_values_path="output/keeper_values.csv")
    result = calc.evaluate_trade(team_a_roster, team_b_roster, 
                                  a_gives=["Player X"], b_gives=["Player Y"])

    # Standalone CLI
    python trade_calculator.py <LEAGUE_ID>
"""

import pandas as pd
import numpy as np
import json
import sys
import os
from itertools import combinations

# ── LEAGUE SETTINGS ─────────────────────────────────────────────────────────

STARTING_SLOTS = {
    "QB":   1,
    "RB":   2,
    "WR":   2,
    "TE":   1,
    "FLEX": 1,   # RB/WR/TE eligible
    "K":    1,
    "DEF":  1,
}

FLEX_ELIGIBLE = ["RB", "WR", "TE"]
ROSTER_SIZE = 16
KEEPER_SLOTS = 8

# ── VALUE CONFIGURATION ────────────────────────────────────────────────────

# Exponent for diminishing returns curve
# Higher = more separation between elite and average
# 1.0 = linear (no diminishing returns)
# 1.5 = moderate (recommended)
# 2.0 = aggressive (star-heavy valuation)
ELITE_EXPONENT = 1.5

# How much keeper/longevity value matters in trade calc vs current production
# In-season, you might want 0.3; offseason/pre-draft, bump to 0.6
KEEPER_WEIGHT_IN_TRADE = 0.45

# Positional replacement-level baselines (weekly points, 0.5 PPR)
# These represent "what you'd get off waivers" at each position
# Adjust these to your league's depth
REPLACEMENT_LEVEL = {
    "QB":  14.0,
    "RB":   6.0,
    "WR":   6.5,
    "TE":   4.5,
    "K":    7.0,
    "DEF":  6.0,
}


# ── CORE: TRADE VALUE ENGINE ───────────────────────────────────────────────

class TradeCalculator:
    """
    Evaluates fantasy trades using:
    1. Surplus value over positional replacement level
    2. Diminishing returns (elite premium)
    3. Roster-context lineup optimization
    4. Multi-year keeper value projection
    """

    def __init__(self, keeper_values_path="output/keeper_values.csv"):
        """Load keeper values from the model output."""
        self.keeper_values = None
        if os.path.exists(keeper_values_path):
            self.keeper_values = pd.read_csv(keeper_values_path, index_col=0)
            print(f"Loaded keeper values for {len(self.keeper_values)} players")
        else:
            print(f"Warning: {keeper_values_path} not found. "
                  "Run keeper_value_model.py first for full analysis.")

    # ── Player-Level Value ──────────────────────────────────────────────

    def get_player_value(self, player_name, position=None):
        """
        Get a player's complete value profile.
        Returns dict with production, surplus, trade, and keeper values.
        """
        info = self._lookup_player(player_name)
        if info is None and position:
            # Create a minimal profile for unknown players
            info = {
                "player_name": player_name,
                "position": position,
                "fantasy_points": REPLACEMENT_LEVEL.get(position, 5) * 17,
                "keeper_value": 0.0,
                "age": 27,
                "longevity_score": 0.3,
            }

        if info is None:
            return None

        pos = info.get("position", "UNK")
        season_pts = info.get("fantasy_points", 0)
        weekly_avg = season_pts / 17  # approximate weekly

        # Surplus over replacement
        replacement = REPLACEMENT_LEVEL.get(pos, 5.0)
        surplus = max(0, weekly_avg - replacement)

        # Apply diminishing returns — elite players get exponential premium
        raw_trade_value = self._apply_elite_curve(surplus, pos)

        # Blend in keeper/longevity value
        keeper_val = info.get("keeper_value", 0)
        blended = (
            (1 - KEEPER_WEIGHT_IN_TRADE) * raw_trade_value
            + KEEPER_WEIGHT_IN_TRADE * keeper_val * 100  # scale keeper to similar range
        )

        return {
            "player_name": player_name,
            "position": pos,
            "age": info.get("age", "?"),
            "weekly_avg": round(weekly_avg, 1),
            "surplus_over_replacement": round(surplus, 1),
            "raw_trade_value": round(raw_trade_value, 2),
            "keeper_value": round(keeper_val, 3),
            "blended_trade_value": round(blended, 2),
            "longevity_score": info.get("longevity_score", 0),
            "projected_years_elite": info.get("projected_years_elite", 0),
        }

    def _apply_elite_curve(self, surplus, position):
        """
        Apply non-linear scaling so elite surplus is worth disproportionately more.
        
        This is THE key mechanism that prevents "two average guys = one stud" trades.
        
        Example with ELITE_EXPONENT = 1.5:
            surplus=5  -> value=11.2
            surplus=10 -> value=31.6
            surplus=15 -> value=58.1
            surplus=20 -> value=89.4
        
        So a 20-surplus player is worth ~8x a 5-surplus player, not 4x.
        """
        if surplus <= 0:
            return 0

        # Position-specific scaling factor
        # RB surplus is rarer and more volatile, so it gets a slight premium
        pos_multiplier = {
            "QB": 0.85,   # deeper position, less scarcity premium
            "RB": 1.15,   # scarce + volatile = premium
            "WR": 1.00,   # baseline
            "TE": 1.10,   # top-end TEs are rare
            "K":  0.30,   # kickers are fungible
            "DEF": 0.30,  # defenses are fungible
        }

        multiplier = pos_multiplier.get(position, 1.0)
        return (surplus ** ELITE_EXPONENT) * multiplier

    # ── Lineup Optimization ─────────────────────────────────────────────

    def optimize_lineup(self, roster):
        """
        Given a roster (list of player dicts with 'player_name', 'position',
        'weekly_avg'), find the optimal starting lineup.
        
        Returns (starters, bench, total_points).
        """
        # Sort all players by weekly production, descending
        players = sorted(roster, key=lambda p: p.get("weekly_avg", 0), reverse=True)

        starters = []
        remaining = list(players)
        
        # Fill required positional slots first (QB, RB, WR, TE, K, DEF)
        for pos, count in STARTING_SLOTS.items():
            if pos == "FLEX":
                continue  # handle flex after

            pos_players = [p for p in remaining if p.get("position") == pos]
            pos_players.sort(key=lambda p: p.get("weekly_avg", 0), reverse=True)

            for i in range(min(count, len(pos_players))):
                starters.append({**pos_players[i], "slot": pos})
                remaining.remove(pos_players[i])

        # Fill FLEX with best remaining FLEX-eligible player
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
                       team_a_name="Team A", team_b_name="Team B"):
        """
        Evaluate a trade between two teams.

        Parameters:
            team_a_roster: list of player dicts for team A's full roster
            team_b_roster: list of player dicts for team B's full roster
            a_gives: list of player names team A is trading away
            b_gives: list of player names team B is trading away
            team_a_name: display name for team A
            team_b_name: display name for team B

        Returns a TradeResult with detailed analysis.
        """
        # ── Validate players exist on correct rosters
        a_roster_names = {p["player_name"] for p in team_a_roster}
        b_roster_names = {p["player_name"] for p in team_b_roster}

        for name in a_gives:
            if name not in a_roster_names:
                print(f"Warning: {name} not found on {team_a_name}'s roster")
        for name in b_gives:
            if name not in b_roster_names:
                print(f"Warning: {name} not found on {team_b_name}'s roster")

        # ── Build post-trade rosters
        a_after = [p for p in team_a_roster if p["player_name"] not in a_gives]
        b_after = [p for p in team_b_roster if p["player_name"] not in b_gives]

        # Add received players
        a_receives = [p for p in team_b_roster if p["player_name"] in b_gives]
        b_receives = [p for p in team_a_roster if p["player_name"] in a_gives]

        a_after.extend(a_receives)
        b_after.extend(b_receives)

        # ── Optimize lineups before and after
        a_start_before, a_bench_before, a_pts_before = self.optimize_lineup(team_a_roster)
        b_start_before, b_bench_before, b_pts_before = self.optimize_lineup(team_b_roster)

        a_start_after, a_bench_after, a_pts_after = self.optimize_lineup(a_after)
        b_start_after, b_bench_after, b_pts_after = self.optimize_lineup(b_after)

        # ── Calculate raw trade values for pieces exchanged
        a_giving_value = sum(
            self.get_player_value(n, self._find_position(n, team_a_roster))
                .get("blended_trade_value", 0)
            for n in a_gives
            if self.get_player_value(n, self._find_position(n, team_a_roster))
        )

        b_giving_value = sum(
            self.get_player_value(n, self._find_position(n, team_b_roster))
                .get("blended_trade_value", 0)
            for n in b_gives
            if self.get_player_value(n, self._find_position(n, team_b_roster))
        )

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
            a_giving_value=round(a_giving_value, 2),
            b_giving_value=round(b_giving_value, 2),
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

    def _find_position(self, player_name, roster):
        """Find a player's position from a roster list."""
        for p in roster:
            if p["player_name"] == player_name:
                return p.get("position")
        return None

    def _lookup_player(self, player_name):
        """Look up a player in the keeper values dataframe."""
        if self.keeper_values is None:
            return None
        matches = self.keeper_values[
            self.keeper_values["player_name"].str.lower() == player_name.lower()
        ]
        if matches.empty:
            # Try partial match
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

        Finds trades where both teams improve their starting lineup by
        at least min_improvement points per week.

        Parameters:
            my_roster: list of player dicts
            other_roster: list of player dicts  
            max_pieces: max players per side (1v1, 2v2, 2v1, etc.)
            min_improvement: minimum weekly lineup improvement for BOTH sides

        Returns list of TradeResults sorted by mutual benefit.
        """
        suggestions = []

        # Get player values for filtering
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

        # Filter to tradeable players (not null values, not replacement-level)
        my_tradeable = [
            (p, v) for p, v in my_players
            if v and v.get("surplus_over_replacement", 0) > 1
        ]
        other_tradeable = [
            (p, v) for p, v in other_players
            if v and v.get("surplus_over_replacement", 0) > 1
        ]

        print(f"Scanning {len(my_tradeable)} x {len(other_tradeable)} tradeable players...")

        # Generate trade combinations
        for my_count in range(1, max_pieces + 1):
            for other_count in range(1, max_pieces + 1):
                for my_combo in combinations(my_tradeable, my_count):
                    for other_combo in combinations(other_tradeable, other_count):
                        my_names = [p["player_name"] for p, _ in my_combo]
                        other_names = [p["player_name"] for p, _ in other_combo]

                        # Quick value sanity check — skip wildly lopsided trades
                        my_val = sum(v.get("blended_trade_value", 0) for _, v in my_combo)
                        other_val = sum(v.get("blended_trade_value", 0) for _, v in other_combo)

                        if my_val > 0 and other_val > 0:
                            ratio = max(my_val, other_val) / min(my_val, other_val)
                            if ratio > 3.0:
                                continue  # too lopsided to even evaluate

                        result = self.evaluate_trade(
                            my_roster, other_roster,
                            my_names, other_names,
                            my_name, other_name,
                        )

                        # Both sides must improve
                        if (result.a_lineup_delta >= min_improvement and
                                result.b_lineup_delta >= min_improvement):
                            result.mutual_benefit = round(
                                result.a_lineup_delta + result.b_lineup_delta, 1
                            )
                            suggestions.append(result)

        # Sort by total mutual benefit
        suggestions.sort(key=lambda r: r.mutual_benefit, reverse=True)

        return suggestions[:20]  # top 20

    # ── Positional Needs Analysis ───────────────────────────────────────

    def analyze_roster_needs(self, roster, team_name="Team"):
        """
        Analyze a roster's strengths and weaknesses by position.
        Identifies where the team should be buying/selling.
        """
        starters, bench, total = self.optimize_lineup(roster)

        needs = {}
        for pos in ["QB", "RB", "WR", "TE"]:
            pos_starters = [s for s in starters if s.get("position") == pos]
            pos_bench = [b for b in bench if b.get("position") == pos]
            pos_all = pos_starters + pos_bench

            starter_avg = np.mean([s.get("weekly_avg", 0) for s in pos_starters]) if pos_starters else 0
            replacement = REPLACEMENT_LEVEL.get(pos, 5)
            depth = len(pos_all)

            # Need score: higher = more need
            # Factors: starter quality, depth, positional importance
            starter_gap = max(0, replacement * 2 - starter_avg)  # how far below "good" starter level
            depth_penalty = max(0, 3 - depth) * 2  # penalty for thin depth

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
            return "STRENGTH — sell high"
        elif score <= 5:
            return "SOLID"
        elif score <= 10:
            return "NEED — buy"
        else:
            return "CRITICAL NEED — buy aggressively"


# ── TRADE RESULT ────────────────────────────────────────────────────────────

class TradeResult:
    """Container for trade evaluation results."""

    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)
        self.mutual_benefit = getattr(self, "mutual_benefit", 0)

    @property
    def verdict(self):
        """Generate a human-readable trade verdict."""
        a_total = self.a_lineup_delta + (self.a_keeper_after - self.a_keeper_before) * 20
        b_total = self.b_lineup_delta + (self.b_keeper_after - self.b_keeper_before) * 20

        if abs(a_total - b_total) < 1.0:
            return "FAIR TRADE"
        elif a_total > b_total + 3:
            return f"FAVORS {self.team_a_name.upper()}"
        elif b_total > a_total + 3:
            return f"FAVORS {self.team_b_name.upper()}"
        elif a_total > b_total:
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

    def print_report(self):
        """Print a formatted trade analysis report."""
        print(f"\n{'='*65}")
        print(f"TRADE ANALYSIS")
        print(f"{'='*65}")

        # ── The trade
        print(f"\n{self.team_a_name} sends:")
        for name in self.a_gives:
            print(f"  → {name}")
        print(f"\n{self.team_b_name} sends:")
        for name in self.b_gives:
            print(f"  → {name}")

        # ── Raw value comparison
        print(f"\n{'─'*65}")
        print(f"RAW TRADE VALUE (with elite premium + keeper value)")
        print(f"  {self.team_a_name} gives: {self.a_giving_value:.1f}")
        print(f"  {self.team_b_name} gives: {self.b_giving_value:.1f}")
        diff = abs(self.a_giving_value - self.b_giving_value)
        if diff < 2:
            print(f"  Gap: {diff:.1f} — values are close")
        else:
            bigger = self.team_a_name if self.a_giving_value > self.b_giving_value else self.team_b_name
            print(f"  Gap: {diff:.1f} — {bigger} is giving up more raw value")

        # ── Lineup impact
        print(f"\n{'─'*65}")
        print(f"STARTING LINEUP IMPACT (weekly points)")
        print(f"  {self.team_a_name}: {self.a_lineup_before} → {self.a_lineup_after} "
              f"({'+' if self.a_lineup_delta >= 0 else ''}{self.a_lineup_delta}/week)")
        print(f"  {self.team_b_name}: {self.b_lineup_before} → {self.b_lineup_after} "
              f"({'+' if self.b_lineup_delta >= 0 else ''}{self.b_lineup_delta}/week)")

        # ── Lineup details
        print(f"\n  {self.team_a_name}'s lineup AFTER trade:")
        for s in self.a_starters_after:
            marker = "★" if s["player_name"] in self.b_gives else " "
            print(f"    {marker} {s.get('slot', '?'):<5} {s['player_name']:<25} "
                  f"{s.get('weekly_avg', 0):.1f} ppg")

        print(f"\n  {self.team_b_name}'s lineup AFTER trade:")
        for s in self.b_starters_after:
            marker = "★" if s["player_name"] in self.a_gives else " "
            print(f"    {marker} {s.get('slot', '?'):<5} {s['player_name']:<25} "
                  f"{s.get('weekly_avg', 0):.1f} ppg")

        # ── Keeper impact
        print(f"\n{'─'*65}")
        print(f"KEEPER VALUE IMPACT (long-term)")
        a_kd = self.a_keeper_after - self.a_keeper_before
        b_kd = self.b_keeper_after - self.b_keeper_before
        print(f"  {self.team_a_name}: {self.a_keeper_before:.3f} → {self.a_keeper_after:.3f} "
              f"({'+' if a_kd >= 0 else ''}{a_kd:.3f})")
        print(f"  {self.team_b_name}: {self.b_keeper_before:.3f} → {self.b_keeper_after:.3f} "
              f"({'+' if b_kd >= 0 else ''}{b_kd:.3f})")

        # ── Verdicts
        print(f"\n{'─'*65}")
        print(f"VERDICTS")
        print(f"  Overall:   {self.verdict}")
        print(f"  Win-now:   {self.win_now_verdict}")
        print(f"  Dynasty:   {self.dynasty_verdict}")
        print(f"{'='*65}")


# ── STANDALONE CLI ──────────────────────────────────────────────────────────

def interactive_mode(calc, league_rosters_path="output/league_rosters.csv"):
    """Run an interactive trade evaluation session."""

    if not os.path.exists(league_rosters_path):
        print(f"\n{league_rosters_path} not found.")
        print("Run sleeper_integration.py first to pull your league rosters.")
        print("\nYou can still evaluate trades manually — see the README.")
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

        # Trade input
        try:
            team_a_input = input("Team A (name or number): ").strip()
            team_a = _resolve_team(team_a_input, teams)
            if not team_a:
                continue

            team_b_input = input("Team B (name or number): ").strip()
            team_b = _resolve_team(team_b_input, teams)
            if not team_b:
                continue

            print(f"\n{team_a}'s roster:")
            a_players = rosters_df[rosters_df["owner"] == team_a]
            for _, p in a_players.iterrows():
                print(f"  {p['player_name']:<25} {p['position']:<4} age {p.get('age', '?')}")

            a_gives_input = input(f"\n{team_a} gives (comma-separated names): ").strip()
            a_gives = [n.strip() for n in a_gives_input.split(",")]

            print(f"\n{team_b}'s roster:")
            b_players = rosters_df[rosters_df["owner"] == team_b]
            for _, p in b_players.iterrows():
                print(f"  {p['player_name']:<25} {p['position']:<4} age {p.get('age', '?')}")

            b_gives_input = input(f"\n{team_b} gives (comma-separated names): ").strip()
            b_gives = [n.strip() for n in b_gives_input.split(",")]

            # Build roster lists
            a_roster = _build_roster_list(rosters_df, team_a, calc)
            b_roster = _build_roster_list(rosters_df, team_b, calc)

            # Evaluate
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

    # Partial name match
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
    print(f"  Starting lineup: {STARTING_SLOTS}")

    calc = TradeCalculator()

    if "--demo" in sys.argv:
        # Demo mode with fake data
        print("\nRunning demo trade evaluation...")
        demo_trade(calc)
    else:
        interactive_mode(calc)


def demo_trade(calc):
    """Run a demo trade to show how the system works."""
    # Hypothetical rosters
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

    # Show the math on why 2-for-1 isn't equal
    print(f"\n{'─'*65}")
    print("WHY THE MATH ISN'T LINEAR (elite premium demo):")
    print(f"  Bijan Robinson surplus: 19.0 - {REPLACEMENT_LEVEL['RB']} = 13.0 ppg")
    print(f"  Bijan trade value:  13.0^{ELITE_EXPONENT} × 1.15 = "
          f"{(13.0 ** ELITE_EXPONENT) * 1.15:.1f}")
    print(f"  Higgins surplus: 13.8 - {REPLACEMENT_LEVEL['WR']} = 7.3 ppg")
    print(f"  Higgins trade value: 7.3^{ELITE_EXPONENT} × 1.00 = "
          f"{(7.3 ** ELITE_EXPONENT) * 1.0:.1f}")
    print(f"  Jacobs surplus: 13.5 - {REPLACEMENT_LEVEL['RB']} = 7.5 ppg")
    print(f"  Jacobs trade value:  7.5^{ELITE_EXPONENT} × 1.15 = "
          f"{(7.5 ** ELITE_EXPONENT) * 1.15:.1f}")
    print(f"  Combined Higgins+Jacobs: "
          f"{(7.3 ** ELITE_EXPONENT) * 1.0 + (7.5 ** ELITE_EXPONENT) * 1.15:.1f}")
    print(f"\n  → Bijan alone is worth MORE than both combined.")
    print(f"    This is the elite premium at work.")


if __name__ == "__main__":
    main()
