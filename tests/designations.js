'use strict';
/**
 * Which designations a creator can pick, adding new ones to a sangh, and former members
 * never showing on a profile. Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

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
      (res) => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => {
        let json = null; try { json = JSON.parse(b); } catch (e) { /* not JSON */ }
        r({ status: res.statusCode, location: res.headers.location || '', json });
      }); });
    req.end(body);
  });
}
const bySangh = (html) => JSON.parse(/var BY_SANGH = (.*?);\n/.exec(html)[1]);

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  const app = build(); const server = app.listen(0); const port = server.address().port;
  const ADMIN = { code: 'MM008', name: 'LMS', isAdmin: true };
  const CREATOR = { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false };
  const MEMBER = { code: 'M01078', name: 'Heena Kumari', isAdmin: false };
  [ADMIN, CREATOR, MEMBER].forEach(signIn);

  /* ------------------------------- every designation the sangh has held */
  let html = (await get(port, '/role-profiles/create', CREATOR.code)).body;
  const dvs = bySangh(html).DVS;
  const names = dvs.map((d) => d.designation);
  check('held now is offered', names.includes('Web Backend Head'), true);
  check('held only by former members is offered', names.includes('SAP Head'), true);
  check('...and another', names.includes('Technology Lead'), true);
  check('no member counts', 'members' in dvs[0], false);

  /* ------------------------------- sangh & designation come first, and are required */
  const top = html.indexOf('id="sanghDesignation"');
  check('the Sangh & Designation box is the first thing on the form',
    top > 0 && top < html.indexOf('Fill it in from an Excel sheet') && top < html.indexOf('id="profileForm"'), true);
  check('both dropdowns are required and submit with the form',
    (html.match(/form="profileForm" required/g) || []).length, 2);
  const cloned = (await get(port, '/role-profiles/1/clone?sangh=DVS&designation=SAP%20Head', CREATOR.code)).body;
  check('a clone opens on the designation chosen at the top', /var OLD_DESIGNATION = "SAP Head";/.test(cloned), true);
  await post(port, '/role-profiles/store', CREATOR.code, {
    sangh_code: 'DVS', designation_name: '', mission: 'x', outcomes: ['x'],
    'attribute[0]': 'A', 'attribute_weight[0]': '100', 'tech_skill[0][]': 'a', 'tech_weight[0][]': '100', action: 'draft',
  });
  check('saving without a designation is refused', SESSIONS[CREATOR.code].flashError, 'Choose a designation.');
  delete SESSIONS[CREATOR.code].flashError;

  /* ------------------------------------------------ adding a designation */
  let r = await post(port, '/role-profiles/designations', CREATOR.code, { sangh_code: 'DVS', designation_name: '  SAP   Security Head ' });
  check('created', `${r.status}|${r.json.ok}|${r.json.created}|${r.json.designation}|${r.json.program}`, '200|true|true|SAP Security Head|psp');
  check('recorded against its creator', (await db.first(
    "SELECT created_by FROM rp_designations WHERE sangh_code = 'DVS' AND designation_name = 'SAP Security Head'")).created_by, 'M00151');

  r = await post(port, '/role-profiles/designations', CREATOR.code, { sangh_code: 'DVS', designation_name: 'sap security head' });
  check('same name in another case is reused', `${r.json.created}|${r.json.designation}`, 'false|SAP Security Head');
  r = await post(port, '/role-profiles/designations', CREATOR.code, { sangh_code: 'DVS', designation_name: 'web backend head' });
  check('an existing held one is reused', `${r.json.created}|${r.json.designation}`, 'false|Web Backend Head');
  check('only one row added', (await db.first("SELECT COUNT(*) n FROM rp_designations WHERE sangh_code = 'DVS' AND LOWER(designation_name) IN ('sap security head', 'web backend head')")).n, 1);

  r = await post(port, '/role-profiles/designations', CREATOR.code, { sangh_code: 'VSS', designation_name: 'Anything' });
  check('not into a sangh they do not lead', `${r.status}|${r.json.message}`, '422|Choose one of your sanghs first.');
  r = await post(port, '/role-profiles/designations', MEMBER.code, { sangh_code: 'DVS', designation_name: 'Anything' });
  check('not by a plain member', r.status, 422);
  r = await post(port, '/role-profiles/designations', CREATOR.code, { sangh_code: 'DVS', designation_name: 'X' });
  check('too short', r.status, 422);

  html = (await get(port, '/role-profiles/create', CREATOR.code)).body;
  check('shows in the form', bySangh(html).DVS.some((d) => d.designation === 'SAP Security Head'), true);

  await post(port, '/role-profiles/store', CREATOR.code, {
    sangh_code: 'DVS', designation_name: 'SAP Security Head', mission: 'Secure SAP.',
    outcomes: ['No audit findings'], 'attribute[0]': 'Access control', 'attribute_weight[0]': '100',
    'assessment[0]': '', 'tech_skill[0][]': 'Role design', 'tech_weight[0][]': '100', action: 'draft',
  });
  check('a profile can be written against it', !!SESSIONS[CREATOR.code].flashSuccess, true);
  const made = await db.first('SELECT * FROM rp_role_profiles WHERE id = (SELECT MAX(id) FROM rp_role_profiles)');
  check('...with that designation, PSP', `${made.designation_name}|${made.program}`, 'SAP Security Head|psp');

  /* ------------------------------------------ an invented one is refused */
  await post(port, '/role-profiles/store', CREATOR.code, {
    sangh_code: 'DVS', designation_name: 'Invented Head', outcomes: ['x'],
    'attribute[0]': 'A', 'attribute_weight[0]': '100', 'tech_skill[0][]': 'a', 'tech_weight[0][]': '100', action: 'draft',
  });
  check('invented designation refused', SESSIONS[CREATOR.code].flashError,
    'That designation does not exist in that sangh. Create it with "+ New designation" first.');
  delete SESSIONS[CREATOR.code].flashError;

  /* --------------------------------------- former members never appear */
  await db.run(`INSERT INTO rp_role_profile_members (role_profile_id, emp_code, member_name, assigned_by, assigned_by_name, assigned_at)
                VALUES (1, 'M01083', 'Ankit Raghuvanshi', 'MM008', 'LMS', NOW())`);
  const codes = async () => (await roleProfile.effectiveMembers(await roleProfile.find(1))).map((m) => m.emp_code);
  check('assigned member shows', (await codes()).includes('M01083'), true);
  await db.run("UPDATE tbl_employee SET status = 2 WHERE emp_code = 'M01083'");
  check('once they leave they do not', (await codes()).includes('M01083'), false);
  const show = await get(port, '/role-profiles/1', ADMIN.code);
  check('nor on the page', `${show.status}|${show.body.includes('Ankit Raghuvanshi')}`, '200|false');

  /* ------------------------------------------------- the Designations page */
  const VSS_CREATOR = { code: 'M00758', name: 'Lokesh Kumar Agrawal', isAdmin: false };
  signIn(VSS_CREATOR);
  const approverRow = await db.first('SELECT rp_approver_code c, rp_approver_name n FROM tbl_employee WHERE emp_code = ?', [VSS_CREATOR.code]);
  const RP_APPROVER = { code: approverRow.c, name: approverRow.n, isAdmin: false };
  signIn(RP_APPROVER);

  let page = await get(port, '/designations', ADMIN.code);
  check('PSP Approver opens the page', page.status, 200);
  check('...and can pick any sangh, VSS included', page.body.includes('<option value="VSS"'), true);
  check('sidebar links to it', page.body.includes('href="/designations"'), true);

  r = await post(port, '/designations', ADMIN.code, { sangh_code: 'VSS', designation_name: 'Treasury Analyst' });
  check('PSP Approver adds one', `${r.location}|${SESSIONS[ADMIN.code].flashSuccess}`,
    `/designations?sangh=VSS|"Treasury Analyst" added to ${(await db.first("SELECT MAX(sangh_name) n FROM tbl_employee WHERE sangh_code='VSS'")).n}. It is now in the designation list when creating a role profile for ${(await db.first("SELECT MAX(sangh_name) n FROM tbl_employee WHERE sangh_code='VSS'")).n}.`);
  page = await get(port, '/designations?sangh=VSS', ADMIN.code);
  check('listed with who added it', page.body.includes('Treasury Analyst') && page.body.includes('Added by Admin'), true);

  html = (await get(port, '/role-profiles/create', VSS_CREATOR.code)).body;
  check("the sangh's RP Creator sees it in the dropdown", bySangh(html).VSS.some((d) => d.designation === 'Treasury Analyst'), true);

  r = await post(port, '/designations', ADMIN.code, { sangh_code: 'VSS', designation_name: 'treasury  analyst' });
  check('a repeat is not added', SESSIONS[ADMIN.code].flashSuccess.includes('already exists'), true);
  check('one row only', (await db.first("SELECT COUNT(*) n FROM rp_designations WHERE sangh_code='VSS' AND designation_name='Treasury Analyst'")).n, 1);

  page = await get(port, '/designations', VSS_CREATOR.code);
  check('RP Creator opens the page', page.status, 200);
  check('...limited to their own sanghs', page.body.includes('<option value="DVS"'), false);
  page = await get(port, '/designations', RP_APPROVER.code);
  check('RP Approver opens the page', page.status, 200);
  const approverSangh = (await roleProfile.sanghsForLeader(RP_APPROVER.code, RP_APPROVER.name))[0].sangh_code;
  r = await post(port, '/designations', RP_APPROVER.code, { sangh_code: approverSangh, designation_name: 'Approver Added Role' });
  check('RP Approver adds one to their sangh', SESSIONS[RP_APPROVER.code].flashSuccess.startsWith('"Approver Added Role" added'), true);
  r = await post(port, '/designations', VSS_CREATOR.code, { sangh_code: 'DVS', designation_name: 'Not Mine' });
  check('not into a sangh they do not lead', SESSIONS[VSS_CREATOR.code].flashError, 'Choose one of your sanghs first.');
  delete SESSIONS[VSS_CREATOR.code].flashError;

  page = await get(port, '/designations', MEMBER.code);
  check('a plain member is sent away', page.location, '/role-profiles');

  /* ------------------------------------- Sanghrakshak / Seva Sangh are LDP, not PSP */
  page = await get(port, '/designations', ADMIN.code);
  check('PSP Approver alone is not offered SS', page.body.includes('<option value="SS"'), false);
  r = await post(port, '/designations', ADMIN.code, { sangh_code: 'SS', designation_name: 'PSP Into LDP' });
  check('...and cannot add to it', SESSIONS[ADMIN.code].flashError, 'Choose one of your sanghs first.');
  delete SESSIONS[ADMIN.code].flashError;

  const LDP_ADMIN = { code: 'LDPTEST', name: 'LDP Admin', isAdmin: false };
  signIn(LDP_ADMIN);
  SESSIONS[LDP_ADMIN.code].is_ldp_admin = true;
  page = await get(port, '/designations', LDP_ADMIN.code);
  check('LDP Admin opens the page', page.status, 200);
  check('...offered SS and SS1, under LDP', page.body.includes('<option value="SS"') && page.body.includes('<option value="SS1"')
    && page.body.includes('Sanghrakshak &amp; Seva Sangh'), true);
  check('...and no PSP sangh', page.body.includes('<option value="VSS"'), false);
  r = await post(port, '/designations', LDP_ADMIN.code, { sangh_code: 'SS', designation_name: 'Sanghrakshak Mentor' });
  check('LDP Admin adds to SS', SESSIONS[LDP_ADMIN.code].flashSuccess.startsWith('"Sanghrakshak Mentor" added'), true);
  page = await get(port, '/designations?sangh=SS', LDP_ADMIN.code);
  check('listed as LDP', /Sanghrakshak Mentor[\s\S]*?rp-prog-ldp/.test(page.body), true);

  // Only an SS RP Creator writes LDP profiles there; being someone's RP Approver in SS is not enough.
  const SS_CREATOR = { code: 'M01156', name: 'Deepak Kumar Ramsundar Pandey', isAdmin: false };
  signIn(SS_CREATOR);
  const ssApproverOnly = (await db.first(
    "SELECT rp_approver_code c FROM tbl_employee WHERE status = 0 AND sangh_code = 'SS' AND rp_approver_code <> '' AND rp_approver_code NOT IN (SELECT rp_creator_code FROM tbl_employee WHERE status = 0 AND sangh_code = 'SS') LIMIT 1")).c;
  check('an SS RP Approver who creates for nobody there is not given SS',
    (await roleProfile.sanghsForLeader(ssApproverOnly, '')).some((x) => x.sangh_code === 'SS'), false);
  check('...nor are those SS members on their My Members',
    (await require('../src/models/employee').membersLedBy(ssApproverOnly, '')).some((m) => m.sangh_code === 'SS'), false);
  check('an SS RP Creator does see theirs',
    (await require('../src/models/employee').membersLedBy('M01156', '')).some((m) => m.sangh_code === 'SS'), true);
  const created = (await get(port, '/role-profiles/create', SS_CREATOR.code)).body;
  check('Create form groups SS under LDP', /optgroup label="LDP[^"]*">[\s\S]*?value="SS"/.test(created)
    || /value="SS" selected>[^<]*LDP/.test(created), true);
  const dvsForm = (await get(port, '/role-profiles/create', CREATOR.code)).body;
  check('...and DVS under PSP', /value="DVS"[^>]*>[^<]*(PSP|members)/.test(dvsForm) && /PSP/.test(dvsForm), true);
  const ssDesig = bySangh(created).SS.find((d) => d.designation === 'Sanghrakshak Mentor');
  check('the new SS designation is in the dropdown, as LDP', ssDesig && ssDesig.program, 'ldp');
  const pspList = (await get(port, '/role-profiles', ADMIN.code)).body;
  check('PSP Approver\'s list: PSP profiles only', pspList.includes('rp-prog-psp') && !pspList.includes('rp-prog-ldp'), true);
  const ldpList = (await get(port, '/role-profiles', LDP_ADMIN.code)).body;
  check('LDP Admin\'s list: tagged LDP', ldpList.includes('rp-prog-ldp') && !ldpList.includes('rp-prog-psp'), true);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
