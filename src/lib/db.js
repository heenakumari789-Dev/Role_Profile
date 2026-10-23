'use strict';
const mysql = require('mysql2/promise');
const config = require('../config');

const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  // The PHP app relaxed ONLY_FULL_GROUP_BY per request; do it once per connection here.
  timezone: 'local',
  dateStrings: true,
});

pool.on('connection', (conn) => {
  conn.query(
    "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE," +
      "ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION'"
  );
});

/** Rows for a SELECT. */
async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** First row, or null. */
async function first(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** Result header for INSERT/UPDATE/DELETE (insertId, affectedRows). */
async function run(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result;
}

async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, first, run, transaction };
