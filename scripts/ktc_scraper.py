import requests
from bs4 import BeautifulSoup
import time
import random
from psycopg2 import extras
import os
import sys

from db import connect_db

# Rotate user agents to reduce bot detection risk
USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
]

MAX_RETRIES = 3


def insert_records(conn, records):
    if not records:
        raise RuntimeError("No records to insert — scrape returned empty results")

    with conn:
        with conn.cursor() as cur:
            query = """
            INSERT INTO dynasty_rankings (name, value, last_updated)
            VALUES %s
            ON CONFLICT (name) DO UPDATE
            SET value = EXCLUDED.value, last_updated = NOW();
            """

            values = [(record['name'], record['value'], 'NOW()')
                      for record in records]

            # Remove duplicates based on 'name'
            unique_records = {}
            for record in values:
                name = record[0]
                unique_records[name] = record

            values = list(unique_records.values())

            print(f"Upserting {len(values)} players into dynasty_rankings...")
            extras.execute_values(cur, query, values)
            conn.commit()
            print("Upsert complete.")


def fetch_data(url):
    headers = {
        'User-Agent': random.choice(USER_AGENTS),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    }
    response = requests.get(url, headers=headers, timeout=30)

    if response.status_code != 200:
        raise RuntimeError(f"KTC returned HTTP {response.status_code} for {url}")

    if 'cf-browser-verification' in response.text or 'cloudflare' in response.text.lower():
        raise RuntimeError(f"KTC returned Cloudflare challenge page — likely bot-blocked")

    return response.text


def parse_page(html):
    soup = BeautifulSoup(html, 'html.parser')

    players = soup.find_all('div', class_='player-name')
    values = soup.find_all('div', class_='value')

    if not players and not values:
        # Check if the page structure changed
        print("WARNING: No 'player-name' or 'value' divs found — KTC may have changed their HTML structure")

    player_data = []
    for player, value in zip(players, values):
        a_tag = player.find('a')
        if a_tag:
            name = a_tag.text.strip()
            player_value = value.text.strip()
            player_data.append({'name': name, 'value': player_value})

    return player_data


def scrape_keep_trade_cut():
    base_url = 'https://keeptradecut.com/dynasty-rankings?filters=QB|WR|RB|TE&format=1'
    all_players = []

    for page in range(20):
        url = f"{base_url}&page={page}"
        print(f"Scraping page {page}...")

        # Retry logic for transient failures
        player_data = None
        for attempt in range(MAX_RETRIES):
            try:
                html = fetch_data(url)
                player_data = parse_page(html)
                break
            except RuntimeError as e:
                print(f"  Attempt {attempt + 1}/{MAX_RETRIES} failed: {e}")
                if attempt < MAX_RETRIES - 1:
                    wait = 5 * (attempt + 1)
                    print(f"  Retrying in {wait}s...")
                    time.sleep(wait)
                else:
                    raise RuntimeError(f"Failed to scrape page {page} after {MAX_RETRIES} attempts: {e}")

        if not player_data:
            print(f"  No players found on page {page} — stopping pagination")
            break

        # Duplicate detection (KTC sometimes renders last player from prev page as first)
        if all_players and player_data:
            if all_players[-1]['name'] == player_data[0]['name']:
                print(f"  Duplicate detected ({player_data[0]['name']}), skipping first entry")
                player_data = player_data[1:]

        print(f"  Found {len(player_data)} players")
        all_players.extend(player_data)
        # Randomize delay to look less bot-like
        time.sleep(random.uniform(1.0, 3.0))

    print(f"Total players scraped: {len(all_players)}")
    return all_players


if __name__ == "__main__":
    try:
        conn = connect_db()
        players = scrape_keep_trade_cut()
        insert_records(conn, players)
        conn.close()
        print("KTC scraper complete.")
    except Exception as e:
        print(f"KTC scraper FAILED: {e}", file=sys.stderr)
        sys.exit(1)
