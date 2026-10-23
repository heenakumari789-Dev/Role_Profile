'use strict';
const { build, signIn, get } = require('./smoke');
const db = require('../src/lib/db');

const U = {
  MM008:  { code: 'MM008',  name: 'LMS', isAdmin: true },
  M00151: { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false },
  M01078: { code: 'M01078', name: 'Heena Kumari', isAdmin: false },
  M00934: { code: 'M00934', name: 'Amit Kumar', isAdmin: false },
};

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
}
const rows = (b, id) => {
  const m = b.match(new RegExp(`<table[^>]*id="${id}"[\\s\\S]*?<tbody>([\\s\\S]*?)</tbody>`));
  return m ? (m[1].match(/<tr[\s>]/g) || []).length : -1;
};
const count = (b, re) => (b.match(re) || []).length;

(async () => {
  const app = build(); const server = app.listen(0); const port = server.address().port;
  for (const u of Object.values(U)) signIn(u);
  const G = (p, who) => get(port, p, who).then(r => r.body);

  // --- member list (admin) --------------------------------------------------
  // The app leaves SS/SS1 out — they belong to LDP, not PSP.
  const SCOPE = "status=0 AND sangh_code NOT IN ('SS','SS1')";
  const active = (await db.first(`SELECT COUNT(*) n FROM tbl_employee WHERE ${SCOPE}`)).n;
  const list = await G('/', 'MM008');
  check('member list rows', rows(list, 'memberTable'), active);

  // --- assign by member -----------------------------------------------------
  const assign = await G('/assign', 'MM008');
  check('assign rows', rows(assign, 'assignTable'), active);
  for (const role of ['sevak', 'sanghrakshak', 'pracharak']) {
    // Pracharak falls back to pakka_lms.emp_master when tbl_employee has none — same as getDirectory().
    const col = role === 'pracharak'
      ? "COALESCE(NULLIF(TRIM(e.pracharak_name),''), NULLIF(TRIM(m.pracharak_name),''), '')"
      : `e.${role}_name`;
    const set = (await db.first(
      `SELECT COUNT(*) n FROM tbl_employee e
       LEFT JOIN pakka_lms.emp_master m ON m.emp_code = e.emp_code
       WHERE e.status=0 AND e.sangh_code NOT IN ('SS','SS1') AND TRIM(${col})<>''`)).n;
    const shown = Number((assign.match(new RegExp(`<div class="n">([\\d,]+) <span[^>]*>/`, 'g')) || [])[['sevak','sanghrakshak','pracharak'].indexOf(role)]?.match(/([\d,]+)/)[1].replace(/,/g,'') || -1);
    check(`assign coverage ${role}`, shown, set);
  }

  // --- assign by sangh ------------------------------------------------------
  // Members with no sangh code cannot be assigned as a sangh, so they form no row.
  const sanghCount = (await db.first(
    `SELECT COUNT(DISTINCT sangh_code) n FROM tbl_employee WHERE ${SCOPE} AND TRIM(sangh_code)<>''`)).n;
  const bySangh = await G('/assign/sangh', 'MM008');
  check('sangh rows', rows(bySangh, 'sanghTable'), sanghCount);

  const mssActive = (await db.first(`SELECT COUNT(*) n FROM tbl_employee WHERE ${SCOPE} AND sangh_code='MSS'`)).n;
  const mss = await G('/assign/sangh/MSS', 'MM008');
  check('MSS member rows', rows(mss, 'sanghMemberTable'), mssActive);
  check('MSS bulk checkboxes', count(mss, /<input type="checkbox" class="rp-check js-row-check">/g), mssActive);

  // --- my members -----------------------------------------------------------
  const led = (await db.first(
    "SELECT COUNT(*) n FROM tbl_employee WHERE status=0 AND (sevak_code='M00151' OR sanghrakshak_code='M00151' OR pracharak_code='M00151') AND sangh_code NOT IN ('SS','SS1')")).n;
  const mine = await G('/my-members', 'M00151');
  check('my members rows', rows(mine, 'myMemberTable'), led);

  // --- role profile ---------------------------------------------------------
  // These read whatever profile the database holds; on a cleared portal there is none,
  // and the write suites cover that ground anyway.
  const live = await db.first("SELECT id FROM rp_role_profiles WHERE status='approved' ORDER BY id LIMIT 1");
  if (!live) {
    console.log('\n  no approved role profile on this database — profile and assessment checks skipped');
    server.close();
    console.log(`\n${pass} passed, ${fail} failed.`);
    process.exit(fail ? 1 : 0);
  }

  const attrs = (await db.first('SELECT COUNT(DISTINCT attribute_no) n FROM rp_role_profile_details WHERE role_profile_id=1')).n;
  const outcomes = (await db.first('SELECT COUNT(*) n FROM rp_role_key_outcomes WHERE role_profile_id=1')).n;
  const hist = (await db.first('SELECT COUNT(*) n FROM rp_role_profile_history WHERE role_profile_id=1')).n;
  const show = await G('/role-profiles/1', 'M00151');
  check('profile attribute rows', count(show, /class="rp-attr-name"/g), attrs);
  check('profile outcomes', count(show.match(/<ul class="rp-outcomes">[\s\S]*?<\/ul>/)[0], /<li/g), outcomes);
  check('history events', count(show, /class="rp-hist-dot/g), hist);
  // Only explicitly assigned members get a Remove form; designation holders have none.
  const pinned = (await db.first(
    'SELECT COUNT(*) n FROM rp_role_profile_members WHERE role_profile_id=1')).n;
  check('a Remove form per assigned member', count(show, /unassign-member/g), pinned);
  check('designation holders have no Remove form',
    count(show, /rp-src-auto/g) > 0 && count(show, /unassign-member/g) < count(show, /rp-src-/g), true);
  check('member view hides unassign', count(await G('/role-profiles/1', 'M01078'), /unassign-member/g), 0);

  // --- assessment -----------------------------------------------------------
  const skills = (await db.first(
    "SELECT COUNT(*) n FROM rp_role_profile_details WHERE role_profile_id=1 AND TRIM(COALESCE(tech_skill,''))<>''")).n;
  const a = await db.first('SELECT * FROM rp_assessments WHERE role_profile_id=1 LIMIT 1');

  if (a) {
    const who = a.emp_code;
    const asAdmin = await G(`/role-profiles/1/assess/${who}`, 'MM008');
    check('assess skill rows (admin)', count(asAdmin, /class="rp-rating js-rating/g), skills);
    check('assess editable for PSP Approver', count(asAdmin, /rp-btn-save/g) > 0, true);
    check('assess shows stored %',
      new RegExp(`>${Number(a.percentage)}%|>${Number(a.percentage).toFixed(2)}`).test(asAdmin)
      || asAdmin.includes('grandPct'), true);

    const asAuthor = await G(`/role-profiles/1/assess/${who}`, 'M00151');
    check('assess locked for RP Creator (already done)', /rp-btn-save/.test(asAuthor), false);
    check('locked message present', /cannot be changed/.test(asAuthor), true);

    // A year the master does not know is ignored and the current year is shown instead.
    const bogus = await G(`/role-profiles/1/assess/${who}?fy=2099-2100`, 'M00151');
    check('unknown FY falls back to current', /value="2026-2027"/.test(bogus), true);

    // A real but long-past year is closed to everyone.
    const old = await db.first(
      "SELECT year FROM tbl_financial_year WHERE year < '2025-2026' ORDER BY year DESC LIMIT 1");
    if (old) {
      const oldPage = await G(`/role-profiles/1/assess/${who}?fy=${old.year}`, 'MM008');
      check(`closed year ${old.year} locked for PSP Approver`,
        /is closed/.test(oldPage) && !/rp-btn-save/.test(oldPage), true);
    }
  } else {
    console.log('  nothing assessed on this database — assessment checks skipped');
  }

  // Whoever the profile applies to who has not been assessed yet.
  const roleProfile = require('../src/models/roleProfile');
  const holders = await roleProfile.effectiveMembers(await roleProfile.find(1));
  const assessed = new Set((await db.query('SELECT emp_code FROM rp_assessments WHERE role_profile_id=1'))
    .map((r) => r.emp_code));
  const fresh = holders.find((m) => !assessed.has(m.emp_code));
  if (fresh) {
    const unassessed = await G(`/role-profiles/1/assess/${fresh.emp_code}`, 'M00151');
    check('unassessed member editable by creator', /rp-btn-save/.test(unassessed), true);
    check('unassessed has gap inputs', count(unassessed, /class="rp-gap js-gap"/g), skills);
    check('unassessed ratings blank', count(unassessed, /js-rating unrated/g), skills);
  }

  const alist = await G('/assessments', 'M00151');
  check('assessment list renders', rows(alist, 'assessTable') >= 0, true);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
