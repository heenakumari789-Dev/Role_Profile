'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const roleProfile = require('../models/roleProfile');
const version = require('../models/version');
const financialYear = require('../models/financialYear');

/**
 * A small read-only API for Zoho Recruit.
 *
 * The MRF form asks: does this designation already have a role profile? The answer carries
 * a link straight to it, or a link to create one with the sangh and designation already
 * filled in. Nothing here writes, and nothing here returns assessment data — scores belong
 * to the member, not to a recruitment record.
 */
const router = express.Router();

/** Constant-time compare, so a wrong token cannot be guessed a character at a time. */
function tokenMatches(sent) {
  const expected = config.apiToken;
  if (!expected || !sent) return false;
  const a = Buffer.from(String(sent));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  // No token configured means the API stays shut, rather than open by accident.
  if (!config.apiToken) {
    return res.status(503).json({ ok: false, error: 'This API is not switched on.' });
  }
  const sent = req.get('X-API-Token')
    || (String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''))
    || req.query.token;
  if (!tokenMatches(sent)) {
    return res.status(401).json({ ok: false, error: 'Bad or missing token.' });
  }
  res.set('Cache-Control', 'no-store');
  next();
});

const absolute = (req, path) => `${config.publicUrl || `${req.protocol}://${req.get('host')}`}${path}`;

/**
 * GET /api/role-profile?sangh=DVS&designation=Web%20Development%20Head
 *
 * found     — the designation has a role profile; `url` opens it
 * not_found — it has none; `create_url` opens the form ready to write one
 */
router.get('/role-profile', async (req, res) => {
  const sangh = String(req.query.sangh || '').trim();
  const designation = String(req.query.designation || '').trim();

  if (!designation) {
    return res.status(400).json({ ok: false, error: 'Give a designation to look up.' });
  }

  const profile = await roleProfile.lookupByDesignation(sangh, designation);

  if (!profile) {
    const known = await roleProfile.designationExists(sangh, designation);
    const query = new URLSearchParams({ designation });
    if (sangh) query.set('sangh', sangh);
    if (req.query.mrf) query.set('mrf', String(req.query.mrf));

    return res.json({
      ok: true,
      status: 'not_found',
      designation,
      sangh: sangh || null,
      // Whether anybody actually holds this designation, so a typo can be told from a gap.
      designation_in_use: !!known,
      members_holding: known ? Number(known.members) : 0,
      matched_sangh: known ? { code: known.sangh_code, name: known.sangh_name } : null,
      create_url: absolute(req, `/role-profiles/create?${query.toString()}`),
      message: known
        ? `No role profile yet for "${designation}". ${known.members} member(s) hold it.`
        : `No role profile for "${designation}", and nobody active holds that designation — check the spelling.`,
    });
  }

  const latest = await version.latestFor(profile.id);
  const fy = await financialYear.current();
  const review = latest ? await version.reviewFor(profile.id, fy) : null;

  res.json({
    ok: true,
    status: 'found',
    id: Number(profile.id),
    designation: profile.designation_name,
    sangh: { code: profile.sangh_code, name: profile.sangh_name },
    profile_status: profile.status,
    is_approved: profile.status === roleProfile.STATUS.APPROVED,
    mission: profile.mission || '',
    written_by: profile.created_by_name || profile.created_by,
    version: latest ? Number(latest.version_no) : null,
    version_approved_at: latest ? latest.approved_at : null,
    financial_year: fy,
    reviewed_this_year: !!review,
    url: absolute(req, `/role-profiles/${profile.id}`),
    pdf_url: profile.status === roleProfile.STATUS.APPROVED
      ? absolute(req, `/role-profiles/${profile.id}/pdf`)
      : null,
    message: profile.status === roleProfile.STATUS.APPROVED
      ? `Role profile v${latest ? latest.version_no : 1} is in force.`
      : `A role profile exists but is ${roleProfile.statusLabel(profile)}.`,
  });
});

/** GET /api/ping — for checking the token and that the portal is reachable. */
router.get('/ping', (req, res) => res.json({ ok: true, portal: 'Pakka Role Profile' }));

module.exports = router;
