"""
Sleeper API Integration
========================
Pulls your league's roster data from Sleeper and cross-references it
with the keeper value model to recommend your best 8 keepers.

Usage:
    python sleeper_integration.py <LEAGUE_ID>

    Your league ID is in the URL when you view your league on Sleeper:
    https://sleeper.com/leagues/<LEAGUE_ID>
"""

import requests
import json
import sys
import os
import pandas as pd

SLEEPER_BASE = "https://api.sleeper.app/v1"


def get_league_info(league_id):
    """Fetch league metadata."""
    r = requests.get(f"{SLEEPER_BASE}/league/{league_id}")
    r.raise_for_status()
    return r.json()


def get_league_users(league_id):
    """Fetch all users in the league."""
    r = requests.get(f"{SLEEPER_BASE}/league/{league_id}/users")
    r.raise_for_status()
    return r.json()


def get_league_rosters(league_id):
    """Fetch all rosters in the league."""
    r = requests.get(f"{SLEEPER_BASE}/league/{league_id}/rosters")
    r.raise_for_status()
    return r.json()


def get_all_players():
    """
    Fetch the full NFL player database from Sleeper.
    This is a large response (~20MB) — cache it locally.
    """
    cache_path = "output/sleeper_players_cache.json"

    if os.path.exists(cache_path):
        mod_time = os.path.getmtime(cache_path)
        import time
        age_hours = (time.time() - mod_time) / 3600
        if age_hours < 24:
            print("  Using cached player database...")
            with open(cache_path) as f:
                return json.load(f)

    print("  Downloading full player database (this may take a moment)...")
    r = requests.get(f"{SLEEPER_BASE}/players/nfl")
    r.raise_for_status()
    players = r.json()

    os.makedirs("output", exist_ok=True)
    with open(cache_path, "w") as f:
        json.dump(players, f)

    return players


def get_player_stats(season, week=None):
    """
    Fetch player stats for a season.
    If week is None, returns full-season stats.
    """
    if week:
        url = f"{SLEEPER_BASE}/stats/nfl/regular/{season}/{week}"
    else:
        url = f"{SLEEPER_BASE}/stats/nfl/regular/{season}"
    r = requests.get(url)
    r.raise_for_status()
    return r.json()


def get_player_projections(season, week=None):
    """
    Fetch player projections for a season.
    If week is None, returns full-season projections.
    """
    if week:
        url = f"{SLEEPER_BASE}/projections/nfl/regular/{season}/{week}"
    else:
        url = f"{SLEEPER_BASE}/projections/nfl/regular/{season}"
    r = requests.get(url)
    if r.status_code == 200:
        return r.json()
    return {}


def build_roster_dataframe(league_id):
    """
    Build a comprehensive DataFrame of all players on all rosters,
    enriched with player metadata from Sleeper.
    """
    print("Fetching league data...")
    league = get_league_info(league_id)
    users = get_league_users(league_id)
    rosters = get_league_rosters(league_id)
    players_db = get_all_players()

    print(f"  League: {league.get('name', 'Unknown')}")
    print(f"  Season: {league.get('season', 'Unknown')}")
    print(f"  Teams: {len(rosters)}")

    # Map owner_id to display name
    user_map = {}
    for u in users:
        user_map[u["user_id"]] = u.get("display_name", u["user_id"])

    # Build roster rows
    rows = []
    for roster in rosters:
        owner = user_map.get(roster.get("owner_id", ""), "Unknown")
        roster_id = roster["roster_id"]
        player_ids = roster.get("players", []) or []
        keeper_ids = roster.get("keepers", []) or []

        for pid in player_ids:
            player = players_db.get(pid, {})
            rows.append({
                "player_id": pid,
                "player_name": player.get("full_name", f"ID:{pid}"),
                "position": player.get("position", "UNK"),
                "team": player.get("team", "FA"),
                "age": player.get("age", None),
                "years_exp": player.get("years_exp", None),
                "status": player.get("status", "Unknown"),
                "injury_status": player.get("injury_status", None),
                "owner": owner,
                "roster_id": roster_id,
                "is_keeper": pid in keeper_ids,
            })

    return pd.DataFrame(rows), league


def merge_with_keeper_values(roster_df, values_path="output/keeper_values.csv"):
    """
    Merge Sleeper roster data with pre-computed keeper values.
    """
    if not os.path.exists(values_path):
        print(f"\nWarning: {values_path} not found.")
        print("Run keeper_value_model.py first to generate keeper values.")
        return roster_df

    values = pd.read_csv(values_path, index_col=0)

    # Merge on player name (fuzzy matching would be better but this works for most)
    merged = roster_df.merge(
        values[["player_name", "fantasy_points", "keeper_value",
                "longevity_score", "scarcity_score", "durability_score",
                "projected_years_elite"]],
        on="player_name",
        how="left",
    )

    return merged


def recommend_keepers(roster_df, team_name, n_keepers=8):
    """
    Recommend the best N keepers for a specific team.
    """
    team = roster_df[roster_df["owner"] == team_name].copy()

    if team.empty:
        print(f"Team '{team_name}' not found.")
        print(f"Available teams: {roster_df['owner'].unique().tolist()}")
        return None

    if "keeper_value" not in team.columns or team["keeper_value"].isna().all():
        print("No keeper values available. Using age-based heuristic.")
        # Simple fallback: prefer younger players at premium positions
        pos_rank = {"QB": 3, "RB": 4, "WR": 4, "TE": 2}
        team["heuristic_value"] = team.apply(
            lambda r: pos_rank.get(r["position"], 1) * max(0, 35 - (r["age"] or 27)),
            axis=1,
        )
        team = team.sort_values("heuristic_value", ascending=False)
        keepers = team.head(n_keepers)
    else:
        team = team.sort_values("keeper_value", ascending=False)
        keepers = team.head(n_keepers)

    return keepers


def analyze_league_keepers(roster_df, n_keepers=8):
    """
    Analyze optimal keepers for every team and project the draft pool.
    """
    all_keepers = []
    all_releases = []

    for owner in roster_df["owner"].unique():
        team = roster_df[roster_df["owner"] == owner].copy()
        if "keeper_value" in team.columns:
            team = team.sort_values("keeper_value", ascending=False)
        else:
            team = team.sort_values("age", ascending=True)

        kept = team.head(n_keepers)
        released = team.iloc[n_keepers:]

        all_keepers.append(kept)
        all_releases.append(released)

    keepers_df = pd.concat(all_keepers, ignore_index=True)
    releases_df = pd.concat(all_releases, ignore_index=True)

    return keepers_df, releases_df


def print_team_report(roster_df, team_name, n_keepers=8):
    """Print a detailed keeper recommendation for one team."""
    keepers = recommend_keepers(roster_df, team_name, n_keepers)
    if keepers is None:
        return

    team = roster_df[roster_df["owner"] == team_name].copy()

    print(f"\n{'='*60}")
    print(f"KEEPER RECOMMENDATIONS: {team_name}")
    print(f"{'='*60}")

    val_col = "keeper_value" if "keeper_value" in keepers.columns else "heuristic_value"

    print(f"\n{'KEEP':>6}  {'Player':<25}{'Pos':<5}{'Age':<5}{'Value':<10}")
    print("-" * 55)

    for i, (_, row) in enumerate(team.sort_values(val_col, ascending=False).iterrows()):
        marker = ">>>" if i < n_keepers else "   "
        val = row.get(val_col, 0)
        val_str = f"{val:.3f}" if pd.notna(val) else "N/A"
        print(f"{marker:>6}  {row['player_name']:<25}{row['position']:<5}"
              f"{row.get('age', '?'):<5}{val_str:<10}")

    kept_positions = keepers["position"].value_counts().to_dict()
    print(f"\nKept by position: {kept_positions}")

    # Check for positional balance warnings
    if kept_positions.get("RB", 0) < 2:
        print("  ⚠  Warning: Keeping fewer than 2 RBs")
    if kept_positions.get("WR", 0) < 2:
        print("  ⚠  Warning: Keeping fewer than 2 WRs")
    if kept_positions.get("QB", 0) < 1:
        print("  ⚠  Warning: No QB keeper — you'll need to draft one early")


# ── MAIN ────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: python sleeper_integration.py <LEAGUE_ID> [YOUR_TEAM_NAME]")
        print("\nYour league ID is in the Sleeper URL:")
        print("  https://sleeper.com/leagues/<LEAGUE_ID>")
        sys.exit(1)

    league_id = sys.argv[1]
    team_name = sys.argv[2] if len(sys.argv) > 2 else None

    # Build roster data
    roster_df, league = build_roster_dataframe(league_id)

    # Try to merge with keeper values from the model
    roster_df = merge_with_keeper_values(roster_df)

    # Save full roster data
    os.makedirs("output", exist_ok=True)
    roster_path = "output/league_rosters.csv"
    roster_df.to_csv(roster_path, index=False)
    print(f"\nSaved roster data to {roster_path}")

    if team_name:
        # Specific team report
        print_team_report(roster_df, team_name)
    else:
        # All teams
        print(f"\nTeams in league:")
        for owner in sorted(roster_df["owner"].unique()):
            count = len(roster_df[roster_df["owner"] == owner])
            print(f"  {owner}: {count} players")

        print("\nTo get keeper recommendations for your team, run:")
        print(f'  python sleeper_integration.py {league_id} "YOUR_DISPLAY_NAME"')

    # League-wide analysis
    if "keeper_value" in roster_df.columns and roster_df["keeper_value"].notna().any():
        keepers, releases = analyze_league_keepers(roster_df)

        print(f"\n{'='*60}")
        print("PROJECTED DRAFT POOL (released players)")
        print(f"{'='*60}")
        if "keeper_value" in releases.columns:
            top_available = releases.sort_values("keeper_value", ascending=False).head(20)
        else:
            top_available = releases.head(20)

        print(f"\n{'Player':<25}{'Pos':<5}{'Age':<5}{'Former Team':<20}")
        print("-" * 55)
        for _, row in top_available.iterrows():
            print(f"{row['player_name']:<25}{row['position']:<5}"
                  f"{row.get('age', '?'):<5}{row['owner']:<20}")


if __name__ == "__main__":
    main()
