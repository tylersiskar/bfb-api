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
