# Fantasy Football Keeper Value Model

A data-driven keeper value system for a **12-team, 0.5 PPR** dynasty/keeper league with **8 keepers from 16-man rosters**.

## What It Does

1. **Pulls 8 years of NFL data** (2018-2025) via `nflreadpy` (seasonal stats, rosters, draft picks, player descriptors)
2. **Builds positional aging curves** using the delta method — shows how QB/RB/WR/TE production changes with age
3. **Scores every player's keeper value** using a weighted composite of production, longevity, scarcity, and durability
4. **Generates a trade report** (`generate_trade_report.py`) by combining keeper values with actual Sleeper league rosters from PostgreSQL — uses a KV threshold (0.178) instead of a fixed pool size to determine keeper-worthy players

## Keeper Value Composite

The final keeper value is a weighted blend of four components, multiplied by a confidence factor and adjusted with elite bonuses and prime window discounting:

```
WEIGHTS = {
    "current_season": 0.60,   # VOR-based production (dominant factor)
    "longevity":      0.25,   # discounted future production via aging curves
    "scarcity":       0.10,   # positional replaceability
    "durability":     0.05,   # games played consistency
}
```

### Key Mechanics

**Value Over Replacement (VOR)** — Production is measured relative to replacement level (the fantasy points of the #13 player at RB/WR, #7 QB, #7 TE for a 12-team league). All VOR values are normalized globally (not per-position) to avoid overvaluing QB/TE.

**Soft Landing** — Players within 70-100% of replacement level get partial VOR credit instead of a hard zero. This prevents a cliff where a player at 99% of replacement scores the same as one at 50%.

**Recency-Weighted Multi-Season Production** — The model uses up to 3 seasons of data, weighted by experience level:

| Experience (years_exp) | Seasons Used | Weights (latest → oldest) |
|------------------------|-------------|--------------------------|
| Rookie (0) | 1 | Latest only |
| 2nd year (1) | 2 | 3.0 / 1.0 |
| 3rd year (2) | 3 | 4.0 / 1.5 / 0.25 |
| 4th-5th year (3-4) | 3 | 4.0 / 1.0 / 0.5 |
| Mid-career (5-6) | 3 | 4.0 / 1.5 / 1.0 (non-QB) or 3.0 / 2.0 / 1.0 (QB) |
| Veteran (7+) | 3 | 2.0 / 1.5 / 1.0 |

Note: `years_exp` is 0-indexed from nflreadpy (0 = rookie season).

**Injury-Shortened Season Filter** — Seasons with very few games are dropped so injuries don't tank a player's value:
- Veterans (>3 years exp): drop seasons with <13 games
- Young players (<=3 years exp): drop seasons with <6 games (catches true injuries like Nabers' 4-game 2025 while keeping half-season performances)

**Outlier Detection** — With 3+ seasons, the model drops at most 1 statistical outlier: a non-recent fluke good year (>60% above median of others) or a one-off down year (<60% of median of others).

**Draft Capital Blending** — For players with limited game history, draft position (OTC values) blends into the score. The blend weight fades with experience: 40% for rookies, 20% for 2nd year, 10% for 3rd year, 0% after. Capped at 0.40 so unproven draft picks can't outscore proven producers.

**Elite Tier Bonus** — Top-3 at each position get a flat bonus (0.14 scaled by roster demand), compressing elite tiers together. Positions with more starter slots (RB: 2 + FLEX share, WR: 3 + FLEX share) get larger bonuses than QB/TE.

**Prime Window Discount** — Players with fewer projected elite years (aging curve multiplier >0.7) get discounted. A player with 2 elite years left scores ~85% of one with 4. This penalizes aging stars like CMC as keeper assets despite elite current production.

## Quick Start

### Install dependencies
```bash
pip install nflreadpy pandas numpy
```

### Run the keeper model
```bash
python scripts/keeper_value_model.py
```
Outputs:
- `output/keeper_values.csv` — full ranked list with all component scores
- `output/top_qb_keepers.csv`, `top_rb_keepers.csv`, `top_wr_keepers.csv`, `top_te_keepers.csv`
- `output/aging_curves.json` — positional aging curves
- `output/keeper_report.txt` — formatted top-50 overall + top-20 per position

### Generate the trade report
Requires PostgreSQL with synced Sleeper league data (rosters, nfl_players tables). Set env vars `PG_USER`, `PG_PASSWORD`, `PG_HOST`, `PG_DB`, `LEAGUE_ID`.
```bash
python scripts/generate_trade_report.py
```
Outputs `output/trade_report.txt` with:
- Keeper value thresholds and tier breakdowns (top 96 = keeper-worthy)
- Team-by-team keeper analysis (surplus players marked with *, near-keeper-worthy listed)
- Trade opportunities: surplus/needs matching and suggested fits
- Diminishing value curves by position

## Configuration

### Key Constants (top of `keeper_value_model.py`)
```python
SEASONS = list(range(2018, 2026))  # 8 years of historical data
KEEPER_SLOTS = 8
ROSTER_SIZE = 16
NUM_TEAMS = 12
PROJECTION_YEARS = 4              # how far ahead to project
DISCOUNT_RATE = 0.18              # annual uncertainty discount
MIN_GAMES = 10                    # minimum games to qualify
STARTERS = {"QB": 1, "RB": 2, "WR": 3, "TE": 1, "FLEX": 1}
DRAFT_CAPITAL_CAP = 0.40          # max score from draft pedigree alone
```

## How the Aging Curves Work

The model uses the **delta method**: for every player-season pair, it calculates the year-over-year change in fantasy points per game, then averages those deltas by position and age. This produces a curve showing, at each age, whether players typically improve or decline.

Typical findings:
- **RBs** peak 23-26, steep cliff after 27
- **WRs** peak 25-29, gradual decline
- **QBs** maintain production well into their 30s
- **TEs** late bloomers, peak 26-30

## File Structure

```
bfb-api/
├── scripts/
│   ├── keeper_value_model.py       # Core model — pulls data, builds curves, scores players
│   ├── generate_trade_report.py    # Trade report — combines keeper values with league rosters
│   ├── ktc_scraper.py              # KeepTradeCut value scraper
│   └── KEEPER_VALUE_README.md
├── output/
│   ├── keeper_values.csv           # Full ranked player list
│   ├── top_qb_keepers.csv          # Position-specific rankings
│   ├── top_rb_keepers.csv
│   ├── top_wr_keepers.csv
│   ├── top_te_keepers.csv
│   ├── aging_curves.json           # Raw aging curve data
│   ├── keeper_report.txt           # Formatted keeper value report
│   └── trade_report.txt            # Weekly trade report
└── tasks.js                        # Cron jobs:
    #   Wednesdays 10:45pm EDT — player update (stats, players, KTC, keeper model)
    #   Tuesdays 10:00pm EDT — trade report (surplus + trade fits sent to dev GroupMe)
```
