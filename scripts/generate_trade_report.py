#!/usr/bin/env python3
"""
Generate BFB Weekly Trade Report from keeper_values.csv and PostgreSQL roster data.
"""
import csv
import re
import os
import sys
from datetime import datetime
from collections import defaultdict

from db import connect_db
from league_config import (
    LEAGUE_ID, KEEPER_SLOTS as KEEPERS_PER_TEAM, NUM_TEAMS,
    KEEPER_VALUE_THRESHOLD, STARTERS, FLEX_ELIGIBLE as FLEX_POSITIONS,
)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "..", "output")
CSV_PATH = os.path.join(OUTPUT_DIR, "keeper_values.csv")
REPORT_PATH = os.path.join(OUTPUT_DIR, "trade_report.txt")


def load_keeper_values():
    players = []
    with open(CSV_PATH) as f:
        reader = csv.DictReader(f)
        for row in reader:
            players.append({
                "rank": int(row["rank"]),
                "name": row["player_name"],
                "position": row["position"],
                "age": int(float(row["age"])) if row["age"] else 27,
                "fantasy_points": float(row["fantasy_points"]),
                "keeper_value": float(row["keeper_value"]),
                "projected_years_elite": int(row["projected_years_elite"]),
            })
    return players


def load_rosters():
    conn = connect_db()
    cur = conn.cursor()

    # Get rosters with owner info
    cur.execute("""
        SELECT r.roster_id, r.owner_id, r.player_ids,
               lu.display_name
        FROM rosters r
        JOIN league_users lu ON lu.user_id = r.owner_id AND lu.league_id = r.league_id
        WHERE r.league_id = %s
    """, (LEAGUE_ID,))
    rosters = []
    for roster_id, owner_id, player_ids, display_name in cur.fetchall():
        rosters.append({
            "roster_id": roster_id,
            "owner_id": owner_id,
            "display_name": display_name,
            "player_ids": player_ids or [],
        })

    # Get player name/position/team mapping
    cur.execute("SELECT id, first_name, last_name, position, team FROM nfl_players")
    player_map = {}
    for pid, first, last, pos, team in cur.fetchall():
        player_map[pid] = {
            "name": f"{first} {last}",
            "position": pos,
            "team": team or "FA",
        }

    cur.close()
    conn.close()
    return rosters, player_map


def assign_tiers(keeper_pool):
    q_size = len(keeper_pool) // 4
    tier_labels = {1: "Elite", 2: "Strong", 3: "Solid", 4: "Fringe"}
    for i, p in enumerate(keeper_pool):
        if q_size > 0:
            tier = min(i // q_size + 1, 4)
        else:
            tier = 1
        p["tier"] = tier
        p["tier_label"] = tier_labels[tier]


def generate_report():
    all_players = load_keeper_values()
    keeper_pool = [p for p in all_players if p["keeper_value"] >= KEEPER_VALUE_THRESHOLD]
    keeper_pool_size = len(keeper_pool)
    assign_tiers(keeper_pool)

    # Build lookup by name, including normalized versions without suffixes
    # (e.g. "Brian Thomas Jr." -> also match "Brian Thomas")
    kv_by_name = {p["name"]: p for p in all_players}
    SUFFIXES = re.compile(r'\s+(Jr\.?|Sr\.?|III|II|IV|V)$', re.IGNORECASE)
    for p in all_players:
        normalized = SUFFIXES.sub('', p["name"])
        if normalized != p["name"] and normalized not in kv_by_name:
            kv_by_name[normalized] = p

    rosters, player_map = load_rosters()

    # Build team analyses
    teams = []
    for roster in rosters:
        team = {
            "name": roster["display_name"],
            "roster_id": roster["roster_id"],
            "keeper_worthy": [],
            "near_keeper": [],
            "all_players": [],
        }

        for pid in roster["player_ids"]:
            pm = player_map.get(pid)
            if not pm:
                continue
            pname = pm["name"]
            kv = kv_by_name.get(pname)
            if kv:
                entry = {**kv, "team_abbr": pm["team"]}
                team["all_players"].append(entry)
                if kv["keeper_value"] >= KEEPER_VALUE_THRESHOLD:
                    team["keeper_worthy"].append(entry)
                elif kv["keeper_value"] >= KEEPER_VALUE_THRESHOLD * 0.75:
                    team["near_keeper"].append(entry)

        # Sort by keeper value descending
        team["keeper_worthy"].sort(key=lambda x: x["keeper_value"], reverse=True)
        team["near_keeper"].sort(key=lambda x: x["keeper_value"], reverse=True)
        team["total_kv"] = sum(p["keeper_value"] for p in team["keeper_worthy"])
        team["surplus_players"] = team["keeper_worthy"][KEEPERS_PER_TEAM:] if len(team["keeper_worthy"]) > KEEPERS_PER_TEAM else []
        team["surplus_count"] = len(team["surplus_players"])

        # Determine positional needs
        kw_positions = [p["position"] for p in team["keeper_worthy"][:KEEPERS_PER_TEAM]]
        needs = []
        for pos in ["QB", "RB", "WR", "TE"]:
            count = kw_positions.count(pos)
            if pos == "QB" and count < 1:
                needs.append("QB")
            elif pos == "RB" and count < 2:
                needs.append("RB")
            elif pos == "WR" and count < 2:
                needs.append("WR")
            elif pos == "TE" and count < 1:
                needs.append("TE")
        team["needs"] = needs
        teams.append(team)

    # Sort teams by total keeper value descending
    teams.sort(key=lambda t: t["total_kv"], reverse=True)

    # ── Build report text ──
    lines = []
    w = lines.append

    w("=" * 80)
    w("BFB WEEKLY TRADE REPORT")
    w(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    w(f"Keeper-worthy threshold: KV >= {KEEPER_VALUE_THRESHOLD}")
    w(f"Keeper-worthy players: {keeper_pool_size}")
    w(f"Keeper slots per team: {KEEPERS_PER_TEAM}")
    w("=" * 80)

    # Thresholds
    w("")
    w("KEEPER VALUE THRESHOLDS")
    w("-" * 80)
    cutoff = keeper_pool[-1] if keeper_pool else None
    # Use tiers already assigned by assign_tiers()
    tier_groups = {}
    for p in keeper_pool:
        t = p["tier"]
        tier_groups.setdefault(t, []).append(p)
    if cutoff:
        w(f"  Keeper-worthy cutoff: {cutoff['name']} ({cutoff['position']}) = {cutoff['keeper_value']:.3f}")
    tier_labels = {1: "Elite", 2: "Strong", 3: "Solid", 4: "Fringe"}
    running_count = 0
    for tier_num in sorted(tier_groups):
        group = tier_groups[tier_num]
        start = running_count + 1
        end = running_count + len(group)
        label = tier_labels.get(tier_num, f"Tier {tier_num}")
        w(f"  Tier {tier_num} ({label}, {start}-{end}):     {group[0]['keeper_value']:.3f} - {group[-1]['keeper_value']:.3f}")
        running_count = end

    # Team-by-team
    w("")
    w("")
    w("TEAM-BY-TEAM KEEPER ANALYSIS")
    w("=" * 80)

    for team in teams:
        w("")
        w(f"  {team['name'].upper()} (Roster {team['roster_id']})")
        kw_count = len(team["keeper_worthy"])
        w(f"  Keeper-worthy: {kw_count}/{KEEPERS_PER_TEAM} slots  |  Total Keeper Value: {team['total_kv']:.3f}")
        if team["surplus_count"] > 0:
            w(f"  SURPLUS: {team['surplus_count']} tradeable keeper-worthy players")
        if team["needs"]:
            w(f"  NEEDS: {'  '.join(team['needs'])}")
        w("  " + "-" * 76)
        w(f"  {'Player':<28s}{'Pos':<5s}{'Age':<5s}{'Team':<6s}{'FP':<8s}{'KV':<8s}{'Rank':<6s}{'Yrs Elite':<10s}")

        keepers = team["keeper_worthy"][:KEEPERS_PER_TEAM]
        surplus = team["surplus_players"]

        for p in keepers:
            w(f"  {p['name']:<28s}{p['position']:<5s}{p['age']:<5d}{p.get('team_abbr','?'):<6s}{p['fantasy_points']:<8.1f}{p['keeper_value']:<8.3f}{p['rank']:<6d}{p['projected_years_elite']:<10d}")

        for p in surplus:
            w(f" *{p['name']:<28s}{p['position']:<5s}{p['age']:<5d}{p.get('team_abbr','?'):<6s}{p['fantasy_points']:<8.1f}{p['keeper_value']:<8.3f}{p['rank']:<6d}{p['projected_years_elite']:<10d}")

        if team["near_keeper"][:3]:
            w("  -- Near keeper-worthy --")
            for p in team["near_keeper"][:3]:
                w(f"    {p['name']:<28s}{p['position']:<5s}{p['age']:<5d}{p.get('team_abbr','?'):<6s}{p['fantasy_points']:<8.1f}{p['keeper_value']:<8.3f}{p['rank']:<6d}")

    # Trade opportunities
    w("")
    w("")
    w("TRADE OPPORTUNITIES")
    w("=" * 80)

    surplus_teams = [t for t in teams if t["surplus_count"] > 0]
    need_teams = [t for t in teams if t["needs"]]

    w("")
    w("SURPLUS (keeper-worthy players beyond 8 slots - trade candidates):")
    w("-" * 80)
    for t in surplus_teams:
        surplus_str = ", ".join(
            f"{p['name']} ({p['position']}, KV:{p['keeper_value']:.3f})"
            for p in t["surplus_players"]
        )
        w(f"  {t['name']} ({len(t['keeper_worthy'])} keepers): {surplus_str}")

    w("")
    w("NEEDS (teams with <8 keeper-worthy players):")
    w("-" * 80)
    for t in need_teams:
        w(f"  {t['name']} ({len(t['keeper_worthy'])} keepers): needs {'  '.join(t['needs'])}")

    # Suggested trade fits
    w("")
    w("SUGGESTED TRADE FITS:")
    w("-" * 80)
    for st in surplus_teams:
        for sp in st["surplus_players"]:
            best_fit = None
            for nt in need_teams:
                if nt["name"] == st["name"]:
                    continue
                if sp["position"] in nt["needs"] or (sp["position"] in FLEX_POSITIONS and "RB" in nt["needs"]):
                    best_fit = nt
                    break
            if not best_fit:
                # Any team with fewer than 8
                for nt in need_teams:
                    if nt["name"] != st["name"]:
                        best_fit = nt
                        break
            if best_fit:
                w(f"  {sp['name']:<26s}({sp['position']}, KV:{sp['keeper_value']:.3f})  {st['name']} -> {best_fit['name']}")

    # Diminishing value analysis
    w("")
    w("")
    w("DIMINISHING VALUE ANALYSIS")
    w("=" * 80)
    w("Value drop-offs at key thresholds:")

    for pos in ["RB", "WR", "QB", "TE"]:
        pos_players = [p for p in all_players if p["position"] == pos]
        pos_players.sort(key=lambda x: x["keeper_value"], reverse=True)
        w(f"")
        w(f"  {pos} Value Curve:")

        checkpoints = [1, 3, 5, 8, 12, 16, 20, 24]
        prev_kv = None
        for idx in checkpoints:
            if idx <= len(pos_players):
                p = pos_players[idx - 1]
                if prev_kv and prev_kv > 0:
                    drop = (prev_kv - p["keeper_value"]) / prev_kv * 100
                    w(f"    #{idx:<5d}{p['name']:<26s}{p['keeper_value']:.3f}  ({drop:.0f}% drop)")
                else:
                    w(f"    #{idx:<5d}{p['name']:<26s}{p['keeper_value']:.3f}")
                prev_kv = p["keeper_value"]

    report_text = "\n".join(lines) + "\n"

    with open(REPORT_PATH, "w") as f:
        f.write(report_text)

    print(f"Trade report saved to {REPORT_PATH}")
    return report_text


if __name__ == "__main__":
    generate_report()
