'use strict';
/**
 * Renames the stale "sevak_*" columns left over from an old naming convention to match
 * what every route/model/view in the app has always actually expected: rp_approver_code,
 * rp_approver_name, rp_approver_action_by, rp_approver_action_at.
 *
 * This is the root cause of two live bugs: approving a role profile at the RP Approver
 * stage wrote to rp_role_profiles.rp_approver_action_by/at, which didn't exist, and
 * approving at the PSP Approver stage called version.freeze(), which wrote to
 * rp_profile_versions.rp_approver_code/name/action_by/action_at — none of which existed
 * either (that table had sevak_code/sevak_name/sevak_action_by/sevak_action_at instead).
 * Both threw, and since neither route awaits inside a try/catch, the exception reached
 * Node as an unhandled rejection and took the whole process down.
 *
 * A rename (not a new column) — nothing has ever been written to these columns via the
 * live approval path, since it always crashed before completing, so there is no data to
 * migrate; CHANGE COLUMN preserves whatever blank/null values are already there.
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

const RENAMES = [
  ['rp_role_profiles', 'sevak_action_by', 'rp_approver_action_by',
    'ALTER TABLE rp_role_profiles CHANGE COLUMN sevak_action_by rp_approver_action_by VARCHAR(50) DEFAULT NULL'],
  ['rp_role_profiles', 'sevak_action_at', 'rp_approver_action_at',
    'ALTER TABLE rp_role_profiles CHANGE COLUMN sevak_action_at rp_approver_action_at DATETIME DEFAULT NULL'],
  ['rp_profile_versions', 'sevak_code', 'rp_approver_code',
    "ALTER TABLE rp_profile_versions CHANGE COLUMN sevak_code rp_approver_code VARCHAR(50) NOT NULL DEFAULT ''"],
  ['rp_profile_versions', 'sevak_name', 'rp_approver_name',
    "ALTER TABLE rp_profile_versions CHANGE COLUMN sevak_name rp_approver_name VARCHAR(255) NOT NULL DEFAULT ''"],
  ['rp_profile_versions', 'sevak_action_by', 'rp_approver_action_by',
    'ALTER TABLE rp_profile_versions CHANGE COLUMN sevak_action_by rp_approver_action_by VARCHAR(50) DEFAULT NULL'],
  ['rp_profile_versions', 'sevak_action_at', 'rp_approver_action_at',
    'ALTER TABLE rp_profile_versions CHANGE COLUMN sevak_action_at rp_approver_action_at DATETIME DEFAULT NULL'],
];

async function main() {
  console.log(`Migrating ${(await db.first('SELECT DATABASE() d')).d}\n`);

  for (const [table, oldCol, newCol, ddl] of RENAMES) {
    if (await columnExists(table, newCol)) { say(`${table}.${newCol} — already there`); continue; }
    if (!(await columnExists(table, oldCol))) {
      say(`${table}.${oldCol} — not found and ${table}.${newCol} missing too; skipping (check manually)`);
      continue;
    }
    await db.run(ddl);
    say(`${table}.${oldCol} → ${newCol} — renamed`);
  }

  console.log('\nDone.');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { columnExists, RENAMES, main };
