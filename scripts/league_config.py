"""
Shared League Configuration
=============================
Single source of truth for league settings used across all scripts.
"""

import os

# ── League Structure ──
NUM_TEAMS = 12
KEEPER_SLOTS = 8
ROSTER_SIZE = 16
POSITIONS = ["QB", "RB", "WR", "TE"]

# Starting lineup slots
STARTERS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 1}
FLEX_ELIGIBLE = ["RB", "WR", "TE"]

# ── Identifiers ──
LEAGUE_ID = os.environ.get("LEAGUE_ID", "1312089696964202496")

# ── Keeper Value Threshold ──
KEEPER_VALUE_THRESHOLD = 0.178
