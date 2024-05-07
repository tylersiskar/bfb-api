import requests
from bs4 import BeautifulSoup
import time
import psycopg2
from psycopg2 import extras
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Database connection parameters
dbname = os.getenv("PG_DB")
user = os.getenv("PG_USER")
password = os.getenv("PG_PASSWORD")
host = os.getenv("PG_HOST")
print(dbname, user, password, host)
# Connect to your postgres DB
conn = psycopg2.connect(dbname=dbname, user=user, password=password, host=host)

# A function to delete all records and insert new ones


def insert_records(records):
    # print(records)
    with conn:
        with conn.cursor() as cur:
            # Delete all records first

            query = """
            INSERT INTO dynasty_rankings (name, value)
            VALUES %s
            ON CONFLICT (name) DO UPDATE
            SET value = EXCLUDED.value;
            """
            # A list of tuples from the list of dictionaries
            values = [(record['name'], record['value']) for record in records]
            print("Execute Upsert.")
            # Use execute_values() to perform the UPSERT
            extras.execute_values(cur, query, values)

            # Commit the transaction
            conn.commit()


def fetch_data(url):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
    }
    response = requests.get(url, headers=headers)
    return response.text


def parse_page(html):
    soup = BeautifulSoup(html, 'html.parser')

    # Find all div elements with the class 'player-name'
    players = soup.find_all('div', class_='player-name')
    # Find all div elements with the class 'value'
    values = soup.find_all('div', class_='value')

    player_data = []
    for player, value in zip(players, values):
        # Find the <a> tag inside the player div and get its text
        a_tag = player.find('a')
        if a_tag:  # Check if the <a> tag exists
            name = a_tag.text.strip()  # Fallback if no <a> tag is present
            player_value = value.text.strip()
            player_data.append({'name': name, 'value': player_value})

    return player_data


def scrape_keep_trade_cut():
    base_url = 'https://keeptradecut.com/dynasty-rankings?filters=QB|WR|RB|TE&format=1'
    page = 0
    all_players = []
    for x in range(20):
        print(f"Scraping page: {page}")
        url = f"{base_url}&page={page}"
        html = fetch_data(url)
        player_data = parse_page(html)
        if not player_data:
            break  # Break the loop if no data is found
        print(player_data)
        print(page)
        if all_players and player_data:  # Check if both arrays are non-empty
            # sometimes KTC on initial load doesnt load properly, and renders the last player from previous page as the first, causing duplicates
            if all_players[-1]['name'] == player_data[0]['name']:
                print('Restarting... issue when scraping')
                scrape_keep_trade_cut()
                break
        all_players.extend(player_data)
        page += 1
        time.sleep(.5)  # Sleep to be polite to the server

    return all_players


# Run the scraper and print the results
players = scrape_keep_trade_cut()
insert_records(players)
