'use strict';
/**
 * Adds role-profile versioning and the yearly review.
 *
 * Every approval freezes an immutable copy of the profile, assessments record which copy
 * they were made against, and each financial year gets a review row saying which version
 * was in force. Nothing existing is dropped or rewritten: new tables, nullable columns,
 * and a backfill that gives every already-approved profile its version 1.
 *
 * Safe to run more than once.
 */
const db = require('../src/lib/db');
const financialYear = require('../src/models/financialYear');

const say = (msg) => console.log('  ' + msg);

async function tableExists(name) {
  const row = await db.first(
    'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]);
  return Number(row.n) > 0;
}
async function columnExists(table, column) {
  const row = await db.first(
    `SELECT COUNT(*) n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  return Number(row.n) > 0;
}

const TABLES = {
  rp_profile_versions: `
    CREATE TABLE rp_profile_versions (
      id INT(11) NOT NULL AUTO_INCREMENT,
      role_profile_id INT(11) NOT NULL,
      version_no INT(11) NOT NULL,
      designation_name VARCHAR(255) NOT NULL DEFAULT '',
      designation_id INT(11) DEFAULT NULL,
      sangh_code VARCHAR(50) NOT NULL DEFAULT '',
      sangh_name VARCHAR(255) NOT NULL DEFAULT '',
      mission TEXT,
      created_by VARCHAR(50) NOT NULL DEFAULT '',
      created_by_name VARCHAR(255) NOT NULL DEFAULT '',
      rp_approver_code VARCHAR(50) NOT NULL DEFAULT '',
      rp_approver_name VARCHAR(255) NOT NULL DEFAULT '',
      rp_approver_action_by VARCHAR(50) DEFAULT NULL,
      rp_approver_action_at DATETIME DEFAULT NULL,
      admin_action_by VARCHAR(50) DEFAULT NULL,
      admin_action_at DATETIME DEFAULT NULL,
      approved_at DATETIME DEFAULT NULL,
      effective_from_year VARCHAR(20) NOT NULL DEFAULT '',
      reason VARCHAR(255) NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_profile_version (role_profile_id, version_no),
      KEY idx_profile (role_profile_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  rp_version_outcomes: `
    CREATE TABLE rp_version_outcomes (
      id INT(11) NOT NULL AUTO_INCREMENT,
      version_id INT(11) NOT NULL,
      outcome TEXT,
      sort_order INT(11) NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      KEY idx_version (version_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  rp_version_details: `
    CREATE TABLE rp_version_details (
      id INT(11) NOT NULL AUTO_INCREMENT,
      version_id INT(11) NOT NULL,
      source_detail_id INT(11) DEFAULT NULL,
      attribute_no INT(11) NOT NULL DEFAULT 0,
      attribute TEXT,
      assessment TEXT,
      attribute_weight FLOAT NOT NULL DEFAULT 0,
      tech_skill TEXT,
      tech_weight FLOAT NOT NULL DEFAULT 0,
      sort_order INT(11) NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      KEY idx_version (version_id),
      KEY idx_source (source_detail_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  rp_profile_reviews: `
    CREATE TABLE rp_profile_reviews (
      id INT(11) NOT NULL AUTO_INCREMENT,
      role_profile_id INT(11) NOT NULL,
      financial_year VARCHAR(20) NOT NULL,
      version_id INT(11) NOT NULL,
      outcome ENUM('created','unchanged','updated') NOT NULL DEFAULT 'unchanged',
      reviewed_by VARCHAR(50) NOT NULL DEFAULT '',
      reviewed_by_name VARCHAR(255) NOT NULL DEFAULT '',
      note VARCHAR(255) NOT NULL DEFAULT '',
      reviewed_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_profile_year (role_profile_id, financial_year),
      KEY idx_version (version_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

const COLUMNS = [
  ['rp_assessments', 'version_id', 'ALTER TABLE rp_assessments ADD COLUMN version_id INT(11) DEFAULT NULL AFTER role_profile_id'],
  ['rp_assessment_ratings', 'version_detail_id', 'ALTER TABLE rp_assessment_ratings ADD COLUMN version_detail_id INT(11) DEFAULT NULL AFTER role_profile_detail_id'],
];

/**
 * A versioned rating points at a frozen row, not a live one, so the old column has to
 * accept NULL. Existing values are left exactly as they are.
 */
async function relaxOldRatingColumn() {
  const col = await db.first(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'rp_assessment_ratings'
       AND column_name = 'role_profile_detail_id'`);
  if (!col || col.is_nullable === 'YES') { say('rp_assessment_ratings.role_profile_detail_id — already nullable'); return; }
  await db.run('ALTER TABLE rp_assessment_ratings MODIFY COLUMN role_profile_detail_id INT(11) DEFAULT NULL');
  say('rp_assessment_ratings.role_profile_detail_id — now nullable');
}

async function main() {
  console.log(`Migrating ${(await db.first('SELECT DATABASE() d')).d}\n`);

  for (const [name, ddl] of Object.entries(TABLES)) {
    if (await tableExists(name)) { say(`${name} — already there`); continue; }
    await db.run(ddl);
    say(`${name} — created`);
  }

  for (const [table, column, ddl] of COLUMNS) {
    if (await columnExists(table, column)) { say(`${table}.${column} — already there`); continue; }
    await db.run(ddl);
    say(`${table}.${column} — added`);
  }

  await relaxOldRatingColumn();

  /* ---------------------------------------------------------- backfill */
  const fy = await financialYear.current();
  const approved = await db.query("SELECT * FROM rp_role_profiles WHERE status = 'approved' ORDER BY id");

  for (const profile of approved) {
    const has = await db.first('SELECT id FROM rp_profile_versions WHERE role_profile_id = ? LIMIT 1', [profile.id]);
    if (has) { say(`profile ${profile.id} — version already recorded`); continue; }

    const versionId = await snapshot(profile, {
      // The version dates from when it was approved, not from when this script ran.
      effectiveYear: yearOf(profile.admin_action_at || profile.rp_approver_action_at || profile.created_at) || fy,
      reason: 'First recorded version',
      outcome: 'created',
    });
    say(`profile ${profile.id} — version 1 written (#${versionId})`);

    // Point existing assessments and their ratings at that version.
    const map = await db.query(
      'SELECT id, source_detail_id FROM rp_version_details WHERE version_id = ?', [versionId]);
    const bySource = new Map(map.map((r) => [Number(r.source_detail_id), Number(r.id)]));

    const assessments = await db.query(
      'SELECT id FROM rp_assessments WHERE role_profile_id = ? AND version_id IS NULL', [profile.id]);
    for (const a of assessments) {
      await db.run('UPDATE rp_assessments SET version_id = ? WHERE id = ?', [versionId, a.id]);
      const ratings = await db.query(
        'SELECT id, role_profile_detail_id FROM rp_assessment_ratings WHERE assessment_id = ?', [a.id]);
      let linked = 0;
      for (const rating of ratings) {
        const vd = bySource.get(Number(rating.role_profile_detail_id));
        if (!vd) continue;
        await db.run('UPDATE rp_assessment_ratings SET version_detail_id = ? WHERE id = ?', [vd, rating.id]);
        linked++;
      }
      say(`  assessment ${a.id} — ${linked} of ${ratings.length} ratings linked`);
    }
  }

  console.log('\nDone.');
  process.exit(0);
}

/** The financial year a timestamp falls in. */
function yearOf(stamp) {
  if (!stamp) return null;
  const d = new Date(String(stamp).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : financialYear.yearFor(d);
}

/** Freeze the profile's current text as a new version, and record the year's review. */
async function snapshot(profile, { effectiveYear, reason, outcome }) {
  return db.transaction(async (conn) => {
    const [[{ next }]] = await conn.query(
      'SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM rp_profile_versions WHERE role_profile_id = ?',
      [profile.id]);

    const approvedAt = profile.admin_action_at || profile.rp_approver_action_at || profile.created_at;
    const [res] = await conn.query(
      `INSERT INTO rp_profile_versions
         (role_profile_id, version_no, designation_name, designation_id, sangh_code, sangh_name, mission,
          created_by, created_by_name, rp_approver_code, rp_approver_name, rp_approver_action_by, rp_approver_action_at,
          admin_action_by, admin_action_at, approved_at, effective_from_year, reason, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [profile.id, next, profile.designation_name, profile.designation_id, profile.sangh_code,
       profile.sangh_name, profile.mission, profile.created_by, profile.created_by_name,
       profile.rp_approver_code || '', profile.rp_approver_name || '', profile.rp_approver_action_by, profile.rp_approver_action_at,
       profile.admin_action_by, profile.admin_action_at, approvedAt, effectiveYear, reason, approvedAt]);
    const versionId = res.insertId;

    const [outcomes] = await conn.query(
      'SELECT outcome, sort_order FROM rp_role_key_outcomes WHERE role_profile_id = ? ORDER BY sort_order',
      [profile.id]);
    for (const o of outcomes) {
      await conn.query('INSERT INTO rp_version_outcomes (version_id, outcome, sort_order) VALUES (?,?,?)',
        [versionId, o.outcome, o.sort_order]);
    }

    const [details] = await conn.query(
      `SELECT * FROM rp_role_profile_details WHERE role_profile_id = ?
       ORDER BY attribute_no, sort_order`, [profile.id]);
    for (const d of details) {
      await conn.query(
        `INSERT INTO rp_version_details
           (version_id, source_detail_id, attribute_no, attribute, assessment,
            attribute_weight, tech_skill, tech_weight, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [versionId, d.id, d.attribute_no, d.attribute, d.assessment,
         d.attribute_weight, d.tech_skill, d.tech_weight, d.sort_order]);
    }

    await conn.query(
      `INSERT INTO rp_profile_reviews
         (role_profile_id, financial_year, version_id, outcome, reviewed_by, reviewed_by_name, note, reviewed_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE version_id = VALUES(version_id), outcome = VALUES(outcome)`,
      [profile.id, effectiveYear, versionId, outcome, profile.created_by, profile.created_by_name,
       reason, approvedAt]);

    return versionId;
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
