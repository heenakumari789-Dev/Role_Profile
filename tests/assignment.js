'use strict';
/**
 * A role profile applies only to the members the admin assigns — nothing lands on someone
 * just because they hold the designation. Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const http = require('http');
const { build, signIn, get, freeDesignations, approveFully, SESSIONS } = require('./smoke');
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
const flash = (who, kind) => { const v = SESSIONS[who] && SESSIONS[who][kind]; if (SESSIONS[who]) delete SESSIONS[who][kind]; return v; };

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  const app = build(); const server = app.listen(0); const port = server.address().port;
  const ADMIN = { code: 'MM008', name: 'LMS', isAdmin: true };
  const CREATOR = { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false };
  [ADMIN, CREATOR].forEach(signIn);

  const free = await freeDesignations(CREATOR.code, CREATOR.name);
  const d = free.find((x) => Number(x.members) > 0);
  check('a free designation somebody holds', !!d, true);
  const holders = await db.query(
    'SELECT emp_code, name FROM tbl_employee WHERE status=0 AND sangh_code=? AND TRIM(designation)=? ORDER BY emp_code',
    [d.sangh_code, d.designation]);

  const form = { designation_name: d.designation, sangh_code: d.sangh_code, mission: 'Assignment check.',
                 outcomes: ['One'], action: 'submit', 'attribute[0]': 'Skill', 'attribute_weight[0]': '100',
                 'assessment[0]': '', 'tech_skill[0][]': 'Attribute', 'tech_weight[0][]': '100' };
  await post(port, '/role-profiles/store', CREATOR.code, form);
  const id = (await db.first('SELECT MAX(id) id FROM rp_role_profiles')).id;
  await approveFully(post, port, id, { assign: false });
  const profile = await roleProfile.find(id);
  check('approved', profile.status, 'approved');
  check('approval flash says nobody yet', SESSIONS.MM008.flashSuccess.includes('It applies to nobody yet'), true);
  flash('MM008', 'flashSuccess');

  /* ---------------------------------------------------- nothing automatic */
  check('holding the designation does not put anyone on it', (await roleProfile.effectiveMembers(profile)).length, 0);
  check('no "applied automatically" history', (await db.first(
    "SELECT COUNT(*) n FROM rp_role_profile_history WHERE role_profile_id = ? AND action = 'auto_applied'", [id])).n, 0);
  const holderSees = (await roleProfile.visibleTo(holders[0].emp_code, false)).some((p) => p.id === id);
  check('a designation holder does not see it before being assigned', holderSees, false);

  /* ----------------------------------------------------- only the admin assigns */
  await post(port, `/role-profiles/${id}/assign-members`, CREATOR.code, { 'emp_codes[]': holders[0].emp_code });
  check('the author cannot assign', flash(CREATOR.code, 'flashError'),
    'Only an approved profile can be assigned, and only by the PSP Approver (the LDP Admin for an LDP profile).');
  check('...so nobody was added', (await roleProfile.effectiveMembers(profile)).length, 0);

  const page = await get(port, `/role-profiles/${id}`, ADMIN.code);
  check('admin sees the assign box', page.body.includes('Assign members'), true);
  check('...with the designation holders flagged', page.body.includes('Holds this designation'), true);
  check('no "Covered automatically" section', page.body.includes('Covered automatically'), false);
  check('author sees no assign box', (await get(port, `/role-profiles/${id}`, CREATOR.code)).body.includes('Assign members'), false);

  await post(port, `/role-profiles/${id}/assign-members`, ADMIN.code, { 'emp_codes[]': holders[0].emp_code });
  check('admin assigns', flash('MM008', 'flashSuccess'), '1 member assigned to this role profile.');
  const members = await roleProfile.effectiveMembers(profile);
  check('it applies to exactly that member', members.map((m) => m.emp_code).join(','), holders[0].emp_code);
  check('...who is told', (await db.first(
    "SELECT COUNT(*) n FROM rp_notifications WHERE role_profile_id = ? AND emp_code = ? AND title = 'A role profile was assigned to you'",
    [id, holders[0].emp_code])).n, 1);
  check('...and the creator is told, to assess them', (await db.first(
    "SELECT COUNT(*) n FROM rp_notifications WHERE role_profile_id = ? AND emp_code = ? AND title = 'Members assigned to a role profile'",
    [id, CREATOR.code])).n, 1);
  const shown = (await get(port, `/role-profiles/${id}`, ADMIN.code)).body;
  check('history says "by Admin", not the member-row name', shown.includes('by Admin') && !shown.includes('by LMS'), true);
  check('members table says "Assigned by Admin"', shown.includes('Assigned by Admin'), true);
  check('recorded as Admin too', (await db.first(
    "SELECT actor_name FROM rp_role_profile_history WHERE role_profile_id = ? AND action = 'members_assigned' ORDER BY id DESC LIMIT 1", [id])).actor_name, 'Admin');
  check('the member can now see it', (await roleProfile.visibleTo(holders[0].emp_code, false)).some((p) => p.id === id), true);

  // Someone with another designation can be assigned too.
  const other = (await roleProfile.assignableMembers(profile)).find((m) => !m.assigned && !m.holds_designation);
  await post(port, `/role-profiles/${id}/assign-members`, ADMIN.code, { 'emp_codes[]': other.emp_code });
  check('a member with another designation can be assigned', (await roleProfile.effectiveMembers(profile)).length, 2);

  /* -------------------------------------------------------------- removing */
  await post(port, `/role-profiles/${id}/unassign-member`, CREATOR.code, { emp_code: other.emp_code });
  check('the author cannot remove', flash(CREATOR.code, 'flashError'),
    'Only the PSP Approver (the LDP Admin for an LDP profile) assigns and removes members.');
  await post(port, `/role-profiles/${id}/unassign-member`, ADMIN.code, { emp_code: other.emp_code });
  check('admin removes', flash('MM008', 'flashSuccess'), 'Member removed from this role profile.');
  check('...and it no longer applies to them', (await roleProfile.effectiveMembers(profile)).some((m) => m.emp_code === other.emp_code), false);
  await post(port, `/role-profiles/${id}/unassign-member`, ADMIN.code, { emp_code: other.emp_code });
  check('removing again is refused', flash('MM008', 'flashError'), 'That member is not assigned to this role profile.');

  /* ------------------------------------------- the carry-over script, previewed */
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['scripts/migrate_manual_assignment.js'],
    { cwd: require('path').join(__dirname, '..'), env: process.env }).toString();
  check('carry-over preview writes nothing', out.includes('would be assigned'), true);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
