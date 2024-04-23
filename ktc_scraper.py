import requests
from bs4 import BeautifulSoup
import time

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
            name = a_tag.text.strip()# Fallback if no <a> tag is present
            player_value = value.text.strip()
            player_data.append({'name': name, 'value': player_value})

    return player_data

def scrape_keep_trade_cut():
    base_url = 'https://keeptradecut.com/dynasty-rankings?filters=QB|WR|RB|TE&format=1'
    page = 0
    all_players = []
    print(all_players, 'all')
    for x in range(20):
        print(f"Scraping page: {page}")
        url = f"{base_url}&page={page}"
        html = fetch_data(url)
        player_data = parse_page(html)
        if not player_data:
            break  # Break the loop if no data is found

        all_players.extend(player_data)
        page += 1
        time.sleep(.25)  # Sleep to be polite to the server

    return all_players

# Run the scraper and print the results
players = scrape_keep_trade_cut()
print(players)
