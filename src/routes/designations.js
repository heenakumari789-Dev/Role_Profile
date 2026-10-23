'use strict';
const express = require('express');
const roleProfile = require('../models/roleProfile');
const mw = require('../middleware');

/**
 * Designations, sangh by sangh, and adding a new one for a role nobody has held yet.
 * Open to RP Creators and RP Approvers (their own sanghs), the PSP Approver (every PSP
 * sangh) and the LDP Admin (the LDP sanghs, SS/SS1). What is added here shows in the Create form's designation list straight away.
 */
const router = express.Router();
router.use(mw.loggedIn);

const me = (req) => ({
  code: req.session.emp_code || '',
  name: req.session.emp_name || '',
  isAdmin: !!req.session.is_admin,
  isLdpAdmin: !!req.session.is_ldp_admin,
});

/** Only someone with a sangh to add to may use this page. */
async function allowedSanghs(req, res) {
  const actor = me(req);
  const sanghs = await roleProfile.sanghsFor(actor.code, actor.name, { psp: actor.isAdmin, ldp: actor.isLdpAdmin });
  if (!sanghs.length) {
    req.session.flashError = 'Designations are managed by RP Creators, RP Approvers, the PSP Approver and the LDP Admin.';
    res.redirect('/role-profiles');
    return null;
  }
  return sanghs;
}

router.get('/', async (req, res) => {
  const sanghs = await allowedSanghs(req, res);
  if (!sanghs) return;

  // One sangh at a time when there are many (the PSP Approver sees them all).
  const asked = String(req.query.sangh || '').trim();
  const chosen = sanghs.some((s) => s.sangh_code === asked) ? asked
    : (sanghs.length === 1 ? sanghs[0].sangh_code : '');
  const shown = chosen ? [chosen] : sanghs.map((s) => s.sangh_code);

  await res.page('designations', {
    sanghs,
    chosen,
    rows: await roleProfile.designationOverview(shown),
    sanghNames: Object.fromEntries(sanghs.map((s) => [s.sangh_code, s.sangh_name])),
    programLabels: { psp: 'PSP', ldp: 'LDP' },
    statusLabels: roleProfile.STATUS_LABELS,
    title: 'Designations — Pakka Role Profile',
    pageTitle: 'Designations',
    activeNav: 'designations',
  });
});

router.post('/', async (req, res) => {
  const sanghCode = String(req.body.sangh_code || '').trim();
  const back = `/designations${sanghCode ? `?sangh=${encodeURIComponent(sanghCode)}` : ''}`;
  const result = await roleProfile.addDesignation(me(req), sanghCode, req.body.designation_name);

  if (!result.ok) req.session.flashError = result.message;
  else req.session.flashSuccess = result.created
    ? `${result.message} It is now in the designation list when creating a role profile for ${result.sangh.sangh_name}.`
    : `"${result.designation}" already exists in ${result.sangh.sangh_name}, so nothing was added.`;
  res.redirect(back);
});

module.exports = router;
