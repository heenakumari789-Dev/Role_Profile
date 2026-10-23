'use strict';
/**
 * Adds the LDP role-profile program flag and the self+leader assessment columns.
 *
 * Sevak/sanghrakshak members (active in tbl_leaders) get a role profile marked
 * program='ldp' and a two-stage assessment: the member self-rates, then their leader
 * (tbl_employee.leader_id) does the final rating. Nothing existing is dropped or
 * rewritten — new nullable columns only.
 *
 * Safe to run more than once.
 */
const db = require('../src/lib/db');

const say = (msg) => console.log('  ' + msg);

async function columnExists(table, column) {
  const row = await db.first(
    `SELECT COUNT(*) n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  return Number(row.n) > 0;
}

const COLUMNS = [
  ['rp_role_profiles', 'program',
    "ALTER TABLE rp_role_profiles ADD COLUMN program ENUM('psp','ldp') NOT NULL DEFAULT 'psp' AFTER sangh_name"],
  ['rp_assessments', 'self_submitted_at',
    'ALTER TABLE rp_assessments ADD COLUMN self_submitted_at DATETIME DEFAULT NULL AFTER version_id'],
  ['rp_assessments', 'self_total_score',
    'ALTER TABLE rp_assessments ADD COLUMN self_total_score DECIMAL(10,2) DEFAULT NULL AFTER self_submitted_at'],
  ['rp_assessments', 'self_percentage',
    'ALTER TABLE rp_assessments ADD COLUMN self_percentage DECIMAL(5,2) DEFAULT NULL AFTER self_total_score'],
  ['rp_assessments', 'final_submitted_at',
    'ALTER TABLE rp_assessments ADD COLUMN final_submitted_at DATETIME DEFAULT NULL AFTER self_percentage'],
  ['rp_assessment_ratings', 'self_rating',
    'ALTER TABLE rp_assessment_ratings ADD COLUMN self_rating DECIMAL(3,1) DEFAULT NULL AFTER version_detail_id'],
  ['rp_assessment_ratings', 'self_score',
    'ALTER TABLE rp_assessment_ratings ADD COLUMN self_score DECIMAL(10,2) DEFAULT NULL AFTER self_rating'],
];

async function main() {
  console.log(`Migrating ${(await db.first('SELECT DATABASE() d')).d}\n`);

  for (const [table, column, ddl] of COLUMNS) {
    if (await columnExists(table, column)) { say(`${table}.${column} — already there`); continue; }
    await db.run(ddl);
    say(`${table}.${column} — added`);
  }

  console.log('\nDone.');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { columnExists, COLUMNS, main };
