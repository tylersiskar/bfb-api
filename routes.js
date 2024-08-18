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
  try {
    const data = await exec(
      `select * from vw_stats where year = $1 and pts_half_ppr is not null and gms_active is not null and position in ('QB', 'RB', 'WR', 'TE', 'DEF', 'K')`,
      [req.params.year]
    );
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
  // const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetId = "1LVIwS0t--qsD-0tZbC2LSXFbf1NstSasmesChmJbn9w";
  const googleSheetClient = await _getGoogleSheetClient();
  const { activeRoster, draftedPlayers } = req.body;
  const values = [
    ...activeRoster.map((obj) => [`${obj.first_name} ${obj.last_name}`]),
    [""],
  ];
  const rosterRange = "A:A";
  /**
  const drafted = [
    ...req.body.draftedPlayers.map(
      (obj) => `${obj.first_name} ${obj.last_name}`
    ),
    "",
  ];
  const draftedRange = `C:C`;
  let combiened = [...values, ...drafted].map((_, i) => [
    values[i],
    "",
    drafted[i],
  ]);

  console.log(combiened);
  const startRow = 1; // Assuming you want to start writing from the first row
  const endRow = startRow + combiened.length - 1;
  const range = `A${startRow}:C${endRow}`;
   */
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
