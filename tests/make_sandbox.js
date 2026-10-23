'use strict';
/**
 * Build an isolated copy of the schema so write tests never touch live records.
 * Structure and rows are copied from the real database; nothing there is modified.
 */
const mysql = require('mysql2/promise');
const config = require('../src/config');

const SRC = config.db.database;
const DST = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';
const TABLES = [
  'tbl_employee', 'tbl_financial_year', 'tbl_leaders', 'designations',
  'rp_role_profiles', 'rp_role_key_outcomes', 'rp_role_profile_details',
  'rp_role_profile_members', 'rp_role_profile_history', 'rp_notifications',
  'rp_assessments', 'rp_assessment_ratings',
];

(async () => {
  const conn = await mysql.createConnection({ ...config.db, database: undefined, multipleStatements: false });
  // Legacy rows hold '0000-00-00' dates; copy them across as they are.
  await conn.query("SET SESSION sql_mode = 'ALLOW_INVALID_DATES'");
  await conn.query(`DROP DATABASE IF EXISTS \`${DST}\``);
  await conn.query(`CREATE DATABASE \`${DST}\``);

  for (const t of TABLES) {
    const [[{ 'Create Table': ddl }]] = await conn.query(`SHOW CREATE TABLE \`${SRC}\`.\`${t}\``);
    await conn.query(ddl.replace(/^CREATE TABLE `/, `CREATE TABLE \`${DST}\`.\``));
    await conn.query(`INSERT INTO \`${DST}\`.\`${t}\` SELECT * FROM \`${SRC}\`.\`${t}\``);
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) n FROM \`${DST}\`.\`${t}\``);
    console.log(`${t.padEnd(26)} ${n} rows`);
  }
  await conn.end();
  console.log(`\nSandbox ready: ${DST}`);
  process.exit(0);
})();
