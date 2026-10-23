'use strict';
const express = require('express');
const roleProfile = require('../models/roleProfile');
const assessment = require('../models/assessment');
const ldpAssessment = require('../models/ldpAssessment');
const ldp = require('../models/ldp');
const financialYear = require('../models/financialYear');
const history = require('../models/history');
const notification = require('../models/notification');
const mw = require('../middleware');

const router = express.Router();
router.use(mw.loggedIn);

const me = (req) => ({
  code: req.session.emp_code || '',
  name: req.session.emp_name || '',
  isAdmin: !!req.session.is_admin,
});
const num = (v) => String(Math.round(Number(v) * 100) / 100).replace(/\.00$/, '');

/** The year in play: whatever was asked for if real, otherwise the current one. */
async function chosenYear(req) {
  const asked = String(req.query.fy || req.body.financial_year || '').trim();
  return asked && (await financialYear.isValid(asked)) ? asked : financialYear.current();
}

/**
 * LDP rows carry their own self/leader stage instead of PSP's single can_assess flag —
 * worked out here per row rather than inside assessment.overviewFor(), which stays PSP's.
 */
async function annotateLdpRow(r, actor) {
  const a = r.assessment;
  const leader = await ldp.resolveLeader(r.emp_code);
  const selfSubmitted = !!(a && a.self_submitted_at);
  const finalSubmitted = !!(a && a.final_submitted_at);
  const isSelf = actor.code === r.emp_code;
  const isLeader = !!(leader && actor.code === leader.code);

  r.ldp_leader_name = leader ? leader.name : '';
  if (finalSubmitted) r.ldp_stage = 'done';
  else if (!selfSubmitted) r.ldp_stage = isSelf ? 'self' : 'awaiting-self';
  else r.ldp_stage = (isLeader || actor.isAdmin) ? 'final' : 'awaiting-leader';
  r.can_assess = r.ldp_stage === 'self' || r.ldp_stage === 'final';
}

/** One place to see and do assessments, whoever is signed in, one year at a time. */
router.get('/', async (req, res) => {
  const actor = me(req);
  const chosen = await chosenYear(req);

  // Arriving from a role profile's Assess button narrows the list to that profile.
  const onlyProfile = Number(req.query.profile) || 0;
  let rows = await assessment.overviewFor(actor.code, actor.isAdmin, chosen);

  // A leader is not necessarily the RP Creator, RP Approver or the member, so
  // overviewFor() alone would miss the LDP rows waiting on them.
  const seen = new Set(rows.map((r) => `${r.profile_id}|${r.emp_code}`));
  if (!actor.isAdmin) {
    for (const r of await ldpAssessment.overviewForLeader(actor.code, chosen)) {
      const key = `${r.profile_id}|${r.emp_code}`;
      if (seen.has(key)) continue;
      rows.push(r);
      seen.add(key);
    }
  }
  for (const r of rows) {
    if (r.program === 'ldp') await annotateLdpRow(r, actor);
  }
  let narrowedTo = null;
  if (onlyProfile) {
    const match = rows.filter((r) => r.profile_id === onlyProfile);
    // Only narrow when it actually holds something, so the link never leads nowhere.
    if (match.length) {
      narrowedTo = { id: onlyProfile, name: match[0].designation_name, sangh: match[0].sangh_name };
      rows = match;
    }
  }

  await res.page('assessments/list', {
    rows,
    narrowedTo,
    years: await financialYear.years(),
    chosen,
    current: await financialYear.current(),
    previous: await financialYear.previous(),
    yearOpen: await financialYear.isOpen(chosen),
    title: `Assessments ${chosen} — Pakka Role Profile`,
    pageTitle: `Assessments · ${chosen}`,
    activeNav: 'assessments',
  });
});

module.exports = router;
module.exports.chosenYear = chosenYear;
module.exports.me = me;
module.exports.num = num;
