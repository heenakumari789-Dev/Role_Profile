'use strict';
const express = require('express');
const employee = require('../models/employee');
const mw = require('../middleware');

const router = express.Router();

router.get('/', mw.loggedIn, async (req, res) => {
  const members = await employee.membersLedBy(req.session.emp_code, req.session.emp_name || '');

  // The nav hides this page for someone with nobody under them; keep the URL consistent.
  if (!members.length) return res.redirect(await mw.landingUrl(req));

  const roles = { rp_approver: 0, rp_creator: 0, pracharak: 0 };
  for (const m of members) {
    for (const role of Object.keys(roles)) if (Number(m[`is_my_${role}`])) roles[role]++;
  }

  const bySangh = {};
  for (const m of members) {
    const key = String(m.sangh_name || '').trim() || String(m.sangh_code || '').trim() || 'No sangh recorded';
    (bySangh[key] = bySangh[key] || []).push(m);
  }

  await res.page('my_members', {
    members, roles, bySangh,
    title: 'My Members — Pakka Role Profile',
    pageTitle: 'My Members',
    activeNav: 'my-members',
  });
});

module.exports = router;
