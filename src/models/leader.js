'use strict';
const db = require('../lib/db');
const employee = require('./employee');

const ACTIVE = employee.STATUS_ACTIVE;

/**
 * Who can be picked as somebody's RP Approver, RP Creator or Pracharak: any active member.
 *
 * By sangh, the picker offers that sangh's own active members, because the choice applies
 * to the whole sangh. By member, it offers every active member, since one member's leader
 * is not always someone from their own sangh.
 *
 * The subject-scope filter (scope.sqlCondition) is deliberately NOT applied here: members
 * of out-of-scope sanghs such as SS/SS1 are excluded as subjects but may still lead a
 * sangh elsewhere, so they must remain eligible as leaders.
 */
async function memberCandidates() {
  return db.query(
    `SELECT e.emp_code, e.name, e.sangh_code, e.sangh_name, e.designation
     FROM tbl_employee e
     WHERE e.status = ? AND TRIM(e.name) <> '' AND TRIM(e.emp_code) <> ''
     ORDER BY TRIM(e.name) ASC`,
    [ACTIVE]
  );
}

/** The same pool for every role — the roles differ in who holds them, not in who may. */
async function candidates() {
  return memberCandidates();
}

async function allCandidates() {
  const members = await memberCandidates();
  const out = {};
  for (const role of Object.keys(employee.ROLES)) out[role] = members;
  return out;
}

/**
 * sangh_code → { role: [emp_code, ...] } for every active member of that sangh.
 *
 * The picker uses this to show a sangh's own people: as the whole list when assigning to a
 * sangh, and as the first group when assigning to one member.
 */
async function sanghLeaderMap() {
  const members = await memberCandidates();
  const roles = Object.keys(employee.ROLES);
  const map = {};

  for (const member of members) {
    const sangh = String(member.sangh_code || '').trim();
    if (sangh === '') continue;
    map[sangh] = map[sangh] || {};
    for (const role of roles) {
      (map[sangh][role] = map[sangh][role] || []).push(member.emp_code);
    }
  }
  return map;
}

module.exports = { memberCandidates, candidates, allCandidates, sanghLeaderMap };
