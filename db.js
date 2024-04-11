import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "bfb",
  password: "testing123",
  port: 5432,
});

/**
 * @param {string} SQL The SQL query string.
 * @param {Array} bindParams Parameters to bind to the query.
 * @returns {Promise} A promise that resolves with the query result.
 */
const exec = async (SQL, bindParams) => {
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

export default exec;
