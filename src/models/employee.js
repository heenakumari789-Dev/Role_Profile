'use strict';
const crypto = require('crypto');
const db = require('../lib/db');
const scope = require('../lib/scope');
const config = require('../config');

/** In tbl_employee, status 0 means active — inverted from the usual convention. */
const STATUS_ACTIVE = 0;

/**
 * The three assignable roles and the column pair backing each. Column names stay as
 * they are in the database; only the labels are what people see.
 */
const ROLES = {
  rp_approver: { code: 'rp_approver_code', name: 'rp_approver_name', label: 'RP Approver' },
  rp_creator: { code: 'rp_creator_code', name: 'rp_creator_name', label: 'RP Creator' },
  pracharak: { code: 'pracharak_code', name: 'pracharak_name', label: 'Pracharak' },
};

const LMS = config.lmsSchema;

/** Every active member with the roles assigned to them. */
async function getDirectory() {
  return db.query(
    `SELECT e.emp_id, e.emp_code, e.name, e.sangh_code, e.sangh_name,
            e.email_id, e.phone, e.grade,
            e.rp_approver_code, e.rp_approver_name,
            e.rp_creator_code, e.rp_creator_name,
            e.pracharak_code,
            COALESCE(NULLIF(TRIM(e.pracharak_name), ''), NULLIF(TRIM(m.pracharak_name), ''), '') AS pracharak_name
     FROM tbl_employee e
     LEFT JOIN ${LMS}.emp_master m ON m.emp_code = e.emp_code
     WHERE e.status = ? AND ${scope.sqlCondition('e')}
     ORDER BY TRIM(e.name) = '' ASC, e.name ASC`,
    [STATUS_ACTIVE]
  );
}

async function findActiveByCode(empCode) {
  return db.first(
    `SELECT e.emp_id, e.emp_code, e.name, e.sangh_code, e.sangh_name, e.email_id, e.grade,
            e.rp_approver_code, e.rp_approver_name,
            e.rp_creator_code, e.rp_creator_name,
            e.pracharak_code,
            COALESCE(NULLIF(TRIM(e.pracharak_name), ''), NULLIF(TRIM(m.pracharak_name), ''), '') AS pracharak_name
     FROM tbl_employee e
     LEFT JOIN ${LMS}.emp_master m ON m.emp_code = e.emp_code
     WHERE e.status = ? AND e.emp_code = ? AND ${scope.sqlCondition('e')}
     LIMIT 1`,
    [STATUS_ACTIVE, empCode]
  );
}

/** Assign or clear one role for one member. Empty personCode unassigns. */
async function setAssignment(empCode, role, personCode, personName) {
  const cols = ROLES[role];
  if (!cols) return false;
  const res = await db.run(
    `UPDATE tbl_employee SET ${cols.code} = ?, ${cols.name} = ?
     WHERE emp_code = ? AND status = ? AND ${scope.sqlCondition('tbl_employee')}`,
    [personCode, personName, empCode, STATUS_ACTIVE]
  );
  return res.affectedRows > 0;
}

/** Apply one role to a chosen set of members — the "these 6, those 4" case. */
async function assignMany(empCodes, role, personCode, personName) {
  const codes = [...new Set(empCodes.map((c) => String(c).trim()).filter(Boolean))];
  const cols = ROLES[role];
  if (!codes.length || !cols) return 0;

  const res = await db.run(
    `UPDATE tbl_employee SET ${cols.code} = ?, ${cols.name} = ?
     WHERE emp_code IN (?) AND status = ? AND ${scope.sqlCondition('tbl_employee')}`,
    [personCode, personName, codes, STATUS_ACTIVE]
  );
  return res.affectedRows;
}

async function membersOfSangh(sanghCode) {
  return db.query(
    `SELECT e.emp_id, e.emp_code, e.name, e.sangh_code, e.sangh_name, e.email_id, e.grade,
            e.rp_approver_code, e.rp_approver_name,
            e.rp_creator_code, e.rp_creator_name,
            e.pracharak_code,
            COALESCE(NULLIF(TRIM(e.pracharak_name), ''), NULLIF(TRIM(m.pracharak_name), ''), '') AS pracharak_name
     FROM tbl_employee e
     LEFT JOIN ${LMS}.emp_master m ON m.emp_code = e.emp_code
     WHERE e.status = ? AND e.sangh_code = ? AND ${scope.sqlCondition('e')}
     ORDER BY TRIM(e.name) = '' ASC, e.name ASC`,
    [STATUS_ACTIVE, sanghCode]
  );
}

/**
 * The members a person is responsible for — everyone who lists them as their
 * RP Approver, RP Creator or Pracharak. Pracharaks can exist as a bare name with no
 * emp_code, so those are matched on name too.
 *
 * SS/SS1 (Sanghrakshak / Seva Sangh) belong to LDP, where only the RP Creator writes the role
 * profile: a member there is listed only for their RP Creator, not for someone who is merely
 * their RP Approver or Pracharak. Elsewhere all three roles count.
 */
async function membersLedBy(empCode, personName = '') {
  return db.query(
    `SELECT e.emp_id, e.emp_code, e.name, e.sangh_code, e.sangh_name,
            e.email_id, e.phone, e.grade,
            e.rp_approver_code, e.rp_approver_name,
            e.rp_creator_code, e.rp_creator_name,
            e.pracharak_code, e.pracharak_name,
            (e.rp_approver_code = ?)  AS is_my_rp_approver,
            (e.rp_creator_code = ?)   AS is_my_rp_creator,
            (e.pracharak_code = ?
             OR (TRIM(e.pracharak_code) = '' AND ? <> '' AND e.pracharak_name = ?)) AS is_my_pracharak
     FROM tbl_employee e
     WHERE e.status = ?
       AND (
             (${scope.sqlCondition('e')} AND (
                  e.rp_approver_code = ?
               OR e.rp_creator_code = ?
               OR e.pracharak_code = ?
               OR (TRIM(e.pracharak_code) = '' AND ? <> '' AND e.pracharak_name = ?)
             ))
          OR (${scope.excludedSanghCondition('e')} AND e.rp_creator_code = ?)
       )
     ORDER BY TRIM(e.name) = '' ASC, e.sangh_name ASC, e.name ASC`,
    [empCode, empCode, empCode, personName, personName,
     STATUS_ACTIVE,
     empCode, empCode, empCode, personName, personName, empCode]
  );
}

/**
 * Credentials check against the PSP portal's existing convention (MD5). Some accounts
 * (never migrated to a hashed password) only carry plane_password — a plaintext
 * fallback, compared directly, used only when password is empty.
 * Deliberately NOT scoped: SS/SS1 people can still sign in.
 */
async function authenticate(empCode, password) {
  const row = await db.first(
    `SELECT emp_id, emp_code, name, sangh_name, password, plane_password
     FROM tbl_employee WHERE emp_code = ? AND status = ? LIMIT 1`,
    [empCode, STATUS_ACTIVE]
  );
  if (!row) return null;

  const stored = String(row.password || '').trim();
  let ok;
  if (stored) {
    const given = crypto.createHash('md5').update(password).digest('hex');
    ok = given.length === stored.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(stored));
  } else {
    const plain = String(row.plane_password || '').trim();
    ok = !!plain && plain.length === password.length
      && crypto.timingSafeEqual(Buffer.from(plain), Buffer.from(password));
  }
  if (!ok) return null;

  delete row.password;
  delete row.plane_password;
  return row;
}

module.exports = {
  STATUS_ACTIVE, ROLES,
  getDirectory, findActiveByCode, setAssignment, assignMany,
  membersOfSangh, membersLedBy, authenticate,
};
