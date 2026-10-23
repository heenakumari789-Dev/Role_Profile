'use strict';
const express = require('express');
const employee = require('../models/employee');
const leader = require('../models/leader');
const ldp = require('../models/ldp');
const mw = require('../middleware');

const router = express.Router();
router.use(mw.ldpAdminAuth);

const label = (role) => (employee.ROLES[role] ? employee.ROLES[role].label : role);

/** Resolve a submitted person against the active members. Empty means unassign. */
async function resolvePerson(role, personCode) {
  if (personCode === '') return { code: '', name: '', error: null };

  const members = await leader.memberCandidates();
  const found = members.find((c) => (c.emp_code !== '' ? c.emp_code : c.name) === personCode);
  if (!found) return { code: '', name: '', error: 'That person is not an active member.' };
  return { code: found.emp_code, name: found.name, error: null };
}

const fail = (res, message) => res.status(422).json({ ok: false, message });

router.get('/', async (req, res) => {
  const members = await ldp.activeMembers();
  const counts = { rp_approver: 0, rp_creator: 0, pracharak: 0 };
  for (const m of members) {
    for (const [role, cols] of Object.entries(employee.ROLES)) {
      if (String(m[cols.name] || '').trim() !== '') counts[role]++;
    }
  }

  await res.page('ldp_assign', {
    members, counts, roles: employee.ROLES,
    candidates: await leader.allCandidates(),
    sanghLeaders: await leader.sanghLeaderMap(),
    title: 'LDP Members — Pakka Role Profile',
    pageTitle: 'Assign Roles · LDP Members',
    activeNav: 'ldp-assign',
  });
});

router.post('/save', async (req, res) => {
  const empCode = String(req.body.emp_code || '').trim();
  const role = String(req.body.role || '').trim();
  const personCode = String(req.body.person_code || '').trim();

  if (!empCode || !employee.ROLES[role]) return fail(res, 'Unknown member or role.');
  if (!(await ldp.findActiveByCode(empCode))) return fail(res, 'That member is not an active LDP member.');

  const person = await resolvePerson(role, personCode);
  if (person.error) return fail(res, person.error);

  await ldp.setAssignment(empCode, role, person.code, person.name);

  res.json({
    ok: true, role, emp_code: empCode,
    person_code: person.code, person_name: person.name,
    message: person.name === ''
      ? `${label(role)} unassigned.`
      : `${label(role)} set to ${person.name}.`,
  });
});

module.exports = router;
