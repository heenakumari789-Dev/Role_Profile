'use strict';
/** Reading a role profile out of the Pakka Excel format. Sandbox only. */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { build, signIn, get, freeDesignations } = require('./smoke');
const db = require('../src/lib/db');
const importer = require('../src/lib/importer');

const SHEET = process.env.RP_SHEET
  || '/Users/heena/Downloads/Web Backend Head or Web Development Head (1).xlsx';

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};

/** Post a file the way a browser would. */
function upload(port, who, filePath, fields = {}) {
  const boundary = '----rp' + Date.now();
  const chunks = [];
  for (const [k, v] of Object.entries({ csrf_test_name: 'test-token', ...fields })) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (filePath) {
    chunks.push(Buffer.from(`--${boundary}\r\n`
      + `Content-Disposition: form-data; name="sheet"; filename="${path.basename(filePath)}"\r\n`
      + 'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'));
    chunks.push(fs.readFileSync(filePath));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);

  return new Promise((resolve) => {
    const req = http.request({ port, path: '/role-profiles/import', method: 'POST', headers: {
      'x-test-user': who, 'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': body.length } },
      (res) => { let b = ''; res.on('data', (c) => (b += c));
                 res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || '', body: b })); });
    req.end(body);
  });
}

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);
  if (!fs.existsSync(SHEET)) {
    console.log(`\n  skipped — no sample sheet at ${SHEET}`);
    process.exit(0);
  }

  /* -------------------------------------------------- the parser on its own */
  const parsed = await importer.parse(fs.readFileSync(SHEET));
  check('both sheets were seen', parsed.sheets.length, 2);
  check('the tidier sheet was chosen', parsed.sheet, 'Proposed');
  check('the designation was read', parsed.designation, 'Web Development Head');
  check('the mission was read', /^Lead the design, development/.test(parsed.mission), true);
  check('three key outcomes', parsed.outcomes.length, 3);
  check('nine attributes', parsed.attributes.length, 9);
  check('twenty-seven skills', parsed.skillCount, 27);
  check('the weights total 100', parsed.attributes.reduce((t, a) => t + a.weight, 0), 100);
  check('every attribute has its own skill weights',
    parsed.attributes.every(a => Math.abs(a.skills.reduce((t, s) => t + s.weight, 0) - a.weight) < 0.001), true);
  check('a clean sheet raises no warnings', parsed.warnings.length, 0);

  // Asking for the other sheet gives the other sheet.
  const older = await importer.parse(fs.readFileSync(SHEET), { sheet: 'Heena Kumari-E01078' });
  check('a named sheet is honoured', older.sheet, 'Heena Kumari-E01078');
  check('and its problems are reported', older.warnings.length > 0, true);

  /* ------------------------------------------------------ through the form */
  const app = build(); const server = app.listen(0); const port = server.address().port;
  const CREATOR = { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false };
  signIn(CREATOR);

  const create = await get(port, '/role-profiles/create', 'M00151');
  check('the create form offers the upload', /name="sheet" accept="\.xlsx"/.test(create.body), true);

  const before = (await db.first('SELECT COUNT(*) n FROM rp_role_profiles')).n;
  const res = await upload(port, 'M00151', SHEET);
  check('the upload renders a filled form', res.status, 200);
  check('nothing was saved by uploading',
    (await db.first('SELECT COUNT(*) n FROM rp_role_profiles')).n, before);
  check('it says which file and sheet',
    /Read from[\s\S]{0,400}Sheet &#34;Proposed&#34;|Read from[\s\S]{0,400}Sheet "Proposed"/.test(res.body), true);
  check('it reports what it found', /9 skills, 27 attributes/.test(res.body), true);
  check('the mission came through', /Lead the design, development/.test(res.body), true);
  // Seeded content is handed to the page as JSON, so it is not HTML-escaped there.
  check('the attributes came through', /Coding Languages & Frameworks/.test(res.body), true);
  check('the skills came through', /Applied knowledge of SEO/.test(res.body), true);
  check('the designation is left for the creator to pick',
    /var OLD_DESIGNATION = ""/.test(res.body), true);
  check('it offers to read the other sheet', /Read again/.test(res.body), true);

  /* ---------------------------------------------------------- what it refuses */
  const noFile = await upload(port, 'M00151', null);
  check('an empty upload is refused', noFile.status, 302);

  const notASheet = path.join(__dirname, '..', 'writable', 'not-a-sheet.xlsx');
  fs.writeFileSync(notASheet, 'this is not a spreadsheet');
  const junk = await upload(port, 'M00151', notASheet);
  check('a file that is not a spreadsheet is refused', junk.status, 302);
  fs.unlinkSync(notASheet);

  /* --------------------------------- and the imported form still saves normally */
  let [free] = await freeDesignations(CREATOR.code, CREATOR.name);
  // The suites share one sandbox and may have used every held designation by now; a
  // designation created in the portal is just as good to write against.
  if (!free) {
    const roleProfileModel = require('../src/models/roleProfile');
    free = { sangh_code: 'DVS', designation: `Import Test Head ${Date.now()}` };
    await roleProfileModel.createDesignation(free.sangh_code, free.designation, { code: CREATOR.code, name: CREATOR.name });
  }
  const form = {
    designation_name: free.designation, sangh_code: free.sangh_code,
    mission: parsed.mission, outcomes: parsed.outcomes, action: 'draft',
  };
  parsed.attributes.forEach((a, i) => {
    const n = i + 1;
    form[`attribute[${n}]`] = a.attribute;
    form[`attribute_weight[${n}]`] = String(a.weight);
    form[`assessment[${n}]`] = '';
    a.skills.forEach((sk, j) => {
      form[`tech_skill[${n}][${j + 1}]`] = sk.skill;
      form[`tech_weight[${n}][${j + 1}]`] = String(sk.weight);
    });
  });
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (Array.isArray(v)) v.forEach((one) => params.append(k, one)); else params.append(k, v);
  }
  params.append('csrf_test_name', 'test-token');
  const payload = params.toString();
  await new Promise((r) => {
    const req = http.request({ port, path: '/role-profiles/store', method: 'POST', headers: {
      'x-test-user': 'M00151', 'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(payload) } }, (res2) => { res2.on('data', () => {}); res2.on('end', r); });
    req.end(payload);
  });

  const saved = await db.first(
    'SELECT * FROM rp_role_profiles WHERE designation_name=? ORDER BY id DESC LIMIT 1', [free.designation]);
  check('the imported profile saves', !!saved, true);
  check('with all 27 skills',
    (await db.first("SELECT COUNT(*) n FROM rp_role_profile_details WHERE role_profile_id=? AND TRIM(COALESCE(tech_skill,''))<>''",
      [saved.id])).n, 27);
  check('and the weights add to 100',
    Number((await db.first(
      'SELECT SUM(w) t FROM (SELECT DISTINCT attribute_no, attribute_weight w FROM rp_role_profile_details WHERE role_profile_id=?) x',
      [saved.id])).t), 100);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
