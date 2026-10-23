'use strict';
/**
 * One-off data fix: Role Profile #4 ("Bussiness Analytics Lead") is missing the middle
 * attribute of its "Oracle & PL/SQL" skill (attribute_no 6) — only 2 of 3 rows exist,
 * summing to 6 instead of the group's declared weight of 10. Role Profile #3 ("Data
 * Analyst head") has the same skill group complete (rows 97, 108, 109 = 4+3+3=10),
 * confirming what the missing row's content and weight should be — profile 4 was almost
 * certainly cloned from/alongside profile 3 and this one row never got duplicated.
 *
 * Adds the missing row to both the live details (so future edits see it) and the
 * already-approved version 5 (so the frozen version this profile's one existing
 * assessment was made against becomes complete too). The new row starts unrated, so it
 * does not change that assessment's already-stored total — it will just show as an
 * un-rated line until someone rates it.
 *
 * Safe to run more than once (checks first).
 */
const db = require('../src/lib/db');

const ROLE_PROFILE_ID = 4;
const VERSION_ID = 5;
const ATTRIBUTE_NO = 6;
const ATTRIBUTE = 'Oracle & PL/SQL';
const TECH_SKILL = 'SQL expertise: Joins, Triggers, Functions, Indexing, Views, Stored Procedures';
const TECH_WEIGHT = 4;
const SORT_ORDER = 16;
const ATTRIBUTE_WEIGHT = 10;

async function main() {
  const existingDetail = await db.first(
    'SELECT id FROM rp_role_profile_details WHERE role_profile_id = ? AND attribute_no = ? AND tech_skill = ?',
    [ROLE_PROFILE_ID, ATTRIBUTE_NO, TECH_SKILL]
  );
  if (existingDetail) {
    console.log(`rp_role_profile_details — already has it (id ${existingDetail.id})`);
  } else {
    const res = await db.run(
      `INSERT INTO rp_role_profile_details
         (role_profile_id, attribute_no, attribute, assessment, attribute_weight, tech_skill, tech_weight, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`,
      [ROLE_PROFILE_ID, ATTRIBUTE_NO, ATTRIBUTE, '', ATTRIBUTE_WEIGHT, TECH_SKILL, TECH_WEIGHT, SORT_ORDER]
    );
    console.log(`rp_role_profile_details — inserted (id ${res.insertId})`);
  }

  const existingVersion = await db.first(
    'SELECT id FROM rp_version_details WHERE version_id = ? AND attribute_no = ? AND tech_skill = ?',
    [VERSION_ID, ATTRIBUTE_NO, TECH_SKILL]
  );
  if (existingVersion) {
    console.log(`rp_version_details — already has it (id ${existingVersion.id})`);
  } else {
    const detail = await db.first(
      'SELECT id FROM rp_role_profile_details WHERE role_profile_id = ? AND attribute_no = ? AND tech_skill = ?',
      [ROLE_PROFILE_ID, ATTRIBUTE_NO, TECH_SKILL]
    );
    const res = await db.run(
      `INSERT INTO rp_version_details
         (version_id, source_detail_id, attribute_no, attribute, assessment, attribute_weight, tech_skill, tech_weight, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [VERSION_ID, detail.id, ATTRIBUTE_NO, ATTRIBUTE, '', ATTRIBUTE_WEIGHT, TECH_SKILL, TECH_WEIGHT, SORT_ORDER]
    );
    console.log(`rp_version_details — inserted (id ${res.insertId})`);
  }

  console.log('\nDone.');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { main };
