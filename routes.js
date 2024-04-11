import express from "express";
import { exec } from "./db.js";

const router = express.Router();

// Example route for fetching data
router.get("/players", async (req, res) => {
  try {
    const SQL = "SELECT * FROM nfl_players";
    const bindParams = [];
    const data = await exec(SQL, bindParams);
    res.json(data);
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).send("Internal Server Error");
  }
});

export default router;
