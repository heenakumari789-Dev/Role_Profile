'use strict';
const db = require('../lib/db');
const config = require('../config');
const scope = require('../lib/scope');
const employee = require('./employee');

const ACTIVE = employee.STATUS_ACTIVE;
const ROLES = employee.ROLES;
const LMS = config.lmsSchema;

/**
 * Who counts as LDP, from tbl_employee's own side: active in tbl_leaders (sewak/
 * sanghrakshak, wherever their sangh is), OR simply a member of SS/SS1 — those sanghs
 * (Sanghrakshak Sangh / Seva Sangh) are LDP's own by definition, which is exactly why PSP
 * excludes them (see scope.js). Always paired with e.status = 0 (active).
 */
function ldpMemberCondition(alias = 'e') {
  return `(l.emp_code IS NOT NULL OR ${scope.excludedSanghCondition(alias)})`;
}

/**
 * LDP's subjects: whoever is active in tbl_leaders, plus every active SS/SS1 member.
 * tbl_leaders.is_active is that programme's own flag and is independent of
 * tbl_employee.status; SS/SS1 members default to category 'sanghrakshak' when they have
 * no tbl_leaders row of their own.
 */
async function activeMembers() {
  return db.query(
    `SELECT e.emp_id, e.emp_code, e.name, e.sangh_code, e.sangh_name,
            e.email_id, e.phone, e.grade, COALESCE(l.category, 'sanghrakshak') AS category,
            e.rp_approver_code, e.rp_approver_name,
            e.rp_creator_code, e.rp_creator_name,
            e.pracharak_code,
            COALESCE(NULLIF(TRIM(e.pracharak_name), ''), NULLIF(TRIM(m.pracharak_name), ''), '') AS pracharak_name
     FROM tbl_employee e
     LEFT JOIN tbl_leaders l ON l.emp_code = e.emp_code AND l.is_active = 1
     LEFT JOIN ${LMS}.emp_master m ON m.emp_code = e.emp_code
     WHERE e.status = ? AND ${ldpMemberCondition('e')}
     ORDER BY TRIM(e.name) = '' ASC, e.name ASC`,
    [ACTIVE]
  );
}

async function findActiveByCode(empCode) {
  return db.first(
    `SELECT e.emp_id, e.emp_code, e.name, e.sangh_code, e.sangh_name, e.email_id, e.grade,
            COALESCE(l.category, 'sanghrakshak') AS category,
            e.rp_approver_code, e.rp_approver_name,
            e.rp_creator_code, e.rp_creator_name,
            e.pracharak_code,
            COALESCE(NULLIF(TRIM(e.pracharak_name), ''), NULLIF(TRIM(m.pracharak_name), ''), '') AS pracharak_name
     FROM tbl_employee e
     LEFT JOIN tbl_leaders l ON l.emp_code = e.emp_code AND l.is_active = 1
     LEFT JOIN ${LMS}.emp_master m ON m.emp_code = e.emp_code
     WHERE e.status = ? AND e.emp_code = ? AND ${ldpMemberCondition('e')}
     LIMIT 1`,
    [ACTIVE, empCode]
  );
}

/** Assign or clear one role for one LDP member. Empty personCode unassigns. */
async function setAssignment(empCode, role, personCode, personName) {
  const cols = ROLES[role];
  if (!cols) return false;
  const res = await db.run(
    `UPDATE tbl_employee e
     LEFT JOIN tbl_leaders l ON l.emp_code = e.emp_code AND l.is_active = 1
     SET e.${cols.code} = ?, e.${cols.name} = ?
     WHERE e.emp_code = ? AND e.status = ? AND ${ldpMemberCondition('e')}`,
    [personCode, personName, empCode, ACTIVE]
  );
  return res.affectedRows > 0;
}

/**
 * The reporting-line leader for an LDP assessment's final stage. Distinct from RP
 * Approver/RP Creator/Pracharak (who write and approve the role profile) — this is
 * tbl_employee.leader_id, resolved to the active member it points at, if any.
 */
async function resolveLeader(empCode) {
  const row = await db.first(
    `SELECT le.emp_code, le.name
     FROM tbl_employee e
     JOIN tbl_employee le ON le.emp_code = e.leader_id AND le.status = ?
     WHERE e.emp_code = ? AND TRIM(COALESCE(e.leader_id, '')) <> ''`,
    [ACTIVE, empCode]
  );
  return row ? { code: row.emp_code, name: row.name } : null;
}

/**
 * "sangh_code|designation" for every designation an active LDP member holds — used to tag
 * a designation as LDP when building the role-profile create form's picker.
 */
async function designationSet() {
  const rows = await db.query(
    `SELECT DISTINCT e.sangh_code, TRIM(e.designation) AS designation
     FROM tbl_employee e
     LEFT JOIN tbl_leaders l ON l.emp_code = e.emp_code AND l.is_active = 1
     WHERE e.status = ? AND TRIM(e.designation) <> '' AND ${ldpMemberCondition('e')}`,
    [ACTIVE]
  );
  return new Set(rows.map((r) => `${r.sangh_code}|${r.designation}`));
}

module.exports = { activeMembers, findActiveByCode, setAssignment, resolveLeader, designationSet };
