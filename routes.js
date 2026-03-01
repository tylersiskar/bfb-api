import express from "express";
import sharp from "sharp";
import { exec } from "./db.js";
import {
  _getGoogleSheetClient,
  _readGoogleSheet,
  _writeGoogleSheet,
} from "./google-sheets.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import { spawn } from "child_process";
import pg from "pg";

const { Pool } = pg;

const S3_THUMBNAIL_URL = `https://s3.amazonaws.com/badfranchisebuilders.com/thumbnails/{IMAGE}`;
const GOOGLE_SHEET_ID = "1LVIwS0t--qsD-0tZbC2LSXFbf1NstSasmesChmJbn9w";

const s3 = new S3Client({ region: "us-east-1" });

const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DB,
  password: process.env.PG_PASSWORD,
  port: 5432,
});

const router = express.Router();

const calculateBfbValue = (data) => {
  // Position-specific keeper model settings – tweak freely
  const POSITION_CONFIG = {
    QB: { weightPpg: 0.7, weightValue: 0.3, cutoff: 0.9 },
    RB: { weightPpg: 0.45, weightValue: 0.55, cutoff: 0.8 },
    WR: { weightPpg: 0.55, weightValue: 0.45, cutoff: 0.85 },
    TE: { weightPpg: 0.7, weightValue: 0.3, cutoff: 0.9 },
  };

  return data.map((player) => {
    const config = POSITION_CONFIG[player.position];
    if (!config) return { ...player, bfbValue: null };

    const { cutoff, weightValue, weightPpg } = config;
    const { value_percentile, ppg_percentile, gms_active } = player;

    // No games played — rank purely by dynasty value
    if (!gms_active) {
      return { ...player, bfbValue: Math.round(value_percentile * 1000) };
    }

    const lineYValue = (cutoff - weightValue * value_percentile) / weightPpg;
    const lineXValue = (cutoff - weightPpg * ppg_percentile) / weightValue;

    const deltaY = ppg_percentile - lineYValue;
    const deltaX = value_percentile - lineXValue;
    let bfbValue = Math.sqrt(
      Math.pow(deltaY, 2) -
        Math.pow(deltaY, 4) / (Math.pow(deltaX, 2) + Math.pow(deltaY, 2)),
    );
    if (deltaX < 0 && deltaY < 0) bfbValue *= -1;

    return { ...player, bfbValue: Math.round(bfbValue * 1000) };
  });
};

router.get("/playersAll/:year", async (req, res) => {
  try {
    const { position, mock } = req.query;
    let sqlQuery;
    let bindParams;

    if (mock) {
      if (position) {
        sqlQuery = `SELECT * FROM vw_players WHERE year = $1 AND position = $2 ORDER BY value DESC`;
        bindParams = [req.params.year, position];
      } else {
        sqlQuery = `SELECT * FROM vw_players WHERE year = $1 ORDER BY value DESC`;
        bindParams = [req.params.year];
      }
    } else {
      sqlQuery = `SELECT * FROM vw_players WHERE year = $1 AND ppg > 0`;
      bindParams = [req.params.year];
      if (position) {
        sqlQuery = `SELECT * FROM vw_players WHERE year = $1 AND ppg_percentile > $2 AND value_percentile > $3 AND position = $4`;
        bindParams = [req.params.year, 0.55, 0.55, position];
      }
    }

    const data = await exec(sqlQuery, bindParams);
    res.json(calculateBfbValue(data));
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.get("/players", async (req, res) => {
  try {
    const { page = 1, pageSize = 50, position, rookies, id, year } = req.query;
    const offset = (page - 1) * pageSize;

    if (id) {
      const data = await exec(
        `SELECT * FROM vw_players WHERE id = ANY($1::text[]) AND year = $2 ORDER BY position ASC`,
        [JSON.parse(id), year],
      );
      return res.json(data);
    }

    const conditions = [`year = $1`];
    const filterParams = [year];

    if (position) {
      filterParams.push(position);
      conditions.push(`position = $${filterParams.length}`);
      if (rookies === "true") conditions.push(`years_exp = 0`);
    } else {
      if (rookies === "true") conditions.push(`years_exp = 0`);
      conditions.push(`position NOT IN ('K', 'DEF')`);
    }

    const offsetIdx = filterParams.length + 1;
    const limitIdx = filterParams.length + 2;
    const SQL = `SELECT * FROM vw_players WHERE ${conditions.join(" AND ")} ORDER BY value DESC, pos_rank_half_ppr ASC, ppg DESC OFFSET $${offsetIdx} LIMIT $${limitIdx}`;
    const data = await exec(SQL, [...filterParams, offset, pageSize]);
    res.json(data);
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.get("/players/:id", async (req, res) => {
  try {
    const data = await exec(
      `SELECT * FROM vw_players WHERE id = $1 AND year = $2`,
      [req.params.id, req.query.year],
    );
    data.length ? res.json(data[0]) : res.json({});
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

// player search (eventually be player / team / user search)
router.get("/search", async (req, res) => {
  const { name, year = 2025 } = req.query;
  if (!name) return res.json([]);

  try {
    const data = await exec(
      `SELECT * FROM vw_players
       WHERE full_name ILIKE '%' || $1 || '%' AND year::integer = $2
       ORDER BY value DESC, similarity(full_name, $1) DESC
       LIMIT 5`,
      [name, year],
    );
    res.json(data);
  } catch (error) {
    console.error("Error searching:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.post("/updatePlayerRankings/:year", async (req, res) => {
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

      const playersResponse = await fetch("https://api.sleeper.app/v1/players/nfl");
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

      const pythonProcess = spawn("python", ["ktc_scraper.py"]);

      pythonProcess.stderr.on("data", (data) => {
        console.error(`stderr: ${data}`);
      });

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
});

// mock routes

router.post(
  "/league/:leagueId/mocks",
  async (req, res, next) => {
    try {
      const image = `${uuidv4()}.png`;
      const data = await exec(
        `INSERT INTO mocks (picks, name, league_id, thumbnail) VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.body.picks, req.body.name, req.params.leagueId, image],
      );
      req.mockId = data[0].id;
      req.filename = image;
      next();
    } catch (error) {
      console.error("Error posting mocks:", error);
      res.status(500).send({ error, message: "Internal Server Error" });
    }
  },
  async (req, res) => {
    const buffer = Buffer.from(
      req.body.image.replace(/^data:image\/\w+;base64,/, ""),
      "base64",
    );

    try {
      const resizedImageBuffer = await sharp(buffer).resize(368, 204).toBuffer();
      const command = new PutObjectCommand({
        Bucket: "badfranchisebuilders.com",
        Key: `thumbnails/${req.filename}`,
        Body: resizedImageBuffer,
        ContentType: "image/png",
      });
      await s3.send(command);
      res.json({ message: "Success", url: S3_THUMBNAIL_URL.replace("{IMAGE}", req.filename) });
    } catch (err) {
      res.status(500).send({ error: err });
    }
  },
);

router.get("/league/:leagueId/mocks", async (req, res) => {
  try {
    const data = await exec(
      `SELECT * FROM mocks WHERE league_id = $1 ORDER BY create_date DESC`,
      [req.params.leagueId],
    );
    res.json(data);
  } catch (error) {
    console.error("Error fetching mocks:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.get("/league/:leagueId/mocks/:id", async (req, res) => {
  try {
    const data = await exec(
      `SELECT * FROM mocks WHERE id = $1 ORDER BY create_date DESC`,
      [req.params.id],
    );
    res.json(data);
  } catch (error) {
    console.error("Error fetching mocks:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.get("/stats/:year", async (req, res) => {
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
});

router.get("/redraft", async (req, res) => {
  try {
    const googleSheetClient = await _getGoogleSheetClient();
    const data = await _readGoogleSheet(googleSheetClient, GOOGLE_SHEET_ID, "Redraft", "A:I");
    res.json(data);
  } catch (error) {
    console.error("Error fetching redraft:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.get("/dynasty", async (req, res) => {
  try {
    const googleSheetClient = await _getGoogleSheetClient();
    const data = await _readGoogleSheet(googleSheetClient, GOOGLE_SHEET_ID, "Dynasty", "A:I");
    res.json(data);
  } catch (error) {
    console.error("Error fetching dynasty:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.post("/calculate", async (req, res) => {
  try {
    const googleSheetClient = await _getGoogleSheetClient();
    const { activeRoster, draftedPlayers } = req.body;
    const values = [
      ...activeRoster.map((obj) => [`${obj.first_name} ${obj.last_name}`]),
      [""],
    ];

    await _writeGoogleSheet(googleSheetClient, GOOGLE_SHEET_ID, "BFB", "A:A", values);

    setTimeout(async () => {
      const csvData = await _readGoogleSheet(
        googleSheetClient,
        GOOGLE_SHEET_ID,
        "BFB Draft Board",
        "A:E",
      );

      const headers = csvData[1];
      const result = csvData.slice(2).map((row) =>
        Object.fromEntries(headers.map((h, i) => [h, row[i]])),
      );

      const draftedNames = new Set(
        draftedPlayers.map((p) => `${p.first_name} ${p.last_name}`),
      );
      const finalResult = result.filter((player) => {
        const baseName = player["PLAYER NAME"].replace(/ (Jr\.|Sr\.|II|III)$/, "");
        return !draftedNames.has(baseName);
      });

      res.json(finalResult);
    }, 3000);
  } catch (error) {
    res.status(500).send(error.toString());
  }
});

export default router;
