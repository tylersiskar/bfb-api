"""
Keeper Value Model Calibration via Historical Trade Data
==========================================================
Pulls completed trades from Sleeper's API, reconstructs what the keeper
model would have valued each side at trade time, and identifies systematic
biases (especially positional) using "revealed preference" — both sides
agreed, so the trade was approximately fair.

Usage:
    LEAGUE_ID=<your_league_id> python scripts/calibrate_model.py

Outputs:
    output/calibration_report.txt   — human-readable bias analysis
    output/calibration_trades.csv   — per-trade detail
    output/calibration_corrections.json — machine-readable correction factors
"""

import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime

import pandas as pd
import numpy as np

# Add scripts dir to path so we can import the keeper model
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from keeper_value_model import (
    pull_data,
    calculate_fantasy_points,
    merge_bio_data,
    run_model_for_season,
)
from trade_calculator import get_pick_value
from league_config import POSITIONS
from sleeper_api import (
    get_league_info, get_all_players as get_all_players_cached,
    get_transactions, get_league_chain,
)

OUTPUT_DIR = os.path.join(SCRIPT_DIR, "..", "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# How many weeks to check per season (regular season + offseason)
# Sleeper uses week 0 for offseason transactions
WEEKS_TO_CHECK = list(range(0, 19))


# ── 1. SLEEPER API: TRADE HISTORY ─────────────────────────────────────────

def fetch_all_trades(league_id):
    """
    Fetch all completed trades across all seasons for this league chain.
    Returns list of trade dicts with added 'season' and 'league_id' fields.
    """
    chain = get_league_chain(league_id)
    print(f"  League chain: {len(chain)} seasons")
    for lid, season in chain:
        print(f"    {season}: {lid}")

    all_trades = []
    for lid, season in chain:
        season_trades = 0
        for week in WEEKS_TO_CHECK:
            try:
                txns = get_transactions(lid, week)
            except Exception as e:
                # Some weeks may not exist for older seasons
                continue

            for txn in txns:
                if txn.get("type") != "trade":
                    continue
                if txn.get("status") != "complete":
                    continue

                txn["_season"] = season
                txn["_league_id"] = lid
                txn["_week"] = week
                all_trades.append(txn)
                season_trades += 1

            time.sleep(0.15)  # rate limit

        print(f"    {season}: {season_trades} trades found")

    print(f"  Total trades: {len(all_trades)}")
    return all_trades


# ── 2. TRADE PARSING ──────────────────────────────────────────────────────

def parse_trade_sides(trade, sleeper_players):
    """
    Parse a Sleeper trade transaction into two sides.
    Returns dict with side_a and side_b, each containing players and picks.
    """
    adds = trade.get("adds") or {}       # {player_id: roster_id}
    drops = trade.get("drops") or {}     # {player_id: roster_id}
    draft_picks = trade.get("draft_picks") or []
    roster_ids = trade.get("roster_ids") or []

    if len(roster_ids) != 2:
        return None  # skip multi-team trades

    rid_a, rid_b = roster_ids[0], roster_ids[1]

    # Players: "adds" to roster A = what A received = what B sent
    # "drops" from roster A = what A sent
    side_a_receives = []  # players A gets (= B sends)
    side_b_receives = []  # players B gets (= A sends)

    for pid, to_roster in adds.items():
        player_info = sleeper_players.get(str(pid), {})
        player_name = player_info.get("full_name", f"Unknown({pid})")
        position = player_info.get("position", "UNK")
        age = player_info.get("age")

        entry = {
            "player_id": str(pid),
            "player_name": player_name,
            "position": position,
            "age": age,
        }

        if to_roster == rid_a:
            side_a_receives.append(entry)
        elif to_roster == rid_b:
            side_b_receives.append(entry)

    # Draft picks
    side_a_picks = []  # picks A receives
    side_b_picks = []  # picks B receives
    for pick in draft_picks:
        pick_entry = {
            "season": pick.get("season"),
            "round": pick.get("round"),
            "original_owner_id": pick.get("roster_id"),
        }
        if pick.get("owner_id") == rid_a:
            side_a_picks.append(pick_entry)
        elif pick.get("owner_id") == rid_b:
            side_b_picks.append(pick_entry)

    # Side A sends = what B receives, Side A receives = what B sends
    return {
        "roster_ids": (rid_a, rid_b),
        "side_a": {
            "sends_players": side_b_receives,  # what A sends = what B receives
            "sends_picks": side_b_picks,
            "receives_players": side_a_receives,
            "receives_picks": side_a_picks,
        },
        "side_b": {
            "sends_players": side_a_receives,  # what B sends = what A receives
            "sends_picks": side_a_picks,
            "receives_players": side_b_receives,
            "receives_picks": side_b_picks,
        },
    }


# ── 3. HISTORICAL VALUE RECONSTRUCTION ───────────────────────────────────

def build_historical_values(df, all_players, seasons):
    """
    Run the keeper model for each season to get historical player values.
    Returns {season: {player_name_lower: {keeper_value, position, ...}}}
    """
    print("\nBuilding historical keeper values...")
    historical = {}
    for season in sorted(seasons):
        values_df = run_model_for_season(df, all_players, season, quiet=False)
        if values_df.empty:
            print(f"  Season {season}: no data")
            continue

        season_lookup = {}
        for _, row in values_df.iterrows():
            name = row.get("player_name", "")
            season_lookup[name.lower()] = {
                "keeper_value": row.get("keeper_value", 0),
                "position": row.get("position", "UNK"),
                "age": row.get("age", 0),
                "fantasy_points": row.get("fantasy_points", 0),
                "current_value": row.get("current_value", 0),
                "longevity_score": row.get("longevity_score", 0),
                "scarcity_score": row.get("scarcity_score", 0),
            }
        historical[season] = season_lookup
        print(f"  Season {season}: {len(season_lookup)} players")

    return historical


def lookup_player_value(historical, season, player_name):
    """Look up a player's keeper value for a given season. Fuzzy match."""
    season_data = historical.get(season, {})
    name_lower = player_name.lower()

    # Exact match
    if name_lower in season_data:
        return season_data[name_lower]

    # Strip suffixes and retry
    for suffix in [" jr.", " jr", " sr.", " sr", " ii", " iii", " iv", " v"]:
        stripped = name_lower.replace(suffix, "").strip()
        if stripped in season_data:
            return season_data[stripped]

    # Partial match
    for key, val in season_data.items():
        if name_lower in key or key in name_lower:
            return val

    return None


def value_pick(pick, trade_season):
    """Value a draft pick using existing trade_calculator constants."""
    pick_round = pick.get("round", 3)
    pick_season = pick.get("season")
    years_out = 0
    if pick_season and trade_season:
        years_out = max(0, int(pick_season) - int(trade_season))

    # Default to mid slot since we don't know exact position
    return get_pick_value(pick_round, 6, years_out)


# ── 4. BIAS ANALYSIS ─────────────────────────────────────────────────────

def analyze_trades(trades, historical, sleeper_players):
    """
    For each trade, compute model values for both sides and measure bias.
    Returns list of analyzed trade dicts.
    """
    analyzed = []

    for trade in trades:
        season = trade["_season"]
        week = trade["_week"]
        parsed = parse_trade_sides(trade, sleeper_players)
        if parsed is None:
            continue

        # Value Side A's sends (what Side A gives up)
        a_sends = parsed["side_a"]["sends_players"]
        a_send_picks = parsed["side_a"]["sends_picks"]
        b_sends = parsed["side_b"]["sends_players"]
        b_send_picks = parsed["side_b"]["sends_picks"]

        # Skip if either side sends nothing
        if not a_sends and not a_send_picks:
            continue
        if not b_sends and not b_send_picks:
            continue

        # Value players
        a_player_value = 0
        a_player_details = []
        for p in a_sends:
            val = lookup_player_value(historical, season, p["player_name"])
            kv = val["keeper_value"] if val else 0
            a_player_value += kv
            a_player_details.append({
                "name": p["player_name"],
                "position": p.get("position") or (val["position"] if val else "UNK"),
                "age": p.get("age") or (val["age"] if val else None),
                "keeper_value": round(kv, 4),
            })

        b_player_value = 0
        b_player_details = []
        for p in b_sends:
            val = lookup_player_value(historical, season, p["player_name"])
            kv = val["keeper_value"] if val else 0
            b_player_value += kv
            b_player_details.append({
                "name": p["player_name"],
                "position": p.get("position") or (val["position"] if val else "UNK"),
                "age": p.get("age") or (val["age"] if val else None),
                "keeper_value": round(kv, 4),
            })

        # Value picks
        a_pick_value = sum(value_pick(pk, season) for pk in a_send_picks)
        b_pick_value = sum(value_pick(pk, season) for pk in b_send_picks)

        # Normalize pick values to keeper_value scale (picks are in ~0-6000 range,
        # keeper values are 0-1 range). Use a rough conversion.
        # Max pick value ~5950, max keeper value ~1.0, so divide by ~6000
        PICK_TO_KV_SCALE = 6000
        a_pick_kv = a_pick_value / PICK_TO_KV_SCALE
        b_pick_kv = b_pick_value / PICK_TO_KV_SCALE

        a_total = a_player_value + a_pick_kv
        b_total = b_player_value + b_pick_kv

        if a_total + b_total == 0:
            continue

        # Model fairness: 0.5 = perfectly fair
        # > 0.5 means model thinks Side A gave up more (Side A overpaid)
        model_fairness = a_total / (a_total + b_total)
        residual = model_fairness - 0.5

        # Determine "star" player (highest KV on either side)
        all_details = a_player_details + b_player_details
        star = max(all_details, key=lambda d: d["keeper_value"]) if all_details else None

        # Determine dominant position per side
        a_positions = [d["position"] for d in a_player_details if d["position"] in POSITIONS]
        b_positions = [d["position"] for d in b_player_details if d["position"] in POSITIONS]

        # Confidence: lower for pick-heavy trades and early-season trades
        player_value_share = (a_player_value + b_player_value) / max(a_total + b_total, 0.001)
        week_confidence = 1.0 if week >= 10 or week == 0 else 0.7 if week >= 5 else 0.5
        confidence = player_value_share * week_confidence

        analyzed.append({
            "season": season,
            "week": week,
            "transaction_id": trade.get("transaction_id", ""),
            "side_a_players": a_player_details,
            "side_b_players": b_player_details,
            "side_a_picks": a_send_picks,
            "side_b_picks": b_send_picks,
            "side_a_player_kv": round(a_player_value, 4),
            "side_b_player_kv": round(b_player_value, 4),
            "side_a_pick_kv": round(a_pick_kv, 4),
            "side_b_pick_kv": round(b_pick_kv, 4),
            "side_a_total": round(a_total, 4),
            "side_b_total": round(b_total, 4),
            "model_fairness": round(model_fairness, 4),
            "residual": round(residual, 4),
            "star_player": star["name"] if star else None,
            "star_position": star["position"] if star else None,
            "a_positions": a_positions,
            "b_positions": b_positions,
            "confidence": round(confidence, 3),
            "is_one_for_one": len(a_sends) == 1 and len(b_sends) == 1
                              and not a_send_picks and not b_send_picks,
        })

    return analyzed


def compute_positional_bias(analyzed_trades):
    """
    Compute average model residual by position.
    For each trade, attribute the residual to positions involved.
    Positive residual when a position is on Side A = model overvalues that position.
    Negative = model undervalues.
    """
    # Track: when a position's player is on the "sending" side,
    # what's the average residual? If the model undervalues RBs,
    # then when an RB is sent, the model thinks that side gave up less
    # (negative residual from that side's perspective → the RB holder
    # actually got good value but model doesn't see it).

    pos_residuals = defaultdict(list)
    pos_residuals_weighted = defaultdict(list)

    for t in analyzed_trades:
        if t["confidence"] < 0.3:
            continue

        # For Side A's positions: positive residual = model thinks A overpaid
        # = model overvalues what A sent. If A sent RBs: model overvalues RBs.
        for pos in t["a_positions"]:
            pos_residuals[pos].append(t["residual"])
            pos_residuals_weighted[pos].append(t["residual"] * t["confidence"])

        # For Side B: flip the residual (Side B's perspective)
        for pos in t["b_positions"]:
            pos_residuals[pos].append(-t["residual"])
            pos_residuals_weighted[pos].append(-t["residual"] * t["confidence"])

    bias = {}
    for pos in POSITIONS:
        residuals = pos_residuals.get(pos, [])
        if not residuals:
            bias[pos] = {"avg_residual": 0, "count": 0, "std": 0, "implied_multiplier": 1.0}
            continue

        avg = np.mean(residuals)
        std = np.std(residuals)
        count = len(residuals)

        # Implied multiplier: if avg residual is +0.05 (model overvalues),
        # multiply by 1/(1+0.05*2) ≈ 0.91 to correct.
        # If avg residual is -0.05 (model undervalues), multiply by 1/(1-0.05*2) ≈ 1.11
        # The *2 factor accounts for the residual being relative to total (both sides).
        correction = -avg * 2
        implied_mult = 1.0 + correction

        bias[pos] = {
            "avg_residual": round(avg, 4),
            "std": round(std, 4),
            "count": count,
            "implied_multiplier": round(implied_mult, 3),
        }

    return bias


def compute_cross_position_rates(analyzed_trades):
    """
    For 1-for-1 trades between different positions, compute implied
    exchange rates vs model rates.
    """
    exchanges = []
    for t in analyzed_trades:
        if not t["is_one_for_one"]:
            continue
        a_player = t["side_a_players"][0]
        b_player = t["side_b_players"][0]
        if a_player["position"] == b_player["position"]:
            continue
        if a_player["keeper_value"] == 0 or b_player["keeper_value"] == 0:
            continue

        # In the trade, these players were considered roughly equal.
        # Model ratio: a_kv / b_kv. If > 1, model thinks A is worth more.
        # But trade says they're equal, so model overvalues A's position.
        model_ratio = a_player["keeper_value"] / b_player["keeper_value"]

        exchanges.append({
            "a_name": a_player["name"],
            "a_pos": a_player["position"],
            "a_kv": a_player["keeper_value"],
            "b_name": b_player["name"],
            "b_pos": b_player["position"],
            "b_kv": b_player["keeper_value"],
            "model_ratio": round(model_ratio, 3),
            "season": t["season"],
        })

    return exchanges


def compute_age_bias(analyzed_trades):
    """Group residuals by age bucket to check aging curve accuracy."""
    age_residuals = defaultdict(list)
    for t in analyzed_trades:
        if t["confidence"] < 0.3:
            continue

        for p in t["side_a_players"]:
            age = p.get("age")
            if age and p["keeper_value"] > 0:
                bucket = f"{(age // 3) * 3}-{(age // 3) * 3 + 2}"
                age_residuals[bucket].append(t["residual"])

        for p in t["side_b_players"]:
            age = p.get("age")
            if age and p["keeper_value"] > 0:
                bucket = f"{(age // 3) * 3}-{(age // 3) * 3 + 2}"
                age_residuals[bucket].append(-t["residual"])

    return {
        bucket: {"avg_residual": round(np.mean(vals), 4), "count": len(vals)}
        for bucket, vals in sorted(age_residuals.items())
    }


def compute_elite_bias(analyzed_trades):
    """Check if elite players (top KV) are properly valued vs depth pieces."""
    tiers = {"elite": [], "mid": [], "depth": []}

    for t in analyzed_trades:
        if t["confidence"] < 0.3:
            continue

        for p in t["side_a_players"]:
            kv = p["keeper_value"]
            if kv >= 0.5:
                tiers["elite"].append(t["residual"])
            elif kv >= 0.2:
                tiers["mid"].append(t["residual"])
            elif kv > 0:
                tiers["depth"].append(t["residual"])

        for p in t["side_b_players"]:
            kv = p["keeper_value"]
            if kv >= 0.5:
                tiers["elite"].append(-t["residual"])
            elif kv >= 0.2:
                tiers["mid"].append(-t["residual"])
            elif kv > 0:
                tiers["depth"].append(-t["residual"])

    return {
        tier: {"avg_residual": round(np.mean(vals), 4), "count": len(vals)}
        for tier, vals in tiers.items() if vals
    }


# ── 5. PARAMETER RECOMMENDATIONS ─────────────────────────────────────────

def generate_recommendations(pos_bias, cross_pos_rates, age_bias, elite_bias):
    """
    Map calibration findings to specific model parameter recommendations.
    """
    recs = []

    # Positional recommendations
    for pos in POSITIONS:
        b = pos_bias.get(pos, {})
        avg_r = b.get("avg_residual", 0)
        count = b.get("count", 0)
        mult = b.get("implied_multiplier", 1.0)

        if count < 5:
            continue  # not enough data

        if abs(avg_r) > 0.02:  # meaningful bias threshold
            direction = "undervalued" if avg_r < 0 else "overvalued"
            recs.append({
                "parameter": f"POS_MULTIPLIER[{pos}]",
                "file": "trade_calculator.py",
                "reason": f"{pos} appears {direction} by model (avg residual: {avg_r:+.4f}, n={count})",
                "suggestion": f"Adjust multiplier by ~{mult:.3f}x",
                "confidence": "medium" if count >= 10 else "low",
            })

            if pos == "RB" and avg_r < -0.03:
                recs.append({
                    "parameter": "KEEPER_DEPTH[RB]",
                    "file": "keeper_value_model.py",
                    "reason": f"RB undervaluation (residual {avg_r:+.4f}) may be caused by KEEPER_DEPTH=20 compressing RB VOR",
                    "suggestion": "Try reducing from 20 to 16 (raises RB replacement level → higher VOR for top RBs)",
                    "confidence": "medium",
                })

                recs.append({
                    "parameter": "WEIGHTS[scarcity]",
                    "file": "keeper_value_model.py",
                    "reason": "RB elite years are shorter — scarcity weight (10%) may be too low to capture this",
                    "suggestion": "Try increasing from 0.10 to 0.15 (reduce current_season from 0.60 to 0.55)",
                    "confidence": "low",
                })

    # Elite tier recommendation
    if elite_bias:
        elite = elite_bias.get("elite", {})
        if elite.get("count", 0) >= 5 and elite.get("avg_residual", 0) > 0.03:
            recs.append({
                "parameter": "ELITE_EXPONENT",
                "file": "trade_calculator.py",
                "reason": f"Elite players may be overvalued (residual {elite['avg_residual']:+.4f})",
                "suggestion": f"Consider reducing from 1.5 to 1.4",
                "confidence": "low",
            })
        elif elite.get("count", 0) >= 5 and elite.get("avg_residual", 0) < -0.03:
            recs.append({
                "parameter": "ELITE_EXPONENT",
                "file": "trade_calculator.py",
                "reason": f"Elite players may be undervalued (residual {elite['avg_residual']:+.4f})",
                "suggestion": f"Consider increasing from 1.5 to 1.6",
                "confidence": "low",
            })

    return recs


# ── 6. OUTPUT ─────────────────────────────────────────────────────────────

def save_report(analyzed_trades, pos_bias, cross_pos_rates, age_bias, elite_bias, recommendations):
    """Save human-readable calibration report."""
    path = os.path.join(OUTPUT_DIR, "calibration_report.txt")
    with open(path, "w") as f:
        f.write("KEEPER VALUE MODEL CALIBRATION REPORT\n")
        f.write(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
        f.write("=" * 70 + "\n\n")

        # Summary
        f.write(f"Total trades analyzed: {len(analyzed_trades)}\n")
        high_conf = [t for t in analyzed_trades if t["confidence"] >= 0.5]
        f.write(f"High-confidence trades (conf >= 0.5): {len(high_conf)}\n")
        one_for_one = [t for t in analyzed_trades if t["is_one_for_one"]]
        f.write(f"1-for-1 player trades: {len(one_for_one)}\n\n")

        seasons = sorted(set(t["season"] for t in analyzed_trades))
        for s in seasons:
            count = sum(1 for t in analyzed_trades if t["season"] == s)
            f.write(f"  {s}: {count} trades\n")

        # Positional bias
        f.write(f"\n{'=' * 70}\n")
        f.write("POSITIONAL BIAS ANALYSIS\n")
        f.write("-" * 70 + "\n")
        f.write("Positive residual = model OVERVALUES the position (thinks it's worth more than trades suggest)\n")
        f.write("Negative residual = model UNDERVALUES the position (trades suggest it's worth more)\n\n")
        f.write(f"{'Position':<10}{'Avg Residual':<15}{'Std Dev':<12}{'Count':<8}{'Implied Mult':<15}{'Signal':<20}\n")
        f.write("-" * 70 + "\n")
        for pos in POSITIONS:
            b = pos_bias.get(pos, {})
            avg_r = b.get("avg_residual", 0)
            std = b.get("std", 0)
            count = b.get("count", 0)
            mult = b.get("implied_multiplier", 1.0)
            signal = ""
            if count >= 5:
                if avg_r < -0.03:
                    signal = "UNDERVALUED"
                elif avg_r > 0.03:
                    signal = "OVERVALUED"
                else:
                    signal = "~fair"
            else:
                signal = "(insufficient data)"
            f.write(f"{pos:<10}{avg_r:+.4f}{'':>6}{std:.4f}{'':>4}{count:<8}{mult:.3f}{'':>8}{signal}\n")

        # Cross-position exchange rates
        if cross_pos_rates:
            f.write(f"\n{'=' * 70}\n")
            f.write("CROSS-POSITION EXCHANGE RATES (1-for-1 trades)\n")
            f.write("-" * 70 + "\n")
            f.write("Model ratio > 1.0 means model values Side A's player MORE than Side B's.\n")
            f.write("Since these were actual trades (≈ fair), ratio should be ~1.0.\n\n")
            for ex in cross_pos_rates:
                f.write(f"  {ex['a_name']} ({ex['a_pos']}, kv={ex['a_kv']:.3f})  <->  "
                        f"{ex['b_name']} ({ex['b_pos']}, kv={ex['b_kv']:.3f})  "
                        f"| model ratio: {ex['model_ratio']:.3f} "
                        f"({ex['season']})\n")

            # Aggregate by position pair
            f.write("\n  Aggregated by position pair:\n")
            pair_ratios = defaultdict(list)
            for ex in cross_pos_rates:
                pair = tuple(sorted([ex["a_pos"], ex["b_pos"]]))
                # Normalize so the first position is always the "A" side
                if pair[0] == ex["a_pos"]:
                    pair_ratios[pair].append(ex["model_ratio"])
                else:
                    pair_ratios[pair].append(1.0 / ex["model_ratio"])

            for pair, ratios in sorted(pair_ratios.items()):
                avg_ratio = np.mean(ratios)
                f.write(f"    {pair[0]} vs {pair[1]}: avg model ratio = {avg_ratio:.3f} (n={len(ratios)})\n")
                if avg_ratio > 1.1:
                    f.write(f"      → Model overvalues {pair[0]} relative to {pair[1]}\n")
                elif avg_ratio < 0.9:
                    f.write(f"      → Model undervalues {pair[0]} relative to {pair[1]}\n")

        # Age bias
        if age_bias:
            f.write(f"\n{'=' * 70}\n")
            f.write("AGE BUCKET BIAS\n")
            f.write("-" * 70 + "\n")
            for bucket, data in sorted(age_bias.items()):
                f.write(f"  Age {bucket}: avg residual {data['avg_residual']:+.4f} (n={data['count']})\n")

        # Elite bias
        if elite_bias:
            f.write(f"\n{'=' * 70}\n")
            f.write("ELITE vs DEPTH BIAS\n")
            f.write("-" * 70 + "\n")
            for tier, data in elite_bias.items():
                f.write(f"  {tier.upper()}: avg residual {data['avg_residual']:+.4f} (n={data['count']})\n")

        # Recommendations
        f.write(f"\n{'=' * 70}\n")
        f.write("PARAMETER RECOMMENDATIONS\n")
        f.write("-" * 70 + "\n")
        if recommendations:
            for i, rec in enumerate(recommendations, 1):
                f.write(f"\n{i}. {rec['parameter']} ({rec['file']})\n")
                f.write(f"   Reason: {rec['reason']}\n")
                f.write(f"   Suggestion: {rec['suggestion']}\n")
                f.write(f"   Confidence: {rec['confidence']}\n")
        else:
            f.write("\nNo strong signals found. Model appears well-calibrated.\n")

        # Individual trade breakdown
        f.write(f"\n{'=' * 70}\n")
        f.write("INDIVIDUAL TRADE BREAKDOWN\n")
        f.write("-" * 70 + "\n")
        for i, t in enumerate(analyzed_trades, 1):
            a_str = ", ".join(f"{p['name']} ({p['position']}, kv={p['keeper_value']:.3f})" for p in t["side_a_players"])
            b_str = ", ".join(f"{p['name']} ({p['position']}, kv={p['keeper_value']:.3f})" for p in t["side_b_players"])
            if t["side_a_picks"]:
                a_str += " + " + ", ".join(f"Rd{pk['round']} pick" for pk in t["side_a_picks"])
            if t["side_b_picks"]:
                b_str += " + " + ", ".join(f"Rd{pk['round']} pick" for pk in t["side_b_picks"])

            fairness_label = "FAIR" if abs(t["residual"]) < 0.05 else \
                "Side A overpaid" if t["residual"] > 0 else "Side B overpaid"

            f.write(f"\nTrade {i} (S{t['season']} W{t['week']}, conf={t['confidence']:.2f}):\n")
            f.write(f"  Side A sends: {a_str}\n")
            f.write(f"  Side B sends: {b_str}\n")
            f.write(f"  Model: A={t['side_a_total']:.4f}, B={t['side_b_total']:.4f} → "
                    f"fairness={t['model_fairness']:.3f} ({fairness_label})\n")

    print(f"Saved report to {path}")


def save_trades_csv(analyzed_trades):
    """Save per-trade detail to CSV."""
    rows = []
    for t in analyzed_trades:
        a_names = "; ".join(p["name"] for p in t["side_a_players"])
        b_names = "; ".join(p["name"] for p in t["side_b_players"])
        a_positions = "; ".join(p["position"] for p in t["side_a_players"])
        b_positions = "; ".join(p["position"] for p in t["side_b_players"])

        rows.append({
            "season": t["season"],
            "week": t["week"],
            "side_a_players": a_names,
            "side_a_positions": a_positions,
            "side_b_players": b_names,
            "side_b_positions": b_positions,
            "side_a_player_kv": t["side_a_player_kv"],
            "side_b_player_kv": t["side_b_player_kv"],
            "side_a_pick_kv": t["side_a_pick_kv"],
            "side_b_pick_kv": t["side_b_pick_kv"],
            "side_a_total": t["side_a_total"],
            "side_b_total": t["side_b_total"],
            "model_fairness": t["model_fairness"],
            "residual": t["residual"],
            "confidence": t["confidence"],
            "is_one_for_one": t["is_one_for_one"],
        })

    df = pd.DataFrame(rows)
    path = os.path.join(OUTPUT_DIR, "calibration_trades.csv")
    df.to_csv(path, index=False)
    print(f"Saved {len(rows)} trades to {path}")


def save_corrections_json(pos_bias, recommendations):
    """Save machine-readable correction factors."""
    corrections = {
        "generated": datetime.now().isoformat(),
        "positional_bias": pos_bias,
        "positional_multipliers": {
            pos: data["implied_multiplier"]
            for pos, data in pos_bias.items()
            if data.get("count", 0) >= 5
        },
        "recommendations": recommendations,
    }
    path = os.path.join(OUTPUT_DIR, "calibration_corrections.json")
    with open(path, "w") as f:
        json.dump(corrections, f, indent=2)
    print(f"Saved corrections to {path}")


# ── MAIN ──────────────────────────────────────────────────────────────────

def main():
    league_id = os.environ.get("LEAGUE_ID")
    if not league_id:
        print("ERROR: Set LEAGUE_ID environment variable")
        print("  LEAGUE_ID=<your_id> python scripts/calibrate_model.py")
        sys.exit(1)

    print("=" * 60)
    print("KEEPER VALUE MODEL CALIBRATION")
    print("=" * 60)

    # Step 1: Fetch trades from Sleeper
    print("\n[1/5] Fetching trade history from Sleeper...")
    sleeper_players = get_all_players_cached()
    trades = fetch_all_trades(league_id)

    if not trades:
        print("No trades found. Check your LEAGUE_ID.")
        sys.exit(1)

    # Step 2: Pull NFL data and build historical values
    print("\n[2/5] Pulling NFL data via nflreadpy...")
    stats, rosters, all_players, draft_picks = pull_data()
    stats = calculate_fantasy_points(stats)
    df = merge_bio_data(stats, rosters)

    # Determine which seasons we need historical values for
    trade_seasons = sorted(set(t["_season"] for t in trades))
    print(f"  Trade seasons: {trade_seasons}")

    print("\n[3/5] Reconstructing historical keeper values...")
    historical = build_historical_values(df, all_players, trade_seasons)

    # Step 3: Analyze trades
    print("\n[4/5] Analyzing trades for bias...")
    analyzed = analyze_trades(trades, historical, sleeper_players)
    print(f"  {len(analyzed)} trades analyzed (of {len(trades)} total)")

    if not analyzed:
        print("No trades could be analyzed. Check player name matching.")
        sys.exit(1)

    # Step 4: Compute biases
    pos_bias = compute_positional_bias(analyzed)
    cross_pos = compute_cross_position_rates(analyzed)
    age_bias = compute_age_bias(analyzed)
    elite_bias = compute_elite_bias(analyzed)

    # Step 5: Generate recommendations and save
    print("\n[5/5] Generating report...")
    recommendations = generate_recommendations(pos_bias, cross_pos, age_bias, elite_bias)

    save_report(analyzed, pos_bias, cross_pos, age_bias, elite_bias, recommendations)
    save_trades_csv(analyzed)
    save_corrections_json(pos_bias, recommendations)

    # Print summary
    print(f"\n{'=' * 60}")
    print("CALIBRATION SUMMARY")
    print(f"{'=' * 60}")
    for pos in POSITIONS:
        b = pos_bias.get(pos, {})
        if b.get("count", 0) >= 5:
            avg_r = b["avg_residual"]
            signal = "UNDERVALUED" if avg_r < -0.03 else "OVERVALUED" if avg_r > 0.03 else "~fair"
            print(f"  {pos}: residual {avg_r:+.4f} ({signal}, n={b['count']})")

    if recommendations:
        print(f"\n{len(recommendations)} parameter recommendations generated.")
    print("\nCheck output/ for full report, trades CSV, and corrections JSON.")


if __name__ == "__main__":
    main()
