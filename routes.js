import express from "express";
import { exec } from "./db.js";

const router = express.Router();

router.get("/playersAll", async (req, res, next) => {
  try {
    const data = await exec(`SELECT * FROM VW_PLAYERS`, []);
    res.json(data);
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});
router.get("/players", async (req, res) => {
  try {
    const { page = 1, pageSize = 50, position, rookies, id } = req.query;
    const offset = (page - 1) * pageSize;
    let WHERE;
    let SQL = "";
    if (id) {
      SQL = `select * from vw_players where id = ANY($1::text[]) order by position asc`;
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

      SQL = `SELECT * FROM vw_players ${WHERE} ORDER BY value desc, pos_rank_half_ppr asc, ppg desc OFFSET $1 LIMIT $2`;
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

router.post("/mocks", async (req, res, next) => {
  try {
    let SQL = `INSERT INTO mocks (picks, name) VALUES ($1, $2)`;
    const bindParams = [req.body.picks, req.body.name];
    const data = await exec(SQL, bindParams);
    res.status(200).send({ message: "Success", data });
  } catch (error) {
    console.error("Error posting mocks:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.get("/mocks", async (req, res) => {
  try {
    const data = await exec(
      `SELECT * FROM mocks order by create_date desc`,
      []
    );
    res.json(data);
  } catch (error) {
    console.error("Error fetching mocks:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
});

router.get("/mocks/:id", async (req, res) => {
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
export default router;
