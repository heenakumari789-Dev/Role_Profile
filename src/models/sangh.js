'use strict';
const db = require('../lib/db');
const scope = require('../lib/scope');
const employee = require('./employee');

const ACTIVE = employee.STATUS_ACTIVE;
const ROLES = employee.ROLES;

/**
 * Sangh-level view of the per-member assignments. Assignments are stored per member,
 * so a sangh's "current" RP Approver is whatever its members share; where they disagree
 * the sangh is reported as mixed.
 */
async function summary() {
  const parts = [];
  for (const [role, cols] of Object.entries(ROLES)) {
    parts.push(`COUNT(DISTINCT NULLIF(TRIM(e.${cols.name}), '')) AS ${role}_variants`);
    parts.push(`MAX(NULLIF(TRIM(e.${cols.name}), '')) AS ${role}_name`);
    parts.push(`MAX(NULLIF(TRIM(e.${cols.code}), '')) AS ${role}_code`);
    parts.push(`SUM(TRIM(e.${cols.name}) = '') AS ${role}_missing`);
  }

  const rows = await db.query(
    `SELECT e.sangh_code,
            MAX(NULLIF(TRIM(e.sangh_name), '')) AS sangh_name,
            COUNT(*) AS member_count,
            ${parts.join(',\n            ')}
     FROM tbl_employee e
     WHERE e.status = ? AND TRIM(e.sangh_code) <> ''
       AND ${scope.sqlCondition('e')}
     GROUP BY e.sangh_code
     ORDER BY member_count DESC, e.sangh_code ASC`,
    [ACTIVE]
  );

  for (const row of rows) {
    row.member_count = Number(row.member_count);
    for (const role of Object.keys(ROLES)) {
      const variants = Number(row[`${role}_variants`]);
      row[`${role}_variants`] = variants;
      row[`${role}_missing`] = Number(row[`${role}_missing`]);
      row[`${role}_mixed`] = variants > 1;
      // Only a single agreed value is meaningful as "the sangh's" person.
      if (variants !== 1) {
        row[`${role}_name`] = variants > 1 ? null : '';
        row[`${role}_code`] = '';
      }
    }
  }
  return rows;
}

/** Apply one role to every active member of a sangh. */
async function assignToSangh(sanghCode, role, personCode, personName) {
  const cols = ROLES[role];
  if (!cols || !String(sanghCode).trim()) return 0;

  const res = await db.run(
    `UPDATE tbl_employee SET ${cols.code} = ?, ${cols.name} = ?
     WHERE sangh_code = ? AND status = ? AND ${scope.sqlCondition('tbl_employee')}`,
    [personCode, personName, sanghCode, ACTIVE]
  );
  return res.affectedRows;
}

async function memberCount(sanghCode) {
  const row = await db.first(
    `SELECT COUNT(*) AS n FROM tbl_employee
     WHERE sangh_code = ? AND status = ? AND ${scope.sqlCondition('tbl_employee')}`,
    [sanghCode, ACTIVE]
  );
  return Number(row ? row.n : 0);
}

module.exports = { summary, assignToSangh, memberCount };
