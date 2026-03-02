import sharp from "sharp";
import { exec } from "../db.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";

const S3_THUMBNAIL_URL = `https://s3.amazonaws.com/badfranchisebuilders.com/thumbnails/{IMAGE}`;
const s3 = new S3Client({ region: "us-east-1" });

export const createMockInsert = async (req, res, next) => {
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
};

export const createMockUpload = async (req, res) => {
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

    try {
      console.log(
        "Sending GroupMe notification, mockId:",
        req.mockId,
        "botId:",
        process.env.GROUPME_BOT_ID,
      );

      // Upload thumbnail to GroupMe image service to get a hosted picture_url
      let pictureUrl;
      const imgUpload = await fetch("https://image.groupme.com/pictures", {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "X-Access-Token": process.env.GROUPME_ACCESS_TOKEN,
        },
        body: resizedImageBuffer,
      });
      if (imgUpload.ok) {
        const imgData = await imgUpload.json();
        pictureUrl = imgData.payload?.picture_url;
        console.log("GroupMe image uploaded:", pictureUrl);
      } else {
        console.error("GroupMe image upload failed:", imgUpload.status);
      }

      const gmRes = await fetch("https://api.groupme.com/v3/bots/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bot_id: process.env.GROUPME_BOT_ID,
          text: `A new mock draft has been created!\nbadfranchisebuilders.com/mocks/${req.mockId}`,
          ...(pictureUrl && { picture_url: pictureUrl }),
        }),
      });
      console.log("GroupMe response status:", gmRes.status);
    } catch (notifyErr) {
      console.error("GroupMe notification failed:", notifyErr);
    }

    res.json({
      message: "Success",
      url: S3_THUMBNAIL_URL.replace("{IMAGE}", req.filename),
    });
  } catch (err) {
    res.status(500).send({ error: err });
  }
};

export const getMocks = async (req, res) => {
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
};

export const getMockById = async (req, res) => {
  try {
    const data = await exec(
      `SELECT * FROM mocks WHERE id = $1 ORDER BY create_date DESC`,
      [req.params.id],
    );
    res.json(data);
  } catch (error) {
    console.error("Error fetching mock:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};
