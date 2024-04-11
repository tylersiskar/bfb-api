import express from "express";
import { exec } from "./db.js";

const router = express.Router();
router.get("/players", async (req, res) => {
  try {
    const { page = 1, pageSize = 50, position, rookies } = req.query;
    const offset = (page - 1) * pageSize;
    let WHERE;
    if (position) {
      if (rookies) {
        WHERE = `WHERE position = ${position} AND years_exp = 0`;
      } else WHERE = `WHERE position = ${position}`;
    } else if (rookies) WHERE = `WHERE years_exp = 0`;
    else WHERE = "";

    let SQL = `SELECT * FROM vw_players ${WHERE} ORDER BY pos_rank_half_ppr asc, ppg desc OFFSET $1 LIMIT $2`;
    const bindParams = [offset, pageSize];
    console.log(SQL);
    const data = await exec(SQL, bindParams);
    res.json(data);
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).send("Internal Server Error");
  }
});

export default router;
