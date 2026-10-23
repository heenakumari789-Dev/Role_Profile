'use strict';
/**
 * The PSP Approver and the LDP Admin can write role profiles for the sanghs they oversee.
 * Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';
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
const form = (sangh, designation, mission) => ({
  sangh_code: sangh, designation_name: designation, mission, action: 'submit',
  outcomes: ['Outcome one', 'Outcome two', 'Outcome three'],
  'attribute[0]': 'Leadership', 'attribute_weight[0]': '100', 'assessment[0]': 'Observation',
  'tech_skill[0][]': 'Mentoring', 'tech_weight[0][]': '100',
});
const flash = (who, kind) => { const v = SESSIONS[who][kind]; delete SESSIONS[who][kind]; return v; };
const latest = () => db.first('SELECT * FROM rp_role_profiles WHERE id = (SELECT MAX(id) FROM rp_role_profiles)');

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  const app = build(); const server = app.listen(0); const port = server.address().port;
  const PSP = { code: 'MM008', name: 'LMS', isAdmin: true };
  const LDP = { code: 'LDPTEST', name: 'LDP Admin', isAdmin: false };
  [PSP, LDP].forEach(signIn);
  SESSIONS[LDP.code].is_ldp_admin = true;
  const stamp = Date.now();

  /* ------------------------------------------------------- the PSP Approver */
  check('list offers Create', (await get(port, '/role-profiles', PSP.code)).body.includes('/role-profiles/create'), true);
  const page = await get(port, '/role-profiles/create', PSP.code);
  check('Create form opens', page.status, 200);
  check('...with PSP sanghs', page.body.includes('<option value="VSS"'), true);
  check('...and no LDP ones', page.body.includes('<option value="SS"'), false);
  check('...saying it comes back to them', page.body.includes('You give final approval yourself'), true);

  const pspDesig = `Admin PSP Head ${stamp}`;
  await roleProfile.createDesignation('VSS', pspDesig, PSP);
  await post(port, '/role-profiles/store', PSP.code, form('VSS', pspDesig, 'Written by the PSP Approver'));
  check('saved', flash(PSP.code, 'flashSuccess'), 'Submitted for PSP Approver approval (you have no separate RP Approver on record).');
  let p = await latest();
  check('a PSP profile, by the PSP Approver, at final approval', `${p.designation_name}|${p.program}|${p.created_by}|${p.status}`,
    `${pspDesig}|psp|MM008|pending_admin`);
  await post(port, `/role-profiles/${p.id}/decide`, PSP.code, { action: 'approve' });
  check('the PSP Approver approves it', (await latest()).status, 'approved');

  await post(port, '/role-profiles/store', PSP.code, form('SS', 'Anything', 'Not theirs'));
  check('not in an LDP sangh', flash(PSP.code, 'flashError'),
    'That designation does not exist in that sangh. Create it with "+ New designation" first.');

  check('clone opens for them', (await get(port, `/role-profiles/${p.id}/clone`, PSP.code)).status, 200);

  /* ------------------------------------------------------------ the LDP Admin */
  const ldpPage = await get(port, '/role-profiles/create', LDP.code);
  check('LDP Admin opens the Create form', ldpPage.status, 200);
  check('...with SS and SS1 only', ldpPage.body.includes('<option value="SS"') && ldpPage.body.includes('<option value="SS1"')
    && !ldpPage.body.includes('<option value="VSS"'), true);
  const ldpDesig = `Admin LDP Head ${stamp}`;
  await roleProfile.createDesignation('SS1', ldpDesig, LDP);
  await post(port, '/role-profiles/store', LDP.code, form('SS1', ldpDesig, 'Written by the LDP Admin'));
  check('saved', flash(LDP.code, 'flashSuccess'), 'Submitted for LDP Admin approval (you have no separate RP Approver on record).');
  p = await latest();
  check('an LDP profile, with the LDP Admin', `${p.program}|${p.status}`, 'ldp|pending_admin');
  check('the PSP Approver cannot approve it', (await roleProfile.awaiting(PSP.code, true, false)).some((x) => x.id === p.id), false);
  await post(port, `/role-profiles/${p.id}/decide`, LDP.code, { action: 'approve' });
  check('the LDP Admin approves it', (await latest()).status, 'approved');

  /* ------------------------------------------------- a member still cannot */
  signIn({ code: 'M01078', name: 'Heena Kumari', isAdmin: false });
  const member = await get(port, '/role-profiles/create', 'M01078');
  check('a plain member is still sent away', member.location, '/role-profiles');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
