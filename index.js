import express from "express";
import cron from "node-cron";
import fetch from "node-fetch";
import pg from "pg";
import cors from "cors";
import routes from "./routes.js";

const { Pool } = pg;

const app = express();
app.use(cors());
const port = 5000;

// PostgreSQL connection pool
const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "bfb",
  password: "testing123",
  port: 5432,
});

app.use("/api", routes);

// Function to fetch NFL players and update the database
async function updateNflPlayers() {
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
          "INSERT INTO nfl_players (player_id, player_name) VALUES ($1, $2, $3, $4, $5)",
          [
            playerId,
            player.first_name,
            player.last_name,
            player.position,
            player.team,
          ]
        );
      }

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
  updateNflPlayers(); // Your function call
});

app.get("/", (req, res) => {
  res.send("Hello, World!");
});

app.post("/players", async (req, res) => {
  await updateNflPlayers();
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
