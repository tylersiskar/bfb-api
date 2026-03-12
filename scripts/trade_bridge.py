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

from trade_calculator import TradeCalculator, REPLACEMENT_LEVEL


def evaluate_trade(data):
    """Evaluate a trade between two sides."""
    calc = TradeCalculator()

    result = calc.evaluate_trade(
        team_a_roster=data["team_a_roster"],
        team_b_roster=data["team_b_roster"],
        a_gives=data["a_gives"],
        b_gives=data["b_gives"],
        team_a_name=data.get("team_a_name", "Side A"),
        team_b_name=data.get("team_b_name", "Side B"),
        a_picks=data.get("a_picks", []),
        b_picks=data.get("b_picks", []),
    )

    return result.to_dict()


def get_player_value(data):
    """Get a single player's trade value profile."""
    calc = TradeCalculator()
    result = calc.get_player_value(
        data["player_name"],
        data.get("position"),
        bfb_value=data.get("bfb_value"),
    )
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
