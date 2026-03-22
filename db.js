import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const { Pool } = pg;

const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DB,
  password: process.env.PG_PASSWORD,
  port: 5432,
});

/**
 * @param {string} SQL The SQL query string.
 * @param {Array} bindParams Parameters to bind to the query.
 * @returns {Promise} A promise that resolves with the query result.
 */
export const exec = async (SQL, bindParams) => {
  const client = await pool.connect();
  try {
    const result = await client.query(SQL, bindParams);
    return result.rows;
  } catch (error) {
    console.error("Database execution error:", error);
    throw error;
  } finally {
    client.release();
  }
};

export const getClient = async () => pool.connect();

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];

export const getRostersWithOwners = async (leagueId) => {
  return exec(
    `SELECT r.*, u.display_name, u.avatar
     FROM rosters r
     LEFT JOIN league_users u ON u.user_id = r.owner_id AND u.league_id = r.league_id
     WHERE r.league_id = $1
     ORDER BY r.wins DESC, r.points_for DESC`,
    [leagueId],
  );
};

export const getPlayersByIds = async (ids, year, { positions = null } = {}) => {
  if (!ids.length) return [];
  if (positions) {
    return exec(
      `SELECT * FROM vw_players WHERE id = ANY($1::text[]) AND year = $2 AND position = ANY($3::text[])`,
      [ids, year, positions],
    );
  }
  return exec(
    `SELECT * FROM vw_players WHERE id = ANY($1::text[]) AND year = $2`,
    [ids, year],
  );
};

export const getSkillPlayersByIds = async (ids, year) => {
  return getPlayersByIds(ids, year, { positions: SKILL_POSITIONS });
};

export const getDraftPicksByLeague = async (leagueId) => {
  return exec(
    `SELECT * FROM draft_picks WHERE league_id = $1 ORDER BY season, round, original_roster_id`,
    [leagueId],
  );
};
