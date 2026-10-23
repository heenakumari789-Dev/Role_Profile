'use strict';
const db = require('./db');

/**
 * What the app needs the database to look like. Checked at boot so a database that has not
 * had the scripts in `scripts/` run against it says so plainly, rather than working
 * until the first save and then failing on a constraint.
 */
const TABLES = [
  'rp_role_profiles', 'rp_role_key_outcomes', 'rp_role_profile_details',
  'rp_role_profile_members', 'rp_role_profile_history', 'rp_notifications',
  'rp_assessments', 'rp_assessment_ratings',
  'rp_profile_versions', 'rp_version_outcomes', 'rp_version_details', 'rp_profile_reviews',
  'rp_designations',
];

const COLUMNS = [
  ['rp_assessments', 'version_id'],
  ['rp_assessment_ratings', 'version_detail_id'],
  ['rp_role_profiles', 'program'],
  ['rp_assessments', 'self_submitted_at'],
  ['rp_assessments', 'self_total_score'],
  ['rp_assessments', 'self_percentage'],
  ['rp_assessments', 'final_submitted_at'],
  ['rp_assessment_ratings', 'self_rating'],
  ['rp_assessment_ratings', 'self_score'],
  ['rp_role_profiles', 'rp_approver_action_by'],
  ['rp_role_profiles', 'rp_approver_action_at'],
  ['rp_profile_versions', 'rp_approver_code'],
  ['rp_profile_versions', 'rp_approver_name'],
  ['rp_profile_versions', 'rp_approver_action_by'],
  ['rp_profile_versions', 'rp_approver_action_at'],
];

// Columns that must accept NULL, because a versioned row leaves them empty.
const NULLABLE = [
  ['rp_assessment_ratings', 'role_profile_detail_id'],
];

async function check() {
  const problems = [];

  const present = new Set((await db.query(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()`
  )).map((r) => r.t || r.TABLE_NAME));
  for (const table of TABLES) {
    if (!present.has(table)) problems.push(`table ${table} is missing`);
  }

  const cols = await db.query(
    `SELECT table_name AS t, column_name AS c, is_nullable AS n
     FROM information_schema.columns WHERE table_schema = DATABASE()`);
  const byKey = new Map(cols.map((r) => [`${r.t || r.TABLE_NAME}.${r.c || r.COLUMN_NAME}`,
    (r.n || r.IS_NULLABLE)]));

  for (const [table, column] of COLUMNS) {
    if (!present.has(table)) continue;
    if (!byKey.has(`${table}.${column}`)) problems.push(`column ${table}.${column} is missing`);
  }
  for (const [table, column] of NULLABLE) {
    if (!present.has(table)) continue;
    const nullable = byKey.get(`${table}.${column}`);
    if (nullable === 'NO') problems.push(`column ${table}.${column} must accept NULL`);
  }

  return problems;
}

/** Log the result at boot. Never throws — a warning is more use than a dead server. */
async function report() {
  try {
    const problems = await check();
    if (!problems.length) return true;
    console.error('\n  DATABASE IS BEHIND THE CODE:');
    problems.forEach((p) => console.error('   - ' + p));
    console.error('  Run:  node scripts/migrate_versions.js  (and migrate_ldp.js, migrate_rp_approver_columns.js, migrate_designations.js)\n');
    return false;
  } catch (err) {
    console.error('  Could not check the database schema:', err.message);
    return false;
  }
}

module.exports = { check, report, TABLES, COLUMNS, NULLABLE };
