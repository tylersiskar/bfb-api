import express from "express";
import cron from "node-cron";
import fetch from "node-fetch";
import pg from "pg";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
dotenv.config({ path: "./.env" });

import routes from "./routes.js";

const { Pool } = pg;

const app = express();
app.use(cors());
// Parse JSON bodies
app.use(bodyParser.json());
const port = 5000;

// PostgreSQL connection pool
const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "bfb",
  password: process.env.PG_PASSWORD,
  port: 5432,
});

app.use("/api", routes);
// Function to fetch NFL players and update the database
async function updatePlayerStats(year = "2023") {
  console.log("Start Update Players Stats.");
  try {
    const response = await fetch(
      `https://api.sleeper.app/v1/stats/nfl/regular/${year}`
    );
    const stats = await response.json();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM player_stats where year = $1", [year]);

      for (const playerId in stats) {
        const player = stats[playerId];
        await client.query(
          "INSERT INTO player_stats (player_id, pos_rank_half_ppr, gms_active, pts_half_ppr, year) VALUES ($1, $2, $3, $4, $5)",
          [
            playerId,
            player.pos_rank_half_ppr,
            player.gms_active,
            player.pts_half_ppr,
            year,
          ]
        );
      }
      console.log("Update Stats Complete.");
      // Commit transaction
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Failed to update NFL stats:", error);
  }
}
// Function to fetch NFL players and update the database
async function updateNflPlayers() {
  console.log("Start Update Players.");
  try {
    const response = await fetch("https://api.sleeper.app/v1/players/nfl");
    const players = await response.json();

    // Assuming players is an object where each key is a player ID
    const client = await pool.connect();
    try {
      // Begin transaction
      await client.query("BEGIN");

      // Optionally, clear the table before inserting new data
      await client.query("DELETE FROM nfl_players");

      for (const playerId in players) {
        const player = players[playerId];
        // Modify the query based on the structure of the players object
        // and your table structure
        await client.query(
          "INSERT INTO nfl_players (id, first_name, last_name, position, team, active, years_exp) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [
            playerId,
            player.first_name,
            player.last_name,
            player.position,
            player.team,
            player.active,
            player.years_exp,
          ]
        );
      }
      console.log("Update Complete.");
      // Commit transaction
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Failed to update NFL players:", error);
  }
}

// Schedule the task to run every day at midnight
cron.schedule("0 0 * * *", () => {
  console.log("Running a task at midnight every day");
  updateNflPlayers();
  updatePlayerStats();
});

app.get("/", (req, res) => {
  res.send("BFB APP API! Go to /players to view nfl player endpoint.");
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
