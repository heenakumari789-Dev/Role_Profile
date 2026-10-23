'use strict';
/**
 * An LDP role profile (Sanghrakshak / Seva Sangh) gets its final approval from the LDP
 * Admin, not the PSP Approver. Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';
// A separate LDP Admin, so the PSP Approver and the LDP Admin are different people here.
process.env.LDP_ADMIN_CODES = 'LDPTEST';

const http = require('http');
const { build, signIn, get, SESSIONS } = require('./smoke');
const db = require('../src/lib/db');
const roleProfile = require('../src/models/roleProfile');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};
function post(port, path, who, form) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (Array.isArray(v)) v.forEach((one) => params.append(k, one)); else params.append(k, v);
  }
  params.append('csrf_test_name', 'test-token');
  const body = params.toString();
  return new Promise((r) => {
    const req = http.request({ port, path, method: 'POST', headers: {
      'x-test-user': who, 'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => r({ status: res.statusCode, location: res.headers.location || '' })); });
    req.end(body);
  });
}
const ldpForm = (designation, mission) => ({
  sangh_code: 'SS', designation_name: designation, mission, action: 'submit',
  outcomes: ['Outcome one', 'Outcome two', 'Outcome three'],
  'attribute[0]': 'Leadership', 'attribute_weight[0]': '100', 'assessment[0]': 'Observation',
  'tech_skill[0][]': 'Mentoring', 'tech_weight[0][]': '100',
});
const notes = async (id, code) => (await db.query(
  'SELECT title FROM rp_notifications WHERE role_profile_id = ? AND emp_code = ?', [id, code])).map((n) => n.title);
const flash = (who, kind) => { const v = SESSIONS[who][kind]; delete SESSIONS[who][kind]; return v; };

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  const app = build(); const server = app.listen(0); const port = server.address().port;
  const PSP = { code: 'MM008', name: 'LMS', isAdmin: true };
  const LDP = { code: 'LDPTEST', name: 'LDP Admin', isAdmin: false };
  // An RP Creator for Sanghrakshak Sangh members — only they write LDP profiles there.
  const CREATOR = { code: 'M01156', name: 'Deepak Kumar Ramsundar Pandey', isAdmin: false };
  const appr = await db.first('SELECT rp_approver_code c, rp_approver_name n FROM tbl_employee WHERE emp_code = ?', [CREATOR.code]);
  const APPROVER = { code: appr.c, name: appr.n, isAdmin: false };
  [PSP, LDP, CREATOR, APPROVER].forEach(signIn);
  SESSIONS[LDP.code].is_ldp_admin = true;
  check('the creator has an RP Approver and is an SS RP Creator', !!APPROVER.code
    && (await roleProfile.sanghsForLeader(CREATOR.code, CREATOR.name)).some((s) => s.sangh_code === 'SS'), true);

  const desig = `LDP Flow Head ${Date.now()}`;
  await roleProfile.createDesignation('SS', desig, CREATOR);

  /* --------------------------------------------- RP Approver, then LDP Admin */
  await post(port, '/role-profiles/store', CREATOR.code, ldpForm(desig, 'LDP mission'));
  const id = (await db.first('SELECT MAX(id) id FROM rp_role_profiles')).id;
  const row = () => db.first('SELECT * FROM rp_role_profiles WHERE id = ?', [id]);
  check('LDP profile, with the RP Approver first', `${(await row()).program}|${(await row()).status}`, 'ldp|pending_sevak');

  await post(port, `/role-profiles/${id}/decide`, APPROVER.code, { action: 'approve' });
  check('RP Approver passes it to the LDP Admin', flash(APPROVER.code, 'flashSuccess'), 'Approved and passed to the LDP Admin.');
  check('now at the final stage', (await row()).status, 'pending_admin');
  check('LDP Admin is asked', (await notes(id, LDP.code)).includes('Role profile needs LDP Admin approval'), true);
  check('PSP Approver is not', (await notes(id, PSP.code)).length, 0);
  check('creator is told it is with the LDP Admin', (await db.first(
    "SELECT body FROM rp_notifications WHERE role_profile_id = ? AND emp_code = ? AND title = 'Your role profile passed RP Approver approval'",
    [id, CREATOR.code])).body.endsWith('is now with the LDP Admin.'), true);

  const list = (await get(port, '/role-profiles', CREATOR.code)).body;
  check('list reads "Awaiting LDP Admin"', list.includes('Awaiting LDP Admin') && list.includes('with LDP Admin'), true);
  const show = (await get(port, `/role-profiles/${id}`, CREATOR.code)).body;
  check('timeline names the LDP Admin', show.includes('<div class="l">LDP Admin</div>'), true);

  /* ------------------------------------------------- the PSP Approver is out */
  check('not in the PSP Approver\'s queue', (await roleProfile.awaiting(PSP.code, true, false)).some((p) => p.id === id), false);
  await post(port, `/role-profiles/${id}/decide`, PSP.code, { action: 'approve' });
  check('PSP Approver cannot approve it', flash(PSP.code, 'flashError'), 'This profile is not waiting on you.');
  await get(port, `/role-profiles/${id}/edit`, PSP.code);
  check('...nor edit it', flash(PSP.code, 'flashError'),
    'The RP Approver has approved this role profile, so only the LDP Admin can edit it now.');

  /* ---------------------------------------------------- the LDP Admin is in */
  check('in the LDP Admin\'s queue', (await roleProfile.awaiting(LDP.code, false, true)).some((p) => p.id === id), true);
  const ldpShow = await get(port, `/role-profiles/${id}`, LDP.code);
  check('LDP Admin sees the decision box', ldpShow.body.includes('This profile is waiting on you'), true);
  await post(port, `/role-profiles/${id}/update`, LDP.code, { ...ldpForm(desig, 'Edited by the LDP Admin'), action: 'save' });
  check('LDP Admin edits before approving', flash(LDP.code, 'flashSuccess'), 'Changes saved. It is still awaiting the LDP Admin.');
  await post(port, `/role-profiles/${id}/decide`, LDP.code, { action: 'approve' });
  const done = await row();
  check('LDP Admin gives final approval', `${done.status}|${done.admin_action_by}`, 'approved|LDPTEST');
  check('version carries the LDP Admin edit', (await db.first(
    'SELECT mission FROM rp_profile_versions WHERE role_profile_id = ?', [id])).mission, 'Edited by the LDP Admin');

  /* ---------------------------------- no RP Approver: straight to the LDP Admin */
  await db.run('UPDATE tbl_employee SET rp_approver_code = emp_code WHERE emp_code = ?', [CREATOR.code]);
  const solo = `LDP Solo Head ${Date.now()}`;
  await roleProfile.createDesignation('SS', solo, CREATOR);
  await post(port, '/role-profiles/store', CREATOR.code, ldpForm(solo, 'Solo LDP'));
  check('flash names the LDP Admin', flash(CREATOR.code, 'flashSuccess'),
    'Submitted for LDP Admin approval (you have no separate RP Approver on record).');
  const soloId = (await db.first('SELECT MAX(id) id FROM rp_role_profiles')).id;
  check('history says so', (await db.first(
    "SELECT note FROM rp_role_profile_history WHERE role_profile_id = ? AND action = 'submitted'", [soloId])).note,
    'Sent straight to the LDP Admin');
  check('LDP Admin asked, PSP Approver not',
    `${(await notes(soloId, LDP.code)).length}|${(await notes(soloId, PSP.code)).length}`, '1|0');
  await db.run('UPDATE tbl_employee SET rp_approver_code = ? WHERE emp_code = ?', [APPROVER.code, CREATOR.code]);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
