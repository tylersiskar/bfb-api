"""
Trade Calculator Bridge
========================
Thin bridge between Node.js API and the Python trade calculator.
Reads JSON from stdin, runs evaluation, writes JSON to stdout.

Usage (called by Node.js via child_process):
    echo '{"action": "evaluate", ...}' | python trade_bridge.py
"""

import sys
import json
import os

# Ensure we can import from the same directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from trade_calculator import TradeCalculator, REPLACEMENT_LEVEL, ELITE_EXPONENT


def evaluate_trade(data):
    """Evaluate a trade between two sides."""
    calc = TradeCalculator()

    team_a_roster = data["team_a_roster"]
    team_b_roster = data["team_b_roster"]
    a_gives = data["a_gives"]
    b_gives = data["b_gives"]
    team_a_name = data.get("team_a_name", "Side A")
    team_b_name = data.get("team_b_name", "Side B")

    result = calc.evaluate_trade(
        team_a_roster, team_b_roster,
        a_gives, b_gives,
        team_a_name, team_b_name,
    )

    return {
        "verdict": result.verdict,
        "win_now_verdict": result.win_now_verdict,
        "dynasty_verdict": result.dynasty_verdict,
        "side_a": {
            "giving_value": result.a_giving_value,
            "lineup_before": result.a_lineup_before,
            "lineup_after": result.a_lineup_after,
            "lineup_delta": result.a_lineup_delta,
            "keeper_before": result.a_keeper_before,
            "keeper_after": result.a_keeper_after,
            "keeper_delta": round(result.a_keeper_after - result.a_keeper_before, 3),
            "starters_after": [
                {
                    "player_name": s["player_name"],
                    "position": s.get("position", ""),
                    "slot": s.get("slot", ""),
                    "weekly_avg": s.get("weekly_avg", 0),
                }
                for s in result.a_starters_after
            ],
        },
        "side_b": {
            "giving_value": result.b_giving_value,
            "lineup_before": result.b_lineup_before,
            "lineup_after": result.b_lineup_after,
            "lineup_delta": result.b_lineup_delta,
            "keeper_before": result.b_keeper_before,
            "keeper_after": result.b_keeper_after,
            "keeper_delta": round(result.b_keeper_after - result.b_keeper_before, 3),
            "starters_after": [
                {
                    "player_name": s["player_name"],
                    "position": s.get("position", ""),
                    "slot": s.get("slot", ""),
                    "weekly_avg": s.get("weekly_avg", 0),
                }
                for s in result.b_starters_after
            ],
        },
    }


def get_player_value(data):
    """Get a single player's trade value profile."""
    calc = TradeCalculator()
    result = calc.get_player_value(data["player_name"], data.get("position"))
    return result


def analyze_needs(data):
    """Analyze a roster's positional needs."""
    calc = TradeCalculator()
    roster = data["roster"]
    needs = calc.analyze_roster_needs(roster, data.get("team_name", "Team"))
    return needs


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}), file=sys.stdout)
        sys.exit(1)

    action = data.get("action")

    # Suppress print statements from trade_calculator during API calls
    import io
    sys.stderr = io.StringIO()

    try:
        if action == "evaluate":
            result = evaluate_trade(data)
        elif action == "player_value":
            result = get_player_value(data)
        elif action == "needs":
            result = analyze_needs(data)
        else:
            result = {"error": f"Unknown action: {action}"}

        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
