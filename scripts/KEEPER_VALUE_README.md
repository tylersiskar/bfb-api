# Fantasy Football Keeper Value Model

A data-driven keeper value system for fantasy football leagues, built for **0.5 PPR scoring** with **8 keepers from 16-man rosters**.

## What It Does

1. **Pulls 7 years of NFL data** via `nfl_data_py` (play-by-play stats, rosters, snap counts)
2. **Builds positional aging curves** using the delta method — shows how QB/RB/WR/TE production changes with age
3. **Scores every player's keeper value** using a weighted composite:
   - **40%** Current season production
   - **30%** Longevity (discounted future production based on aging curves)
   - **20%** Positional scarcity (how replaceable they are)
   - **10%** Durability (games played consistency)
4. **Integrates with Sleeper** to pull your actual league rosters and recommend your best 8 keepers

## Quick Start

### Install dependencies
```bash
pip install nfl_data_py pandas numpy matplotlib requests
```

### Step 1: Build the value model
```bash
python keeper_value_model.py
```
This takes a few minutes to download historical data, then outputs:
- `output/keeper_values.csv` — full ranked list of all players
- `output/top_rb_keepers.csv`, `top_wr_keepers.csv`, etc.
- `output/aging_curves.json` — positional aging curves
- `output/keeper_report.txt` — formatted report

### Step 2: Get your Sleeper league recommendations
```bash
# Find your league ID from the Sleeper URL:
# https://sleeper.com/leagues/YOUR_LEAGUE_ID

python sleeper_integration.py YOUR_LEAGUE_ID

# For your specific team's keeper recommendations:
python sleeper_integration.py YOUR_LEAGUE_ID "YourDisplayName"
```

## Customization

### Scoring Settings
Edit the `SCORING` dict at the top of `keeper_value_model.py`:
```python
SCORING = {
    "passing_yards": 0.04,
    "passing_tds": 4,
    "receptions": 0.5,    # change to 1.0 for full PPR
    # ...
}
```

### Weighting
Adjust `WEIGHTS` to change what matters most in keeper value:
```python
WEIGHTS = {
    "current_season": 0.40,  # win-now bias
    "longevity":      0.30,  # youth/future bias
    "scarcity":       0.20,  # positional value
    "durability":     0.10,  # injury history
}
```

### Projection Window
Change `PROJECTION_YEARS` (default: 4) and `DISCOUNT_RATE` (default: 0.18) to adjust how far ahead and how aggressively you discount future production.

## How the Aging Curves Work

The model uses the **delta method**: for every player-season pair, it calculates the year-over-year change in fantasy points, then averages those deltas by position and age. This produces a curve showing, at each age, whether players typically improve or decline.

Key findings you'll typically see:
- **RBs** peak 23-26, steep cliff after 27
- **WRs** peak 25-29, gradual decline
- **QBs** maintain production well into their 30s
- **TEs** late bloomers, peak 26-30

## Trade Calculator

The trade calculator (`trade_calculator.py`) solves the classic problem: **two average players don't equal one great player**. It does this through three mechanisms:

### 1. Elite Premium (Diminishing Returns)
Raw surplus over replacement level is raised to a power (default 1.5), so elite production separates exponentially from average production:

| Player | Weekly Avg | Surplus over Replacement | Trade Value |
|--------|-----------|------------------------|-------------|
| Stud RB (19 ppg) | 19.0 | 13.0 | 53.9 |
| Average RB (13.5 ppg) | 13.5 | 7.5 | 23.6 |
| Average WR (13.8 ppg) | 13.8 | 7.3 | 19.7 |
| **Combined avg players** | — | — | **43.3** |

The stud alone (53.9) is worth more than both average players combined (43.3).

### 2. Lineup Optimization
Instead of just comparing raw value, the calculator builds each team's **optimal starting lineup** before and after the trade:
- 1 QB, 2 RB, 2 WR, 1 TE, 1 FLEX (RB/WR/TE), K, DEF
- Shows exactly which starters change and the net weekly point swing
- A bench player you're trading away costs you nothing in lineup points

### 3. Keeper Impact
Every trade is evaluated for its long-term keeper implications:
- Does this trade improve or damage your top-8 keeper pool?
- Are you trading aging assets for younger upside?
- Three verdicts: overall, win-now, and dynasty

### Usage
```bash
# Interactive mode (after running sleeper_integration.py)
python trade_calculator.py

# Demo mode to see the math in action
python trade_calculator.py --demo

# Analyze roster needs
> needs
> Team name: YourName
```

### Configuration
At the top of `trade_calculator.py`:
```python
ELITE_EXPONENT = 1.5           # 1.0=linear, 2.0=aggressive star premium
KEEPER_WEIGHT_IN_TRADE = 0.45  # how much keeper value factors in (0=win-now, 1=dynasty)
REPLACEMENT_LEVEL = {          # waiver-wire baseline by position
    "QB": 14.0, "RB": 6.0, "WR": 6.5, "TE": 4.5, ...
}
```

### Trade Suggestions
The calculator can also scan two rosters and find **mutually beneficial trades** — deals where both teams improve their starting lineups:
```python
from trade_calculator import TradeCalculator
calc = TradeCalculator()
suggestions = calc.suggest_trades(my_roster, their_roster, max_pieces=2)
```

## File Structure

```
keeper_value/
├── keeper_value_model.py      # Core model — pulls data, builds curves, scores players
├── sleeper_integration.py     # Sleeper API — pulls your league, recommends keepers
├── trade_calculator.py        # Trade evaluator — surplus value, lineup optimization
├── README.md
└── output/
    ├── keeper_values.csv      # Full ranked player list
    ├── top_qb_keepers.csv     # Position-specific rankings
    ├── top_rb_keepers.csv
    ├── top_wr_keepers.csv
    ├── top_te_keepers.csv
    ├── aging_curves.json      # Raw aging curve data
    ├── keeper_report.txt      # Formatted report
    └── league_rosters.csv     # Your Sleeper league data
```
