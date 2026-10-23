'use strict';
const db = require('../lib/db');
const employee = require('./employee');
const config = require('../config');
const scope = require('../lib/scope');

const LMS = config.lmsSchema;
const ACTIVE = employee.STATUS_ACTIVE;

const MAX_OUTCOMES = 3;
const MAX_ATTRIBUTES = 9;
const MAX_SKILLS_PER_ATTR = 3;
const TOTAL_WEIGHT = 100;

// LDP (sevak/sanghrakshak) role profiles require more key outcomes than PSP.
const MIN_OUTCOMES_LDP = 3;
const MAX_OUTCOMES_LDP = 5;

const PROGRAM = { PSP: 'psp', LDP: 'ldp' };

const STATUS = {
  DRAFT: 'draft',
  PENDING_SEVAK: 'pending_sevak',
  PENDING_ADMIN: 'pending_admin',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

const STATUS_LABELS = {
  draft: 'Draft',
  pending_sevak: 'Awaiting RP Approver',
  pending_admin: 'Awaiting PSP Approver',
  approved: 'Approved',
  rejected: 'Rejected',
};

/* ---------------------------------------------------------------- writing */

async function writeChildren(conn, id, outcomes, attributes, program = PROGRAM.PSP) {
  const maxOutcomes = program === PROGRAM.LDP ? MAX_OUTCOMES_LDP : MAX_OUTCOMES;
  // Drop blanks first so an empty row never consumes one of the allowed slots.
  const clean = outcomes
    .map((o) => String(o ?? '').trim())
    .filter(Boolean)
    .slice(0, maxOutcomes);

  for (let i = 0; i < clean.length; i++) {
    await conn.query(
      'INSERT INTO rp_role_key_outcomes (role_profile_id, outcome, sort_order) VALUES (?,?,?)',
      [id, clean[i], i]
    );
  }

  let attributeNo = 0;
  let rowSort = 0;
  for (const attr of attributes) {
    const name = String(attr.attribute ?? '').trim();
    if (!name) continue;
    attributeNo++;

    const assessment = String(attr.assessment ?? '').trim();
    const weight = attr.attribute_weight === '' || attr.attribute_weight == null
      ? null : Number(attr.attribute_weight);

    let skills = (attr.skills || [])
      .map((s) => ({
        skill: String(s.skill ?? '').trim(),
        weight: s.weight === '' || s.weight == null ? null : Number(s.weight),
      }))
      .filter((s) => s.skill !== '');

    // PSP repeats the attribute across its skill rows; with no skills a single row
    // still records the attribute itself.
    if (!skills.length) skills = [{ skill: null, weight: null }];

    for (const s of skills) {
      await conn.query(
        `INSERT INTO rp_role_profile_details
           (role_profile_id, attribute_no, attribute, assessment, attribute_weight, tech_skill, tech_weight, sort_order)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id, attributeNo, name, assessment, weight, s.skill, s.weight, rowSort++]
      );
    }
  }
}

async function createProfile(header, outcomes, attributes) {
  return db.transaction(async (conn) => {
    const cols = Object.keys(header);
    const [res] = await conn.query(
      `INSERT INTO rp_role_profiles (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map((c) => header[c])
    );
    const id = res.insertId;
    await writeChildren(conn, id, outcomes, attributes, header.program);
    return id;
  });
}

async function updateProfile(id, header, outcomes, attributes) {
  return db.transaction(async (conn) => {
    const cols = Object.keys(header);
    await conn.query(
      `UPDATE rp_role_profiles SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map((c) => header[c]), id]
    );
    // The children are wholly derived from the form.
    await conn.query('DELETE FROM rp_role_key_outcomes WHERE role_profile_id = ?', [id]);
    await conn.query('DELETE FROM rp_role_profile_details WHERE role_profile_id = ?', [id]);
    await writeChildren(conn, id, outcomes, attributes, header.program);
  });
}

/* ---------------------------------------------------------------- reading */

async function find(id) {
  return db.first('SELECT * FROM rp_role_profiles WHERE id = ?', [id]);
}

async function fullProfile(id) {
  const profile = await find(id);
  if (!profile) return null;

  const outcomeRows = await db.query(
    'SELECT outcome FROM rp_role_key_outcomes WHERE role_profile_id = ? ORDER BY sort_order ASC',
    [id]
  );
  profile.outcomes = outcomeRows.map((r) => r.outcome);

  const rows = await db.query(
    `SELECT * FROM rp_role_profile_details WHERE role_profile_id = ?
     ORDER BY attribute_no ASC, sort_order ASC`,
    [id]
  );

  // Fold the repeated attribute rows back into one entry per attribute.
  const byNo = new Map();
  for (const row of rows) {
    const no = Number(row.attribute_no);
    if (!byNo.has(no)) {
      byNo.set(no, {
        attribute_no: no,
        attribute: row.attribute,
        assessment: row.assessment,
        attribute_weight: row.attribute_weight,
        skills: [],
      });
    }
    if (String(row.tech_skill ?? '').trim() !== '') {
      byNo.get(no).skills.push({ tech_skill: row.tech_skill, tech_weight: row.tech_weight });
    }
  }
  profile.attributes = [...byNo.values()];
  return profile;
}

/**
 * SQL fragment: does this profile apply to the given person? Only when the admin has
 * assigned it to them — nothing is applied automatically by designation. Placeholders:
 * emp_code, active status.
 */
function appliesToPersonSql() {
  return `EXISTS (
      SELECT 1 FROM rp_role_profile_members m
      JOIN tbl_employee e ON e.emp_code = m.emp_code AND e.status = ?
      WHERE m.role_profile_id = p.id AND m.emp_code = ?
  )`;
}

/* ------------------------------------------------- the final approval stage */

/**
 * Who gives final approval: the PSP Approver for a PSP profile, the LDP Admin for an LDP one
 * (Sanghrakshak / Seva Sangh). Both stages keep the status `pending_admin`; the programme
 * decides whose desk it is on.
 */
function finalApprover(profile) {
  const ldp = (profile.program || sanghProgram(profile.sangh_code)) === PROGRAM.LDP;
  return ldp
    ? { key: 'ldp', label: 'LDP Admin', codes: config.ldpAdminCodes }
    : { key: 'psp', label: 'PSP Approver', codes: config.adminCodes };
}

/** Is this person the final approver for that profile? */
function isFinalApprover(profile, isAdmin, isLdpAdmin) {
  return finalApprover(profile).key === 'ldp' ? !!isLdpAdmin : !!isAdmin;
}

/** The status as people should read it — "Awaiting LDP Admin" for an LDP profile. */
function statusLabel(profile) {
  if (profile.status === STATUS.PENDING_ADMIN) return `Awaiting ${finalApprover(profile).label}`;
  return STATUS_LABELS[profile.status] || profile.status;
}

/**
 * Someone sees a profile when they wrote it, when it is waiting on them as RP Approver,
 * or — once approved — when it actually applies to them. Drafts stay private. The PSP
 * Approver sees every PSP profile and the LDP Admin every LDP one.
 */
async function visibleTo(empCode, isAdmin, isLdpAdmin = false) {
  let sql = `SELECT p.* FROM rp_role_profiles p WHERE (p.status <> ? OR p.created_by = ?)`;
  const params = [STATUS.DRAFT, empCode];

  if (!(isAdmin && isLdpAdmin)) {
    const reach = [];
    if (isAdmin) reach.push(`p.program <> '${PROGRAM.LDP}'`);
    if (isLdpAdmin) reach.push(`p.program = '${PROGRAM.LDP}'`);
    sql += ` AND (
               p.created_by = ?
            OR (p.rp_approver_code = ? AND p.status <> ?)
            OR (p.status = ? AND ${appliesToPersonSql()})
            ${reach.map((r) => `OR ${r}`).join(' ')}
           )`;
    params.push(empCode, empCode, STATUS.DRAFT, STATUS.APPROVED, ACTIVE, empCode);
  }

  sql += ' ORDER BY p.created_at DESC';
  return db.query(sql, params);
}

/** Same rule as visibleTo(), for one row. */
async function canView(profile, empCode, isAdmin, isLdpAdmin = false) {
  if (profile.created_by === empCode) return true;
  if (profile.status === STATUS.DRAFT) return false;
  if (profile.rp_approver_code === empCode) return true;
  if (isFinalApprover(profile, isAdmin, isLdpAdmin)) return true;
  if (profile.status !== STATUS.APPROVED) return false;

  const members = await effectiveMembers(profile);
  return members.some((m) => m.emp_code === empCode);
}

/**
 * Did this profile skip the RP Approver and go straight to final approval?
 * That happens when the creator is their own RP Approver (or has none on record).
 */
function skippedRpApprover(profile) {
  const code = String(profile.rp_approver_code || '').trim();
  return code === '' || code === profile.created_by;
}

/**
 * The author may edit a draft, a rejected profile, and — for the yearly review — one that
 * is already approved. Revising an approved profile sends it back through approval; the
 * version already frozen stays in force until the new one is approved, so nothing that
 * has been assessed is disturbed.
 *
 * While it waits for approval it can still be changed, one level at a time: the author and
 * the RP Approver it is waiting on at the first stage, and only the final approver (PSP
 * Approver, or LDP Admin for LDP) once the RP Approver has approved. When there was no
 * separate RP Approver — the creator is their own — nobody has looked at it yet, so the
 * author keeps editing until final approval too.
 */
function canEdit(profile, empCode, isAdmin = false, isLdpAdmin = false) {
  if (!empCode) return false;
  switch (profile.status) {
    case STATUS.DRAFT:
    case STATUS.REJECTED:
    case STATUS.APPROVED:
      return profile.created_by === empCode;
    // Level 1: the author and the RP Approver it is waiting on may both still change it.
    case STATUS.PENDING_SEVAK:
      return profile.created_by === empCode || profile.rp_approver_code === empCode;
    // Level 2: once the RP Approver has approved, only the final approver may change it —
    // unless there was no RP Approver stage, in which case the author still may.
    case STATUS.PENDING_ADMIN:
      return isFinalApprover(profile, isAdmin, isLdpAdmin)
        || (profile.created_by === empCode && skippedRpApprover(profile));
    default:
      return false;
  }
}

/** Is this an edit made while the profile is waiting for approval (it keeps its place)? */
function isPendingEdit(profile) {
  return [STATUS.PENDING_SEVAK, STATUS.PENDING_ADMIN].includes(profile.status);
}

/** Only the author sends their own draft / rejected / approved profile for approval. */
function canSubmit(profile, empCode) {
  return (
    !!empCode &&
    profile.created_by === empCode &&
    [STATUS.DRAFT, STATUS.REJECTED, STATUS.APPROVED].includes(profile.status)
  );
}

/** Is this edit a revision of something already approved, rather than a first draft? */
function isRevision(profile) {
  return profile.status === STATUS.APPROVED;
}

/** What is waiting on this person: final approvals for their programme(s), else RP approvals. */
async function awaiting(empCode, isAdmin, isLdpAdmin = false) {
  if (isAdmin || isLdpAdmin) {
    const programs = [isAdmin && PROGRAM.PSP, isLdpAdmin && PROGRAM.LDP].filter(Boolean);
    return db.query(
      'SELECT * FROM rp_role_profiles WHERE status = ? AND program IN (?) ORDER BY created_at ASC',
      [STATUS.PENDING_ADMIN, programs]);
  }
  return db.query(
    'SELECT * FROM rp_role_profiles WHERE status = ? AND rp_approver_code = ? ORDER BY created_at ASC',
    [STATUS.PENDING_SEVAK, empCode]
  );
}

/** Can this person act on the profile at its current stage? */
function canActOn(profile, empCode, isAdmin, isLdpAdmin = false) {
  if (profile.status === STATUS.PENDING_SEVAK) {
    // Nobody clears their own submission, even if recorded as their own RP Approver.
    return !!empCode && profile.rp_approver_code === empCode && profile.created_by !== empCode;
  }
  if (profile.status === STATUS.PENDING_ADMIN) return isFinalApprover(profile, isAdmin, isLdpAdmin);
  return false;
}

/* ------------------------------------------------------------ membership */

/**
 * Active members holding this designation *within its sangh*. 13 designations exist in
 * more than one sangh, so matching on designation alone would leak across sanghs.
 *
 * Not scoped by scope.sqlCondition — sanghCode already pins this to one sangh, so an LDP
 * profile for SS/SS1 must still find its own members.
 */
async function membersWithDesignation(designationName, sanghCode = '') {
  let sql = `SELECT emp_code, name, sangh_code, sangh_name, email_id, designation
             FROM tbl_employee
             WHERE status = ?
               AND TRIM(designation) = ?`;
  const params = [ACTIVE, String(designationName).trim()];
  if (String(sanghCode).trim() !== '') {
    sql += ' AND sangh_code = ?';
    params.push(sanghCode);
  }
  sql += ' ORDER BY name ASC';
  return db.query(sql, params);
}

async function explicitMembers(profileId) {
  return db.query(
    `SELECT m.emp_code, m.member_name, m.assigned_by, m.assigned_by_name, m.assigned_at,
            e.emp_code AS active_code, e.name, e.sangh_name, e.designation, e.email_id
     FROM rp_role_profile_members m
     LEFT JOIN tbl_employee e ON e.emp_code = m.emp_code AND e.status = ${ACTIVE}
     WHERE m.role_profile_id = ?
     ORDER BY m.member_name ASC`,
    [profileId]
  );
}

/**
 * Who this role profile applies to: the active members the admin has assigned to it.
 * Nothing is applied automatically — holding the designation does not put someone on the
 * profile. Only an approved profile applies to anyone, and someone who has since left is
 * neither shown nor assessed.
 */
async function effectiveMembers(profile) {
  if (profile.status !== STATUS.APPROVED) return [];

  const out = [];
  for (const row of await explicitMembers(profile.id)) {
    if (row.active_code === null) continue;
    out.push({
      emp_code: row.emp_code,
      name: row.name || row.member_name,
      sangh_name: row.sangh_name,
      designation: row.designation,
      email_id: row.email_id,
      source: 'assigned',
      assigned_by: row.assigned_by,
      assigned_by_name: row.assigned_by_name,
      assigned_at: row.assigned_at,
    });
  }
  return out.sort((x, y) =>
    String(x.name || '').localeCompare(String(y.name || ''), undefined, { sensitivity: 'base' }));
}

async function assignMembers(profileId, empCodes, actor) {
  const codes = [...new Set(empCodes.map((c) => String(c).trim()).filter(Boolean))];
  if (!codes.length) return [];

  const rows = await db.query(
    `SELECT emp_code, name FROM tbl_employee WHERE emp_code IN (?) AND status = ?`,
    [codes, ACTIVE]
  );
  const existing = (await db.query(
    'SELECT emp_code FROM rp_role_profile_members WHERE role_profile_id = ?',
    [profileId]
  )).map((r) => r.emp_code);

  const added = [];
  const now = nowStamp();
  for (const row of rows) {
    if (existing.includes(row.emp_code)) continue;
    await db.run(
      `INSERT INTO rp_role_profile_members
         (role_profile_id, emp_code, member_name, assigned_by, assigned_by_name, assigned_at)
       VALUES (?,?,?,?,?,?)`,
      [profileId, row.emp_code, row.name, actor.code || '', actor.name || '', now]
    );
    added.push({ emp_code: row.emp_code, name: row.name });
  }
  return added;
}

async function assignedMemberName(profileId, empCode) {
  const row = await db.first(
    'SELECT member_name FROM rp_role_profile_members WHERE role_profile_id = ? AND emp_code = ?',
    [profileId, empCode]
  );
  return row ? String(row.member_name) : '';
}

/** Returns false when there was no such row, so a no-op is not reported as success. */
async function unassignMember(profileId, empCode) {
  const res = await db.run(
    'DELETE FROM rp_role_profile_members WHERE role_profile_id = ? AND emp_code = ?',
    [profileId, empCode]
  );
  return res.affectedRows > 0;
}

/**
 * Every active member of the profile's sangh, for the admin to assign from: who is already
 * on this profile, who holds its designation (listed first — the likely picks), and which
 * other role profile, if any, someone is already assigned to.
 *
 * Not scoped by scope.sqlCondition — profile.sangh_code already pins this to one sangh,
 * so an LDP profile for SS/SS1 must still be able to assign its own members.
 */
async function assignableMembers(profile) {
  const onThis = new Set((await effectiveMembers(profile)).map((m) => m.emp_code));
  const elsewhere = new Map();
  for (const r of await db.query(
    `SELECT m.emp_code, p.id, p.designation_name
     FROM rp_role_profile_members m JOIN rp_role_profiles p ON p.id = m.role_profile_id
     WHERE m.role_profile_id <> ? AND p.status <> ?`, [profile.id, STATUS.REJECTED])) {
    if (!elsewhere.has(r.emp_code)) elsewhere.set(r.emp_code, { id: r.id, designation: r.designation_name });
  }

  const rows = await db.query(
    `SELECT emp_code, name, designation FROM tbl_employee
     WHERE status = ?
       AND sangh_code = ? AND TRIM(name) <> ''
     ORDER BY (TRIM(designation) = TRIM(?)) DESC, name ASC`,
    [ACTIVE, profile.sangh_code, profile.designation_name]
  );

  const wanted = String(profile.designation_name || '').trim().toLowerCase();
  return rows.map((r) => ({
    ...r,
    assigned: onThis.has(r.emp_code),
    holds_designation: String(r.designation || '').trim().toLowerCase() === wanted,
    other_profile: elsewhere.get(r.emp_code) || null,
  }));
}

/* ------------------------------------------------- leader scoping helpers */

function leaderPredicate() {
  return `(
        e.rp_approver_code = ?
     OR e.rp_creator_code = ?
     OR e.pracharak_code = ?
     OR (TRIM(e.pracharak_code) = '' AND ? <> '' AND e.pracharak_name = ?)
  )`;
}

/**
 * The sanghs someone writes role profiles for (and adds designations to).
 *
 * In a PSP sangh that is any sangh where they are RP Creator, RP Approver or Pracharak for an
 * active member. An LDP sangh (Sanghrakshak / Seva Sangh, SS/SS1) is narrower: only its RP
 * Creators — being someone's RP Approver there does not make them the one who writes LDP
 * role profiles. Not scoped by scope.sqlCondition otherwise, so LDP sanghs still come through.
 */
async function sanghsForLeader(empCode, personName = '') {
  return db.query(
    `SELECT e.sangh_code,
            COALESCE(MAX(NULLIF(TRIM(e.sangh_name), '')), e.sangh_code) AS sangh_name,
            COUNT(*) AS members
     FROM tbl_employee e
     WHERE e.status = ? AND TRIM(e.sangh_code) <> ''
       AND (
            (${scope.sqlCondition('e')} AND ${leaderPredicate()})
         OR (${scope.excludedSanghCondition('e')} AND e.rp_creator_code = ?)
       )
     GROUP BY e.sangh_code
     ORDER BY members DESC, sangh_name ASC`,
    [ACTIVE, empCode, empCode, empCode, personName, personName, empCode]
  );
}

/**
 * Designations that already have a role profile, keyed "sangh|designation".
 *
 * A rejected profile does not count — it was turned down, so the designation is free
 * again. Anything else (draft, in approval, approved) does, because two live profiles for
 * one designation would leave nobody able to say which one applies.
 */
async function takenDesignations(exceptId = null) {
  const rows = await db.query(
    `SELECT id, sangh_code, TRIM(designation_name) AS designation, status, created_by, created_by_name
     FROM rp_role_profiles
     WHERE status <> ? ${exceptId ? 'AND id <> ?' : ''}`,
    exceptId ? [STATUS.REJECTED, exceptId] : [STATUS.REJECTED]
  );

  const out = new Map();
  for (const row of rows) out.set(`${row.sangh_code}|${row.designation}`, row);
  return out;
}

/** The existing profile for a sangh + designation, if there is one. */
async function profileForDesignation(sanghCode, designation, exceptId = null) {
  return (await takenDesignations(exceptId)).get(`${sanghCode}|${String(designation).trim()}`) || null;
}

/**
 * Find the profile for a designation, for an outside system asking "does this role have a
 * role profile yet?".
 *
 * Matching is forgiving on purpose: the question comes from a form somebody typed into, so
 * case and stray spaces should not decide the answer. The sangh may be given as its code or
 * its name. A rejected profile does not count as having one.
 */
async function lookupByDesignation(sanghInput, designationInput) {
  const designation = String(designationInput || '').replace(/\s+/g, ' ').trim();
  const sangh = String(sanghInput || '').replace(/\s+/g, ' ').trim();
  if (designation === '') return null;

  const params = [STATUS.REJECTED, designation.toLowerCase()];
  let sanghClause = '';
  if (sangh !== '') {
    sanghClause = ' AND (LOWER(TRIM(p.sangh_code)) = ? OR LOWER(TRIM(p.sangh_name)) = ?)';
    params.push(sangh.toLowerCase(), sangh.toLowerCase());
  }

  return db.first(
    `SELECT p.* FROM rp_role_profiles p
     WHERE p.status <> ?
       AND LOWER(TRIM(p.designation_name)) = ?${sanghClause}
     ORDER BY FIELD(p.status, ?, ?, ?, ?) ASC, p.id DESC
     LIMIT 1`,
    [...params, STATUS.APPROVED, STATUS.PENDING_ADMIN, STATUS.PENDING_SEVAK, STATUS.DRAFT]
  );
}

/** Designations that exist in the member data, for checking a name before it is used. */
async function designationExists(sanghInput, designationInput) {
  const designation = String(designationInput || '').replace(/\s+/g, ' ').trim();
  const sangh = String(sanghInput || '').replace(/\s+/g, ' ').trim();
  if (designation === '') return null;

  const params = [ACTIVE, designation.toLowerCase()];
  let sanghClause = '';
  if (sangh !== '') {
    sanghClause = ' AND (LOWER(TRIM(e.sangh_code)) = ? OR LOWER(TRIM(e.sangh_name)) = ?)';
    params.push(sangh.toLowerCase(), sangh.toLowerCase());
  }

  return db.first(
    `SELECT TRIM(e.designation) AS designation, e.sangh_code, e.sangh_name, COUNT(*) AS members
     FROM tbl_employee e
     WHERE e.status = ? AND LOWER(TRIM(e.designation)) = ?${sanghClause}
     GROUP BY TRIM(e.designation), e.sangh_code, e.sangh_name
     ORDER BY members DESC LIMIT 1`,
    params
  );
}

const squash = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** PSP or LDP, by sangh: SS/SS1 (EXCLUDED_SANGHS) belong to LDP, everything else to PSP. */
function sanghProgram(sanghCode) {
  return scope.excluded().includes(String(sanghCode)) ? PROGRAM.LDP : PROGRAM.PSP;
}

/** Every sangh with active members, each tagged with its programme. */
async function allSanghs() {
  const rows = await db.query(
    `SELECT e.sangh_code,
            COALESCE(MAX(NULLIF(TRIM(e.sangh_name), '')), e.sangh_code) AS sangh_name,
            COUNT(*) AS members
     FROM tbl_employee e
     WHERE e.status = ? AND TRIM(e.sangh_code) <> ''
     GROUP BY e.sangh_code
     ORDER BY sangh_name ASC`,
    [ACTIVE]
  );
  return rows.map((r) => ({ ...r, program: sanghProgram(r.sangh_code) }));
}

/**
 * The sanghs someone may add designations to: the ones they lead, plus every PSP sangh for
 * the PSP Approver and every LDP sangh (SS/SS1) for the LDP Admin. `reach` is
 * { psp: isAdmin, ldp: isLdpAdmin }; a bare boolean is read as the PSP Approver flag.
 */
async function sanghsFor(empCode, personName = '', reach = {}) {
  const r = typeof reach === 'boolean' ? { psp: reach } : (reach || {});
  const out = new Map();
  for (const s of await sanghsForLeader(empCode, personName)) {
    out.set(s.sangh_code, { ...s, program: sanghProgram(s.sangh_code) });
  }
  if (r.psp || r.ldp) {
    for (const s of await allSanghs()) {
      if (out.has(s.sangh_code)) continue;
      if ((s.program === PROGRAM.PSP && r.psp) || (s.program === PROGRAM.LDP && r.ldp)) out.set(s.sangh_code, s);
    }
  }
  return [...out.values()].sort((a, b) =>
    a.program.localeCompare(b.program) * -1 || String(a.sangh_name).localeCompare(String(b.sangh_name)));
}

/**
 * Every designation a leader can write a profile for, by sangh: whatever has ever been held
 * in each sangh they lead — by current or former members — plus designations created in the
 * portal for that sangh (rp_designations). A designation nobody holds right now is still a
 * real role; its profile simply applies to nobody until someone holds it.
 *
 * Not scoped by scope.sqlCondition, same reason as sanghsForLeader().
 */
async function designationChoices(empCode, personName = '', sanghCode = '', reach = {}) {
  let sanghs = (await sanghsFor(empCode, personName, reach)).map((s) => s.sangh_code);
  if (sanghCode) sanghs = sanghs.includes(sanghCode) ? [sanghCode] : [];
  if (!sanghs.length) return [];

  // Two queries, not a UNION: tbl_employee is latin1 and rp_designations utf8mb4.
  const rows = [
    // BINARY keeps "Accounts Lead" and "Accounts lead" apart, so the spelling current
    // holders use comes first and is the one kept below.
    ...(await db.query(
      `SELECT sangh_code, TRIM(designation) AS designation, MAX(status = ?) AS active FROM tbl_employee
       WHERE sangh_code IN (?) AND TRIM(designation) <> ''
       GROUP BY sangh_code, BINARY TRIM(designation)
       ORDER BY active DESC, COUNT(*) DESC`, [ACTIVE, sanghs])),
    ...(await db.query(
      'SELECT sangh_code, designation_name AS designation FROM rp_designations WHERE sangh_code IN (?)',
      [sanghs])),
  ];

  // One entry per sangh + designation, however it was capitalised or spaced.
  const out = new Map();
  for (const r of rows) {
    const key = `${r.sangh_code}|${squash(r.designation).toLowerCase()}`;
    if (!out.has(key)) out.set(key, { sangh_code: String(r.sangh_code), designation: String(r.designation) });
  }
  return [...out.values()].sort((a, b) =>
    a.designation.localeCompare(b.designation, 'en', { sensitivity: 'base' }));
}

/** The designation as already known in that sangh, ignoring case and spacing, if it is. */
async function knownDesignation(empCode, personName, sanghCode, name, reach = {}) {
  const choices = await designationChoices(empCode, personName, sanghCode, reach);
  // The exact name, when it is one of them; only then the same name in another case.
  const exact = choices.find((d) => d.designation.trim() === String(name).trim());
  if (exact) return exact.designation;
  const wanted = squash(name).toLowerCase();
  const loose = choices.find((d) => squash(d.designation).toLowerCase() === wanted);
  return loose ? loose.designation : null;
}

/** Add a designation to a sangh, for a role that nobody has held there yet. */
async function createDesignation(sanghCode, name, actor) {
  await db.run(
    `INSERT INTO rp_designations (sangh_code, designation_name, created_by, created_by_name, created_at)
     VALUES (?,?,?,?,?)`,
    [sanghCode, name, actor.code, actor.name, nowStamp()]
  );
}

/**
 * Add a designation to one of this person's sanghs (any PSP sangh for the PSP Approver, any
 * LDP sangh for the LDP Admin), or hand
 * back the one already there if the name matches in any capitalisation or spacing.
 * Returns { ok, created, sangh, designation, message }.
 */
async function addDesignation(actor, sanghCode, rawName) {
  const name = squash(rawName);
  const reach = { psp: !!actor.isAdmin, ldp: !!actor.isLdpAdmin };
  const sangh = (await sanghsFor(actor.code, actor.name, reach)).find((s) => s.sangh_code === sanghCode);
  if (!sangh) return { ok: false, message: 'Choose one of your sanghs first.' };
  if ([...name].length < 2 || [...name].length > 100) {
    return { ok: false, message: 'A designation name needs 2 to 100 characters.' };
  }

  const known = await knownDesignation(actor.code, actor.name, sanghCode, name, reach);
  if (known !== null) {
    return { ok: true, created: false, sangh, designation: known.trim(),
      message: `"${known.trim()}" already exists in ${sangh.sangh_name}; it has been selected.` };
  }

  await createDesignation(sanghCode, name, actor);
  return { ok: true, created: true, sangh, designation: name, message: `"${name}" added to ${sangh.sangh_name}.` };
}

/**
 * The designations of the given sanghs for the Designations page: how many active members
 * hold each, whether only former members ever did, who created it in the portal, and whether
 * it already carries a role profile.
 */
async function designationOverview(sanghCodes) {
  if (!sanghCodes.length) return [];
  const held = await db.query(
    `SELECT sangh_code, TRIM(designation) AS designation, SUM(status = ?) AS active
     FROM tbl_employee
     WHERE sangh_code IN (?) AND TRIM(designation) <> ''
     GROUP BY sangh_code, BINARY TRIM(designation)
     ORDER BY active DESC`, [ACTIVE, sanghCodes]);
  const created = await db.query(
    `SELECT sangh_code, designation_name AS designation, created_by, created_by_name, created_at
     FROM rp_designations WHERE sangh_code IN (?)`, [sanghCodes]);
  const taken = await takenDesignations();

  const out = new Map();
  const entry = (sanghCode, designation) => {
    const key = `${sanghCode}|${squash(designation).toLowerCase()}`;
    if (!out.has(key)) {
      out.set(key, { sangh_code: String(sanghCode), designation: String(designation), active: 0, held: false,
        created: null, program: sanghProgram(sanghCode) });
    }
    return out.get(key);
  };
  for (const r of held) {
    const e = entry(r.sangh_code, r.designation);
    e.active += Number(r.active);
    e.held = true;
  }
  for (const r of created) {
    entry(r.sangh_code, r.designation).created = {
      by: r.created_by_name || r.created_by, code: r.created_by, at: r.created_at,
    };
  }
  for (const e of out.values()) {
    const has = taken.get(`${e.sangh_code}|${e.designation.trim()}`);
    e.profile = has ? { id: has.id, status: has.status } : null;
  }
  return [...out.values()].sort((a, b) =>
    -a.program.localeCompare(b.program) || a.sangh_code.localeCompare(b.sangh_code) || a.designation.localeCompare(b.designation, 'en', { sensitivity: 'base' }));
}

// Not scoped by scope.sqlCondition, same reason as sanghsForLeader() above.
async function designationsForLeader(empCode, personName = '', sanghCode = '') {
  const params = [ACTIVE, empCode, empCode, empCode, personName, personName];
  let extra = '';
  if (String(sanghCode).trim() !== '') {
    extra = ' AND e.sangh_code = ?';
    params.push(sanghCode);
  }

  return db.query(
    `SELECT e.sangh_code, TRIM(e.designation) AS designation, COUNT(*) AS members
     FROM tbl_employee e
     WHERE e.status = ?
       AND TRIM(e.designation) <> '' AND TRIM(e.sangh_code) <> ''
       AND ${leaderPredicate()}${extra}
     GROUP BY e.sangh_code, designation
     ORDER BY members DESC, designation ASC`,
    params
  );
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = {
  MAX_OUTCOMES, MAX_ATTRIBUTES, MAX_SKILLS_PER_ATTR, TOTAL_WEIGHT,
  MIN_OUTCOMES_LDP, MAX_OUTCOMES_LDP, PROGRAM,
  STATUS, STATUS_LABELS,
  createProfile, updateProfile, find, fullProfile,
  visibleTo, canView, canEdit, skippedRpApprover, finalApprover, isFinalApprover, statusLabel, isPendingEdit, canSubmit, isRevision, awaiting, canActOn,
  membersWithDesignation, explicitMembers, effectiveMembers,
  assignMembers, assignedMemberName, unassignMember, assignableMembers,
  sanghsForLeader, designationsForLeader, takenDesignations, profileForDesignation,
  lookupByDesignation, designationExists, designationChoices, knownDesignation, createDesignation,
  sanghProgram, allSanghs, sanghsFor, addDesignation, designationOverview,
  nowStamp,
};
