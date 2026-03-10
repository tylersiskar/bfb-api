import { exec } from "../db.js";
import { spawn } from "child_process";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DB,
  password: process.env.PG_PASSWORD,
  port: 5432,
});

export const getStats = async (req, res) => {
  const { pos } = req.query;
  const baseSQL = `SELECT * FROM vw_stats WHERE year = $1 AND pts_half_ppr IS NOT NULL AND gms_active IS NOT NULL`;
  const sql = pos
    ? `${baseSQL} AND position = $2`
    : `${baseSQL} AND position IN ('QB', 'RB', 'WR', 'TE', 'DEF', 'K')`;
  const bindParams = pos ? [req.params.year, pos] : [req.params.year];
  try {
    const data = await exec(sql, bindParams);
    res.json(data);
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};

export const updatePlayerRankings = async (req, res) => {
  const year = req.params.year ?? "2025";
  console.log("Start Update Players Stats.");
  try {
    const statsResponse = await fetch(
      `https://api.sleeper.app/v1/stats/nfl/regular/${year}`,
    );
    const stats = await statsResponse.json();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM player_stats WHERE year = $1", [year]);
      for (const playerId in stats) {
        const player = stats[playerId];
        await client.query(
          "INSERT INTO player_stats (player_id, pos_rank_half_ppr, gms_active, pts_half_ppr, year) VALUES ($1, $2, $3, $4, $5)",
          [
            playerId,
            player.pos_rank_half_ppr,
            player.gp ?? player.gs ?? player.gms_active,
            player.pts_half_ppr,
            year,
          ],
        );
      }
      await client.query("COMMIT");
      console.log("Update Stats Complete.");

      const playersResponse = await fetch(
        "https://api.sleeper.app/v1/players/nfl",
      );
      const players = await playersResponse.json();
      await client.query("DELETE FROM nfl_players");
      for (const playerId in players) {
        const player = players[playerId];
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
          ],
        );
      }
      await client.query("COMMIT");
      console.log("Update Players Complete.");

      const pythonProcess = spawn("python", ["scripts/ktc_scraper.py"]);
      pythonProcess.stderr.on("data", (data) =>
        console.error(`stderr: ${data}`),
      );
      pythonProcess.on("close", (code) => {
        if (code === 0) {
          res.status(200).send("Player rankings updated successfully.");
        } else {
          res.status(500).send(`Python script exited with code ${code}`);
        }
      });
      pythonProcess.on("error", (err) => {
        console.error(`Failed to start subprocess: ${err}`);
        res.status(500).send(err);
      });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).send("Failed to update stats: " + err.message);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Failed to update NFL stats:", error);
    res.status(500).send("Error fetching stats");
  }
};

