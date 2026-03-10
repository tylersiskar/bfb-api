import { exec } from "../db.js";
import { computePlayerValues } from "../utils/calculations.js";
import { enrichWithKeeperValues } from "../utils/keeperValues.js";

export const getAllPlayers = async (req, res) => {
  try {
    const { position, mock } = req.query;
    let sqlQuery, bindParams;

    if (mock) {
      if (position) {
        sqlQuery = `SELECT * FROM vw_players WHERE year = $1 AND position = $2 and value > 0 ORDER BY value DESC`;
        bindParams = [req.params.year, position];
      } else {
        sqlQuery = `SELECT * FROM vw_players WHERE year = $1 and value > 0 ORDER BY value DESC`;
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
    const withValues = computePlayerValues(data);
    res.json(enrichWithKeeperValues(withValues));
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};

export const getPlayers = async (req, res) => {
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
    res.json(computePlayerValues(data));
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};

export const getPlayerById = async (req, res) => {
  try {
    const data = await exec(
      `SELECT * FROM vw_players WHERE id = $1 AND year = $2`,
      [req.params.id, req.query.year],
    );
    data.length ? res.json(data[0]) : res.json({});
  } catch (error) {
    console.error("Error fetching player:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};

export const searchPlayers = async (req, res) => {
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
    res.json(computePlayerValues(data));
  } catch (error) {
    console.error("Error searching:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};
