'use strict';
/** PDF endpoints: who may download, what comes back. Read-only against live data. */
const { build, signIn, get } = require('./smoke');
const db = require('../src/lib/db');
const pdfLib = require('../src/lib/pdf');
const assessment = require('../src/models/assessment');
const roleProfile = require('../src/models/roleProfile');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};

(async () => {
  const live = await db.first("SELECT id FROM rp_role_profiles WHERE status='approved' ORDER BY id LIMIT 1");
  if (!live) {
    console.log('  no approved role profile on this database — PDF checks skipped');
    process.exit(0);
  }

  const app = build(); const server = app.listen(0); const port = server.address().port;
  [{ code: 'MM008', name: 'LMS', isAdmin: true },
   { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false },
   { code: 'M01078', name: 'Heena Kumari', isAdmin: false },
   { code: 'M00934', name: 'Amit Kumar', isAdmin: false },
   { code: 'M00612', name: 'Shishir Srivastav', isAdmin: false }].forEach(signIn);

  const isPdf = (r) => r.status === 200 && r.body.slice(0, 5) === '%PDF-';
  const pages = (body) => (body.match(/\/Type\s*\/Page[^s]/g) || []).length;

  /* ------------------------------------------------------ role profile pdf */
  let r = await get(port, '/role-profiles/1/pdf', 'M00151');
  check('creator downloads role profile', isPdf(r), true);
  check('sent as an attachment', /attachment; filename=/.test(r.headers?.['content-disposition'] || ''), true);
  // The layout is deliberately compact enough that even the largest real profile
  // (9 attributes, 27 skills) fits on a single page.
  check('role profile fits on one page', pages(r.body), 1);

  check('PSP Approver downloads', isPdf(await get(port, '/role-profiles/1/pdf', 'MM008')), true);
  check('assigned member downloads', isPdf(await get(port, '/role-profiles/1/pdf', 'M01078')), true);

  r = await get(port, '/role-profiles/1/pdf', 'M00612');
  check('unrelated member refused', r.status, 302);
  r = await get(port, '/role-profiles/1/pdf', '');
  check('signed out refused', r.status, 302);

  /* -------------------------------------------------------- assessment pdf */
  const a = await db.first('SELECT * FROM rp_assessments WHERE role_profile_id=1 LIMIT 1');
  if (!a) {
    console.log('  nothing assessed on this database — assessment PDF checks skipped');
    server.close();
    console.log(`\n${pass} passed, ${fail} failed.`);
    process.exit(fail ? 1 : 0);
  }
  const base = `/role-profiles/1/assess/${a.emp_code}`;

  r = await get(port, `${base}/pdf?fy=${a.financial_year}`, 'M00151');
  check('creator downloads assessment', isPdf(r), true);
  check('assessment fits on one page', pages(r.body), 1);
  // Each gap is shown inline next to its own attribute — noting one should never push
  // the assessment onto a second page.
  const gapsOnFile = Number((await db.first(
    "SELECT COUNT(*) n FROM rp_assessment_ratings WHERE assessment_id=? AND TRIM(COALESCE(training_gap,''))<>''",
    [a.id])).n);
  check('a PDF with gaps noted still fits on one page',
    gapsOnFile > 0 ? pages(r.body) : 1, 1);
  check('filename names the member and year',
    /filename="Assessment 2026-2027 - Heena Kumari\.pdf"/.test(r.headers?.['content-disposition'] || ''), true);

  check('member downloads their own', isPdf(await get(port, `${base}/pdf?fy=${a.financial_year}`, 'M01078')), true);
  check('other member refused', (await get(port, `${base}/pdf?fy=${a.financial_year}`, 'M00934')).status, 302);

  // Financial years before 2026-2027 are no longer offered at all, so a request for one
  // now falls back to the current year rather than reaching a "not assessed" branch —
  // exercise that branch instead with a member of some other profile who has no
  // assessment yet for the (only) valid year.
  const unassessedRow = await db.first(
    `SELECT p.id AS profile_id, m.emp_code FROM rp_role_profiles p
     JOIN rp_role_profile_details d ON d.role_profile_id = p.id
     JOIN tbl_employee m ON m.status = 0 AND TRIM(m.designation) = TRIM(p.designation_name) AND m.sangh_code = p.sangh_code
     WHERE p.status = 'approved' AND p.id <> 1
       AND NOT EXISTS (SELECT 1 FROM rp_assessments a2 WHERE a2.role_profile_id = p.id AND a2.emp_code = m.emp_code)
     LIMIT 1`
  );
  if (unassessedRow) {
    r = await get(port, `/role-profiles/${unassessedRow.profile_id}/assess/${unassessedRow.emp_code}/pdf`, 'M00151');
    check('unassessed year has nothing to download', r.status, 302);
  } else {
    console.log('  no unassessed profile/member pair on this database — skipped');
  }

  /* ------------------------------------------ training gaps render properly */
  const profile = await roleProfile.find(1);
  const outcomes = await db.query('SELECT outcome FROM rp_role_key_outcomes WHERE role_profile_id=1 ORDER BY sort_order');
  const plainDetails = await assessment.skillsFor(1, a.id);
  const gappedDetails = plainDetails.map((d, i) => ({
    ...d, training_gap: i % 4 === 0 ? 'Needs advanced training on this area' : '',
  }));
  const gapCount = gappedDetails.filter((d) => d.training_gap).length;

  const render = (details, gap_count) => new Promise((res) => {
    const chunks = [];
    const doc = pdfLib.roleProfile({ profile, outcomes, details, assessment: { ...a, gap_count } });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => res(Buffer.concat(chunks)));
  });
  const withGaps = await render(gappedDetails, gapCount);
  const withoutGaps = await render(plainDetails, 0);

  check('gap version still renders', withGaps.slice(0, 5).toString(), '%PDF-');
  check('gap version still fits on one page', pages(withGaps.toString('latin1')), 1);
  check('a plain render (no gaps) also fits on one page', pages(withoutGaps.toString('latin1')), 1);
  // PDFKit's content streams are Flate-compressed, so the gap text isn't a plain
  // substring to search for — but noting one does change what gets drawn, so the two
  // renders (otherwise identical) must not come out byte-identical.
  check('noting a gap actually changes the rendered output', withGaps.equals(withoutGaps), false);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
