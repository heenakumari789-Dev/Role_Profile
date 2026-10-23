'use strict';
/**
 * One role profile per designation, and cloning one onto another designation.
 * Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const http = require('http');
const { build, signIn, freeDesignations } = require('./smoke');
const db = require('../src/lib/db');
const roleProfileModel = require('../src/models/roleProfile');

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
      (res) => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => r({ status: res.statusCode, location: res.headers.location || '', body: b })); });
    req.end(body);
  });
}
const get = (port, path, who) => new Promise((r) => {
  http.get({ port, path, headers: { 'x-test-user': who } }, (res) => {
    let b = ''; res.on('data', c => (b += c)); res.on('end', () => r({ status: res.statusCode, body: b }));
  });
});

function profileForm(designation, sangh, mission, outcomes, prefix, weights) {
  const form = { designation_name: designation, sangh_code: sangh, mission, outcomes, action: 'submit' };
  weights.forEach((w, i) => {
    const n = i + 1;
    form[`attribute[${n}]`] = `${prefix} attribute ${n}`;
    form[`attribute_weight[${n}]`] = String(w);
    form[`assessment[${n}]`] = '';
    form[`tech_skill[${n}][1]`] = `${prefix} skill ${n}.1`;
    form[`tech_weight[${n}][1]`] = String(w);
  });
  return form;
}
const WEIGHTS = [12, 11, 11, 11, 11, 11, 11, 11, 11];

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  const app = build(); const server = app.listen(0); const port = server.address().port;
  const ADMIN = { code: 'MM008', name: 'LMS', isAdmin: true };
  const CREATOR = { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false };
  [ADMIN, CREATOR].forEach(signIn);

  const options = await freeDesignations(CREATOR.code, CREATOR.name);
  // Two still-free designations in the same sangh: one to claim, one to clone onto.
  const first = options.find((a) =>
    options.some((b) => b.sangh_code === a.sangh_code && b.designation !== a.designation));
  const second = options.find((d) => d.sangh_code === first.sangh_code && d.designation !== first.designation);
  check('the leader has two designations to work with', !!second, true);

  /* -------------------------------------------------- the first one is fine */
  await post(port, '/role-profiles/store', 'M00151',
    profileForm(first.designation, first.sangh_code, 'Original mission.', ['Outcome A', 'Outcome B'], 'Base', WEIGHTS));
  const original = await db.first(
    'SELECT * FROM rp_role_profiles WHERE designation_name=? AND sangh_code=? ORDER BY id DESC LIMIT 1',
    [first.designation, first.sangh_code]);
  check('the first profile was created', !!original, true);

  /* ------------------------------------------- a second one is turned away */
  const before = (await db.first('SELECT COUNT(*) n FROM rp_role_profiles')).n;
  const clash = await post(port, '/role-profiles/store', 'M00151',
    profileForm(first.designation, first.sangh_code, 'A rival mission.', ['X'], 'Rival', WEIGHTS));
  check('no second profile was written',
    (await db.first('SELECT COUNT(*) n FROM rp_role_profiles')).n, before);
  check('it bounced back to the form', /role-profiles\/create/.test(clash.location), true);

  const backOnForm = await get(port, '/role-profiles/create', 'M00151');
  check('and says the designation already has one',
    /already has a role profile/.test(backOnForm.body), true);

  /* -------------------------------- the dropdown marks it as unavailable */
  check('the taken designation is flagged in the form data',
    /"taken":\{"id":\d+/.test(backOnForm.body), true);
  check('the form says how many are taken', /already ha/.test(backOnForm.body), true);

  /* ------------------------------------------------- a rejected one frees it up */
  // Whoever it is waiting on turns it down — the RP Approver, or the PSP Approver if there is none.
  const decider = original.rp_approver_code || 'MM008';
  signIn({ code: decider, name: original.rp_approver_name || 'LMS', isAdmin: decider === 'MM008' });
  await post(port, `/role-profiles/${original.id}/decide`, decider, { action: 'reject', reject_reason: 'no' });
  check('a rejected profile no longer blocks the designation',
    await roleProfileModel.profileForDesignation(first.sangh_code, first.designation), null);

  // Approve it so it is live for the rest of the test.
  await post(port, `/role-profiles/${original.id}/submit`, 'M00151', {});
  await post(port, `/role-profiles/${original.id}/decide`, 'MM008', { action: 'approve' });
  check('and blocks it again once approved',
    !!(await roleProfileModel.profileForDesignation(first.sangh_code, first.designation)), true);

  /* -------------------------- revising it keeps its own designation available */
  const editable = await get(port, `/role-profiles/${original.id}/edit`, 'M00151');
  check('its own edit page opens for revision', editable.status, 200);
  await post(port, `/role-profiles/${original.id}/update`, 'M00151',
    profileForm(first.designation, first.sangh_code, 'Reworded mission.', ['Outcome A'], 'Base', WEIGHTS));
  check('saving it under its own designation is allowed',
    (await db.first('SELECT mission FROM rp_role_profiles WHERE id=?', [original.id])).mission, 'Reworded mission.');
  await post(port, `/role-profiles/${original.id}/decide`, 'MM008', { action: 'approve' });

  /* ------------------------- the create screen offers a source to start from ---- */
  const createPage = await get(port, '/role-profiles/create', 'M00151');
  check('the create form offers to start from an existing profile',
    /rp-clone-start/.test(createPage.body), true);
  check('and lists the existing one as a source',
    new RegExp(`<option value="${original.id}">`).test(createPage.body), true);
  check('the button is disabled until a source is picked',
    /id="cloneGo" disabled/.test(createPage.body), true);

  /* -------------------------------------------------------------- cloning */
  const clonePage = await get(port, `/role-profiles/${original.id}/clone`, 'M00151');
  check('the clone form opens', clonePage.status, 200);
  check('the clone form does not offer the picker again',
    /rp-clone-start/.test(clonePage.body), false);
  check('it is titled as a clone', /Clone Role Profile/.test(clonePage.body), true);
  check('it names the source', new RegExp(`Copied from[\\s\\S]{0,80}${first.designation}`).test(clonePage.body), true);
  check('it carries the mission across', /Reworded mission\./.test(clonePage.body), true);
  check('it carries the attributes across', /Base attribute 1/.test(clonePage.body), true);
  check('it carries the skills across', /Base skill 1\.1/.test(clonePage.body), true);
  check('but leaves the designation blank', /"OLD_DESIGNATION"|var OLD_DESIGNATION = ""/.test(clonePage.body)
    || /var OLD_DESIGNATION = ""/.test(clonePage.body), true);

  // Saving the clone onto a free designation, with the weights changed.
  const changed = [20, 10, 10, 10, 10, 10, 10, 10, 10];
  await post(port, '/role-profiles/store', 'M00151',
    profileForm(second.designation, second.sangh_code, 'Cloned then adjusted.', ['Outcome A'], 'Base', changed));
  const cloned = await db.first(
    'SELECT * FROM rp_role_profiles WHERE designation_name=? AND sangh_code=? ORDER BY id DESC LIMIT 1',
    [second.designation, second.sangh_code]);
  check('the clone saved as its own profile', !!cloned, true);
  check('under the new designation', cloned.designation_name, second.designation);
  check('with the adjusted weight',
    Number((await db.first(
      'SELECT attribute_weight FROM rp_role_profile_details WHERE role_profile_id=? ORDER BY attribute_no LIMIT 1',
      [cloned.id])).attribute_weight), 20);
  check('the original is untouched',
    Number((await db.first(
      'SELECT attribute_weight FROM rp_role_profile_details WHERE role_profile_id=? ORDER BY attribute_no LIMIT 1',
      [original.id])).attribute_weight), 12);
  check('and now both designations are taken',
    (await roleProfileModel.takenDesignations()).size >= 2, true);

  /* ------------------------------- cloning onto an already-taken designation fails */
  const dupFromClone = await post(port, '/role-profiles/store', 'M00151',
    profileForm(second.designation, second.sangh_code, 'Another rival.', ['X'], 'Rival', WEIGHTS));
  check('a clone cannot land on a designation that already has one',
    (await db.first('SELECT COUNT(*) n FROM rp_role_profiles WHERE designation_name=? AND sangh_code=?',
      [second.designation, second.sangh_code])).n, 1);
  check('and it says so', /role-profiles\/create/.test(dupFromClone.location), true);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
