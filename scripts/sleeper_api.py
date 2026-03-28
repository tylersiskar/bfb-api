"""
Shared Sleeper API Helpers
===========================
Common functions for interacting with the Sleeper API,
including player database caching.
"""

import json
import os
import time
import requests

SLEEPER_BASE = "https://api.sleeper.app/v1"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "..", "output")
PLAYERS_CACHE_PATH = os.path.join(OUTPUT_DIR, "sleeper_players_cache.json")


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
    Fetch the full NFL player database from Sleeper with 24h file cache.
    Returns dict keyed by player_id.
    """
    if os.path.exists(PLAYERS_CACHE_PATH):
        age_hours = (time.time() - os.path.getmtime(PLAYERS_CACHE_PATH)) / 3600
        if age_hours < 24:
            with open(PLAYERS_CACHE_PATH) as f:
                return json.load(f)

    print("  Downloading Sleeper player database...")
    r = requests.get(f"{SLEEPER_BASE}/players/nfl")
    r.raise_for_status()
    players = r.json()

    os.makedirs(os.path.dirname(PLAYERS_CACHE_PATH), exist_ok=True)
    with open(PLAYERS_CACHE_PATH, "w") as f:
        json.dump(players, f)

    return players


def get_player_stats(season, week=None):
    """Fetch player stats for a season (or specific week)."""
    if week:
        url = f"{SLEEPER_BASE}/stats/nfl/regular/{season}/{week}"
    else:
        url = f"{SLEEPER_BASE}/stats/nfl/regular/{season}"
    r = requests.get(url)
    r.raise_for_status()
    return r.json()


def get_player_projections(season, week=None):
    """Fetch player projections for a season (or specific week)."""
    if week:
        url = f"{SLEEPER_BASE}/projections/nfl/regular/{season}/{week}"
    else:
        url = f"{SLEEPER_BASE}/projections/nfl/regular/{season}"
    r = requests.get(url)
    if r.status_code == 200:
        return r.json()
    return {}


def get_transactions(league_id, week):
    """Fetch all transactions for a given league+week."""
    r = requests.get(f"{SLEEPER_BASE}/league/{league_id}/transactions/{week}")
    r.raise_for_status()
    return r.json()


def get_league_chain(league_id):
    """
    Follow the previous_league_id chain to get all historical league IDs.
    Returns list of (league_id, season) tuples, newest first.
    """
    chain = []
    current_id = league_id
    while current_id:
        info = get_league_info(current_id)
        season = int(info.get("season", 0))
        chain.append((current_id, season))
        current_id = info.get("previous_league_id")
        if current_id and str(current_id) != "0":
            time.sleep(0.3)
        else:
            current_id = None
    return chain
