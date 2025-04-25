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

let URL = `https://s3.amazonaws.com/badfranchisebuilders.com/thumbnails/{IMAGE}`;
// Configure AWS SDK
const s3 = new S3Client({
  region: "us-east-1", // Ensure this matches your S3 bucket's region
});

const router = express.Router();

router.get("/playersAll/:year", async (req, res, next) => {
  try {
    const data = await exec(`SELECT * FROM vw_players where year = $1`, [
      req.params.year,
    ]);
    res.json(data);
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});
router.get("/players", async (req, res) => {
  try {
    const { page = 1, pageSize = 50, position, rookies, id, year } = req.query;
    const offset = (page - 1) * pageSize;
    let WHERE;
    let SQL = "";
    if (id) {
      SQL = `select * from vw_players where id = ANY($1::text[]) and year = '${year}' order by position asc`;
      const bindParams = [JSON.parse(id)];
      const data = await exec(SQL, bindParams);
      res.json(data);
    } else {
      if (position) {
        if (Boolean(rookies)) {
          WHERE = `WHERE position = '${position}' AND years_exp = 0`;
        } else WHERE = `WHERE position = '${position}'`;
      } else if (rookies)
        WHERE = `WHERE years_exp = 0 AND position not in ('K', 'DEF')`;
      else WHERE = "WHERE position not in ('K', 'DEF')";

      SQL = `SELECT * FROM vw_players ${WHERE} and year = '${year}' ORDER BY value desc, pos_rank_half_ppr asc, ppg desc OFFSET $1 LIMIT $2`;
      const bindParams = [offset, pageSize];
      const data = await exec(SQL, bindParams);
      res.json(data);
    }
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.get("/players/:id", async (req, res) => {
  try {
    const data = await exec(
      `select * from vw_players where id = $1 and year = $2`,
      [req.params.id, req.query.year]
    );
    data.length ? res.json(data[0]) : res.json({});
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

// player search (eventually be player / team / user search )
router.get("/search", async (req, res) => {
  const { name, year = 2025 } = req.query;
  if (name) {
    let sql = `SELECT *
      FROM vw_players
      WHERE full_name ILIKE '%${name}%' and year::integer = $2
      ORDER BY value desc, similarity(full_name, $1) DESC
      LIMIT 5;
      `;
    try {
      const data = await exec(sql, [name, year]);
      res.json(data);
    } catch (error) {
      console.error("Error searching:", error);
      res.status(500).send({ error, message: "Internal Server Error" });
    }
  } else {
    res.json([]);
  }
});

//update player rankings
router.post("/updatePlayerRankings/:year", async (req, res) => {
  console.log("Start Update Players Stats.");
  let year = req.params.year ?? "2024";
  try {
    const response = await fetch(
      `https://api.sleeper.app/v1/stats/nfl/regular/${year}`
    );
    const pool = new Pool({
      user: process.env.PG_USER,
      host: process.env.PG_HOST,
      database: process.env.PG_DB,
      password: process.env.PG_PASSWORD,
      port: 5432,
    });
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
            player.gs,
            player.pts_half_ppr,
            year,
          ]
        );
      }

      console.log("Update Stats Complete.");
      // Commit transaction
      await client.query("COMMIT");

      // Start updating nfl players
      const response = await fetch("https://api.sleeper.app/v1/players/nfl");
      const players = await response.json();
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
      console.log("Update Players Complete.");
      await client.query("COMMIT");

      // Start the next function (the python process)
      const pythonProcess = spawn("python", ["ktc_scraper.py"]);

      pythonProcess.stdout.on("data", (data) => {
        console.log(`stdout: ${data}`);
      });

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
      let image_id = uuidv4();
      let image = `${image_id}.png`;
      let SQL = `INSERT INTO mocks (picks, name, league_id, thumbnail) VALUES ($1, $2, $3, $4) returning id`;
      const bindParams = [
        req.body.picks,
        req.body.name,
        req.params.leagueId,
        image,
      ];
      const data = await exec(SQL, bindParams);
      // res.status(200).send({ message: "Success", data });
      req.mockId = data[0].id;
      req.filename = image;
      next();
    } catch (error) {
      console.error("Error posting mocks:", error);
      res.status(500).send({ error, message: "Internal Server Error" });
    }
  },
  async (req, res, next) => {
    let image = req.body.image; // uploaded image

    const buffer = Buffer.from(
      image.replace(/^data:image\/\w+;base64,/, ""),
      "base64"
    );

    // Resize the image using Sharp
    const resizedImageBuffer = await sharp(buffer).resize(368, 204).toBuffer();

    // Generate a unique file name for the thumbnail
    const fileName = `thumbnails/${req.filename}`;

    // Prepare the S3 upload parameters
    const uploadParams = {
      Bucket: "badfranchisebuilders.com", // Replace with your S3 bucket name
      Key: fileName,
      Body: resizedImageBuffer,
      ContentType: "image/png",
    };

    try {
      // Upload the image to S3
      const command = new PutObjectCommand(uploadParams);
      await s3.send(command);
      let imageUrl = URL.replace("{IMAGE}", req.filename);
      res.status(200).send({ message: "Success", url: imageUrl });
    } catch (err) {
      res.status(500).send({ error: err });
    }
  }
);

router.get("/league/:leagueId/mocks", async (req, res) => {
  try {
    const data = await exec(
      `SELECT * FROM mocks where league_id = $1 order by create_date desc`,
      [req.params.leagueId]
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
      `SELECT * FROM mocks WHERE id = $1 order by create_date desc`,
      [req.params.id]
    );
    res.json(data);
  } catch (error) {
    console.error("Error fetching mocks:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.get("/stats/:year", async (req, res) => {
  let queryParams = req.query;
  let sql = `select * from vw_stats where year = $1 and pts_half_ppr is not null and gms_active is not null and position in ('QB', 'RB', 'WR', 'TE', 'DEF', 'K')`;
  let bindParams = [req.params.year];
  if (queryParams && queryParams.pos) {
    sql = `select * from vw_stats where year = $1 and pts_half_ppr is not null and gms_active is not null and position = $2`;
    bindParams = [req.params.year, req.query.pos];
  }
  try {
    const data = await exec(sql, bindParams);
    res.json(data);
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.get("/redraft", async (req, res) => {
  // const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetId = "1LVIwS0t--qsD-0tZbC2LSXFbf1NstSasmesChmJbn9w";
  const tabName = "Redraft";
  const range = "A:I";
  const googleSheetClient = await _getGoogleSheetClient();

  const data = await _readGoogleSheet(
    googleSheetClient,
    sheetId,
    tabName,
    range
  );
  res.json(data);
});
router.get("/dynasty", async (req, res) => {
  // const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetId = "1LVIwS0t--qsD-0tZbC2LSXFbf1NstSasmesChmJbn9w";
  const tabName = "Dynasty";
  const range = "A:I";
  const googleSheetClient = await _getGoogleSheetClient();

  const data = await _readGoogleSheet(
    googleSheetClient,
    sheetId,
    tabName,
    range
  );
  res.json(data);
});

router.post("/calculate", async (req, res) => {
  const sheetId = "1LVIwS0t--qsD-0tZbC2LSXFbf1NstSasmesChmJbn9w";
  const googleSheetClient = await _getGoogleSheetClient();
  const { activeRoster, draftedPlayers } = req.body;
  const values = [
    ...activeRoster.map((obj) => [`${obj.first_name} ${obj.last_name}`]),
    [""],
  ];
  const rosterRange = "A:A";
  try {
    await _writeGoogleSheet(
      googleSheetClient,
      sheetId,
      "BFB",
      rosterRange,
      values
    );

    setTimeout(async () => {
      const csvData = await _readGoogleSheet(
        googleSheetClient,
        sheetId,
        "BFB Draft Board",
        "A:E"
      );

      const headers = csvData[1];
      const result = csvData.slice(2).map((row) => {
        const obj = {};
        for (let i = 0; i < headers.length; i++) {
          obj[headers[i]] = row[i];
        }
        return obj;
      });

      let draftedNames = draftedPlayers.map(
        (p) => `${p.first_name} ${p.last_name}`
      );
      let finalResult = result.filter((player) => {
        let playerName = player["PLAYER NAME"].includes(" Jr.")
          ? player["PLAYER NAME"].split(" Jr.")[0]
          : player["PLAYER NAME"].includes(" Sr.")
          ? player["PLAYER NAME"].split(" Sr.")[0]
          : player["PLAYER NAME"].includes(" II")
          ? player["PLAYER NAME"].split(" II")[0]
          : player["PLAYER NAME"].includes(" III")
          ? player["PLAYER NAME"].split(" III")[0]
          : player["PLAYER NAME"];
        return !draftedNames.includes(playerName);
      });
      res.json(finalResult);
    }, 3000);
  } catch (error) {
    res.status(500).send(error.toString());
  }
});

export default router;
