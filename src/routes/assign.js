'use strict';
const express = require('express');
const employee = require('../models/employee');
const leader = require('../models/leader');
const sangh = require('../models/sangh');
const mw = require('../middleware');

const router = express.Router();
router.use(mw.adminAuth);

const label = (role) => (employee.ROLES[role] ? employee.ROLES[role].label : role);

/**
 * Resolve a submitted person against the active members. Empty means unassign.
 *
 * `sanghCode` restricts the choice to that sangh's own members, which is what assigning to
 * a whole sangh means; without it any active member is allowed.
 */
async function resolvePerson(role, personCode, sanghCode = '') {
  if (personCode === '') return { code: '', name: '', error: null };

  const members = await leader.memberCandidates();
  const found = members.find((c) => (c.emp_code !== '' ? c.emp_code : c.name) === personCode);
  if (!found) {
    return { code: '', name: '', error: 'That person is not an active member.' };
  }
  if (sanghCode && String(found.sangh_code || '').trim() !== sanghCode) {
    return {
      code: '', name: '',
      error: `${found.name} is not a member of ${sanghCode}. Assigning to a whole sangh `
        + `can only pick that sangh's own active members.`,
    };
  }
  return { code: found.emp_code, name: found.name, error: null };
}

const fail = (res, message) => res.status(422).json({ ok: false, message });

/* ------------------------------------------------------------ by member */

router.get('/', async (req, res) => {
  const members = await employee.getDirectory();
  const counts = { rp_approver: 0, rp_creator: 0, pracharak: 0 };
  for (const m of members) {
    for (const [role, cols] of Object.entries(employee.ROLES)) {
      if (String(m[cols.name] || '').trim() !== '') counts[role]++;
    }
  }

  await res.page('assign_member', {
    members, counts, roles: employee.ROLES,
    candidates: await leader.allCandidates(),
    sanghLeaders: await leader.sanghLeaderMap(),
    title: 'Assign by Member — Pakka Role Profile',
    pageTitle: 'Assign Roles by Member',
    activeNav: 'assign-member',
  });
});

router.post('/save', async (req, res) => {
  const empCode = String(req.body.emp_code || '').trim();
  const role = String(req.body.role || '').trim();
  const personCode = String(req.body.person_code || '').trim();

  if (!empCode || !employee.ROLES[role]) return fail(res, 'Unknown member or role.');
  if (!(await employee.findActiveByCode(empCode))) return fail(res, 'That member is not an active member.');

  const person = await resolvePerson(role, personCode);
  if (person.error) return fail(res, person.error);

  await employee.setAssignment(empCode, role, person.code, person.name);

  res.json({
    ok: true, role, emp_code: empCode,
    person_code: person.code, person_name: person.name,
    message: person.name === ''
      ? `${label(role)} unassigned.`
      : `${label(role)} set to ${person.name}.`,
  });
});

/* ------------------------------------------------------------- by sangh */

router.get('/sangh', async (req, res) => {
  await res.page('assign_sangh', {
    sanghs: await sangh.summary(),
    roles: employee.ROLES,
    candidates: await leader.allCandidates(),
    sanghLeaders: await leader.sanghLeaderMap(),
    title: 'Assign by Sangh — Pakka Role Profile',
    pageTitle: 'Assign Roles by Sangh',
    activeNav: 'assign-sangh',
  });
});

router.post('/save-sangh', async (req, res) => {
  const sanghCode = String(req.body.sangh_code || '').trim();
  const role = String(req.body.role || '').trim();
  const personCode = String(req.body.person_code || '').trim();

  if (!sanghCode || !employee.ROLES[role]) return fail(res, 'Unknown sangh or role.');
  if ((await sangh.memberCount(sanghCode)) === 0) return fail(res, 'That sangh has no active members.');

  const person = await resolvePerson(role, personCode, sanghCode);
  if (person.error) return fail(res, person.error);

  const affected = await sangh.assignToSangh(sanghCode, role, person.code, person.name);
  const what = person.name === ''
    ? `${label(role)} cleared`
    : `${label(role)} set to ${person.name}`;

  res.json({
    ok: true, role, sangh_code: sanghCode,
    person_code: person.code, person_name: person.name, affected,
    message: `${what} for ${affected} member${affected === 1 ? '' : 's'}.`,
  });
});

/** Drill into one sangh to assign roles to a chosen subset of its members. */
router.get('/sangh/:code', async (req, res) => {
  const sanghCode = req.params.code;
  const members = await employee.membersOfSangh(sanghCode);
  if (!members.length) {
    req.session.flashError = 'That sangh has no active members.';
    return res.redirect('/assign/sangh');
  }

  const named = members.find((m) => String(m.sangh_name || '').trim() !== '');
  await res.page('assign_sangh_members', {
    members, sanghCode,
    sanghName: named ? named.sangh_name : sanghCode,
    roles: employee.ROLES,
    candidates: await leader.allCandidates(),
    sanghLeaders: await leader.sanghLeaderMap(),
    title: `${sanghCode} — Assign Roles`,
    pageTitle: `Assign Roles · ${named ? named.sangh_name : sanghCode}`,
    activeNav: 'assign-sangh',
  });
});

router.post('/save-bulk', async (req, res) => {
  const raw = req.body['emp_codes'] || req.body['emp_codes[]'] || [];
  const empCodes = (Array.isArray(raw) ? raw : [raw]).map((c) => String(c).trim()).filter(Boolean);
  const role = String(req.body.role || '').trim();
  const personCode = String(req.body.person_code || '').trim();

  if (!empCodes.length || !employee.ROLES[role]) return fail(res, 'Select at least one member and a role.');

  const person = await resolvePerson(role, personCode);
  if (person.error) return fail(res, person.error);

  const affected = await employee.assignMany(empCodes, role, person.code, person.name);
  const what = person.name === ''
    ? `${label(role)} cleared`
    : `${label(role)} set to ${person.name}`;

  res.json({
    ok: true, role, emp_codes: empCodes,
    person_code: person.code, person_name: person.name, affected,
    message: `${what} for ${affected} member${affected === 1 ? '' : 's'}.`,
  });
});

module.exports = router;
