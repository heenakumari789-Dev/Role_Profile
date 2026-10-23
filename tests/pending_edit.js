'use strict';
/**
 * Editing a role profile while it waits for approval, level by level.
 * Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const http = require('http');
const { build, signIn, get, freeDesignations, SESSIONS } = require('./smoke');
const db = require('../src/lib/db');

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

function profileForm(designation, sangh, mission, action) {
  return {
    sangh_code: sangh, designation_name: designation, mission, action,
    outcomes: ['Uptime 99%', '', 'Tickets closed in 24h', 'Audit clean'],
    'attribute[0]': 'Systems Support', 'attribute_weight[0]': '60', 'assessment[0]': '',
    'tech_skill[0][]': ['Hardware triage', 'Network basics'], 'tech_weight[0][]': ['30', '30'],
    'attribute[1]': 'Documentation', 'attribute_weight[1]': '40', 'assessment[1]': '',
    'tech_skill[1][]': ['SOP writing'], 'tech_weight[1][]': ['40'],
  };
}

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  const app = build(); const server = app.listen(0); const port = server.address().port;
  const ADMIN = { code: 'MM008', name: 'LMS', isAdmin: true };
  const CREATOR = { code: 'M00758', name: 'Lokesh Kumar Agrawal', isAdmin: false };
  const MEMBER = { code: 'M01078', name: 'Heena Kumari', isAdmin: false };
  const approverRow = await db.first('SELECT rp_approver_code, rp_approver_name FROM tbl_employee WHERE emp_code = ?', [CREATOR.code]);
  const APPROVER = { code: approverRow.rp_approver_code, name: approverRow.rp_approver_name, isAdmin: false };
  check('the creator has a separate RP Approver', !!APPROVER.code && APPROVER.code !== CREATOR.code, true);
  [ADMIN, CREATOR, MEMBER, APPROVER].forEach(signIn);

  const options = await freeDesignations(CREATOR.code, CREATOR.name);
  const first = options.find((a) => options.some((b) => b.sangh_code === a.sangh_code && b.designation !== a.designation));
  const other = options.find((d) => d.sangh_code === first.sangh_code && d.designation !== first.designation);
  check('two free designations in one sangh', !!other, true);

  const form = (mission, designation = first.designation) =>
    profileForm(designation, first.sangh_code, mission, 'save');
  const row = () => db.first('SELECT * FROM rp_role_profiles WHERE id = ?', [id]);
  const told = async (code) => Number((await db.first(
    `SELECT COUNT(*) n FROM rp_notifications WHERE role_profile_id = ? AND emp_code = ?
       AND title = 'A role profile awaiting approval was edited'`, [id, code])).n);

  await post(port, '/role-profiles/store', CREATOR.code, profileForm(first.designation, first.sangh_code, 'Original', 'submit'));
  const id = (await db.first('SELECT MAX(id) id FROM rp_role_profiles')).id;
  check('submitted to the RP Approver', (await row()).status, 'pending_sevak');

  /* ------------------------------------------------------------ level 1 */
  const page = await get(port, `/role-profiles/${id}/edit`, CREATOR.code);
  check('author opens the edit form', page.status, 200);
  check('form says where it waits', page.body.includes('<strong>awaiting the RP Approver</strong>'), true);
  check('sangh is locked', page.body.includes('id="sangh_code" form="profileForm" required disabled'), true);
  check('no new-designation option', page.body.includes('id="newDesigToggle"'), false);

  let r = await post(port, `/role-profiles/${id}/update`, CREATOR.code, form('By the author'));
  check('author edit redirects to the profile', r.location, `/role-profiles/${id}`);
  check('flash', SESSIONS[CREATOR.code].flashSuccess, 'Changes saved. It is still awaiting the RP Approver.');
  let p = await row();
  check('mission changed, status kept', `${p.mission}|${p.status}`, 'By the author|pending_sevak');
  check('RP Approver told', await told(APPROVER.code), 1);

  await post(port, `/role-profiles/${id}/update`, CREATOR.code, form('By the author', other.designation));
  check('designation fixed while pending', (await row()).designation_name, first.designation);

  r = await post(port, `/role-profiles/${id}/update`, APPROVER.code, form('By the RP Approver', other.designation));
  p = await row();
  check('RP Approver may edit too', `${p.mission}|${p.status}|${p.designation_name}`, `By the RP Approver|pending_sevak|${first.designation}`);
  check('author told of the approver edit', await told(CREATOR.code), 1);

  await post(port, `/role-profiles/${id}/submit`, APPROVER.code, {});
  check('approver cannot submit', SESSIONS[APPROVER.code].flashError, 'Only your own drafts can be submitted.');
  delete SESSIONS[APPROVER.code].flashError;

  r = await get(port, `/role-profiles/${id}/edit`, MEMBER.code);
  check('a member is turned away', r.location, `/role-profiles/${id}`);
  await post(port, `/role-profiles/${id}/update`, ADMIN.code, form('Too early'));
  check('PSP Approver too early', SESSIONS[ADMIN.code].flashError,
    'Only the author or the RP Approver can edit this role profile while it awaits the RP Approver.');
  delete SESSIONS[ADMIN.code].flashError;

  /* ------------------------------------------------------------ level 2 */
  await post(port, `/role-profiles/${id}/decide`, APPROVER.code, { action: 'approve' });
  check('passed to the PSP Approver', (await row()).status, 'pending_admin');
  for (const who of [CREATOR, APPROVER]) {
    await get(port, `/role-profiles/${id}/edit`, who.code);
    check(`${who.name} locked out at level 2`, SESSIONS[who.code].flashError,
      'The RP Approver has approved this role profile, so only the PSP Approver can edit it now.');
    delete SESSIONS[who.code].flashError;
    await post(port, `/role-profiles/${id}/update`, who.code, form('Too late'));
    delete SESSIONS[who.code].flashError;
  }
  check('nothing changed at level 2', (await row()).mission, 'By the RP Approver');

  await post(port, `/role-profiles/${id}/update`, ADMIN.code, form('By the PSP Approver'));
  check('PSP flash', SESSIONS[ADMIN.code].flashSuccess, 'Changes saved. It is still awaiting the PSP Approver.');
  p = await row();
  check('PSP edit kept its place', `${p.mission}|${p.status}`, 'By the PSP Approver|pending_admin');
  check('author told twice', await told(CREATOR.code), 2);
  check('RP Approver told three times', await told(APPROVER.code), 3);

  await post(port, `/role-profiles/${id}/decide`, ADMIN.code, { action: 'approve' });
  check('version carries the PSP edit',
    (await db.first('SELECT mission FROM rp_profile_versions WHERE role_profile_id = ?', [id])).mission, 'By the PSP Approver');
  check('four edits in history', (await db.first(
    "SELECT COUNT(*) n FROM rp_role_profile_history WHERE role_profile_id = ? AND action = 'edited'", [id])).n, 4);

  /* ------------------------------- no separate RP Approver: the author keeps editing */
  // The creator is their own RP Approver, so it goes straight to the PSP Approver.
  await db.run('UPDATE tbl_employee SET rp_approver_code = emp_code WHERE emp_code = ?', [CREATOR.code]);
  const spare = (await freeDesignations(CREATOR.code, CREATOR.name)).find((d) => d.designation !== first.designation);
  await post(port, '/role-profiles/store', CREATOR.code, profileForm(spare.designation, spare.sangh_code, 'Solo original', 'submit'));
  const soloId = (await db.first('SELECT MAX(id) id FROM rp_role_profiles')).id;
  const solo = () => db.first('SELECT * FROM rp_role_profiles WHERE id = ?', [soloId]);
  check('went straight to the PSP Approver', `${(await solo()).status}|${(await solo()).rp_approver_code}`, 'pending_admin|');

  const soloShow = await get(port, `/role-profiles/${soloId}`, CREATOR.code);
  check('author sees Edit before approval', soloShow.body.includes('Edit before approval'), true);
  const soloForm = await get(port, `/role-profiles/${soloId}/edit`, CREATOR.code);
  check('author opens the edit form at the PSP stage', `${soloForm.status}|${soloForm.body.includes('<strong>awaiting the PSP Approver</strong>')}`, '200|true');

  await post(port, `/role-profiles/${soloId}/update`, CREATOR.code,
    profileForm('A Different Designation', spare.sangh_code, 'Solo edited by the author', 'save'));
  check('author edit flash', SESSIONS[CREATOR.code].flashSuccess, 'Changes saved. It is still awaiting the PSP Approver.');
  const se = await solo();
  check('saved, still with the PSP Approver, designation fixed',
    `${se.mission}|${se.status}|${se.designation_name}`, `Solo edited by the author|pending_admin|${spare.designation}`);
  check('PSP Approver told', Number((await db.first(
    `SELECT COUNT(*) n FROM rp_notifications WHERE role_profile_id = ? AND emp_code = 'MM008'
       AND title = 'A role profile awaiting approval was edited'`, [soloId])).n), 1);

  r = await get(port, `/role-profiles/${soloId}/edit`, MEMBER.code);
  check('still nobody else', r.location, `/role-profiles/${soloId}`);
  delete SESSIONS[MEMBER.code].flashError;

  await post(port, `/role-profiles/${soloId}/decide`, ADMIN.code, { action: 'approve' });
  check('approval freezes the author edit', (await db.first(
    'SELECT mission FROM rp_profile_versions WHERE role_profile_id = ?', [soloId])).mission, 'Solo edited by the author');
  check('approved: author edits only as a revision now', (await get(port, `/role-profiles/${soloId}/edit`, CREATOR.code)).status, 200);
  await db.run('UPDATE tbl_employee SET rp_approver_code = ? WHERE emp_code = ?', [APPROVER.code, CREATOR.code]);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
