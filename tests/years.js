'use strict';
/** Financial-year rules: auto-add, and who may write in which year. Sandbox only. */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const http = require('http');
const { build, signIn, approveFully } = require('./smoke');
const db = require('../src/lib/db');
const fy = require('../src/models/financialYear');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};
const get = (port, path, who) => new Promise((r) => {
  http.get({ port, path, headers: { 'x-test-user': who } }, (res) => {
    let b = ''; res.on('data', c => (b += c)); res.on('end', () => r({ status: res.statusCode, body: b }));
  });
});

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
      (res) => { let b = ''; res.on('data', (c) => (b += c));
                 res.on('end', () => r({ status: res.statusCode, location: res.headers.location || '', body: b })); });
    req.end(body);
  });
}

/** An approved profile with one member already assessed for the current year. */
async function makeAssessedProfile(port) {
  const { freeDesignations } = require('./smoke');
  const roleProfileModel = require('../src/models/roleProfile');
  const [d] = await freeDesignations('M00151', 'Ujjwal Agarwal');
  if (!d) return null;

  const form = { designation_name: d.designation, sangh_code: d.sangh_code,
                 mission: 'Year rules fixture.', outcomes: ['One'], action: 'submit' };
  [12, 11, 11, 11, 11, 11, 11, 11, 11].forEach((w, i) => {
    const n = i + 1;
    form[`attribute[${n}]`] = `Attribute ${n}`;
    form[`attribute_weight[${n}]`] = String(w);
    form[`assessment[${n}]`] = '';
    form[`tech_skill[${n}][1]`] = `Skill ${n}.1`;
    form[`tech_weight[${n}][1]`] = String(w);
  });
  await post(port, '/role-profiles/store', 'M00151', form);
  const profile = await db.first(
    'SELECT * FROM rp_role_profiles WHERE designation_name=? AND sangh_code=? ORDER BY id DESC LIMIT 1',
    [d.designation, d.sangh_code]);
  await approveFully(post, port, profile.id);

  const approved = await roleProfileModel.find(profile.id);
  const [holder] = await roleProfileModel.effectiveMembers(approved);
  if (!holder) return null;

  const skills = await db.query(
    `SELECT vd.id FROM rp_version_details vd
     JOIN rp_profile_versions v ON v.id = vd.version_id
     WHERE v.role_profile_id = ? ORDER BY vd.id`, [profile.id]);
  const ratings = { financial_year: fy.yearFor() };
  skills.forEach((sk) => { ratings[`rating[d${sk.id}]`] = '3'; });
  await post(port, `/role-profiles/${profile.id}/assess/${holder.emp_code}`, 'M00151', ratings);

  return { profile: approved, empCode: holder.emp_code };
}

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  const current = fy.yearFor();
  const prevStart = Number(current.split('-')[0]) - 1;
  const previous = `${prevStart}-${prevStart + 1}`;
  console.log(`  current=${current}  previous=${previous}`);

  /* ---------------------------------------------------------- auto-add */
  // Note what the shared master looks like, then take this year out of it.
  const others = await db.query('SELECT year, status FROM tbl_financial_year WHERE year <> ?', [current]);
  await db.run('DELETE FROM tbl_financial_year WHERE year = ?', [current]);
  check('current year removed', (await db.first('SELECT COUNT(*) n FROM tbl_financial_year WHERE year=?', [current])).n, 0);

  const app = build(); const server = app.listen(0); const port = server.address().port;
  const ADMIN = { code: 'MM008', name: 'LMS', isAdmin: true };
  const CREATOR = { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false };
  [ADMIN, CREATOR].forEach(signIn);

  await get(port, '/assessments', 'MM008');
  const readded = await db.first('SELECT year, status FROM tbl_financial_year WHERE year=?', [current]);
  check('current year added on its own', readded ? readded.year : 'missing', current);
  check('added year carries the current flag', readded ? readded.status : '?', '1');
  const full = await db.first('SELECT * FROM tbl_financial_year WHERE year=?', [current]);
  check('month labels filled', [full.month1, full.month9, full.month10, full.month12].join(' '),
    fy.monthLabels(current).filter((_, i) => [0, 8, 9, 11].includes(i)).join(' '));

  check('exactly one year flagged current',
    (await db.first("SELECT COUNT(*) n FROM tbl_financial_year WHERE status='1'")).n, 1);
  const after = await db.query("SELECT year FROM tbl_financial_year WHERE year <> ? AND status='1'", [current]);
  check('no older year still flagged', after.length, 0);
  check('other years otherwise untouched',
    (await db.first('SELECT COUNT(*) n FROM tbl_financial_year')).n, others.length + 1);

  /* ------------------------------------------- flag pulled back if moved away */
  await db.run("UPDATE tbl_financial_year SET status='0' WHERE year=?", [current]);
  await db.run("UPDATE tbl_financial_year SET status='1' WHERE year=?", [previous]);
  await get(port, '/assessments', 'MM008');
  check('flag pulled back onto the calendar year',
    (await db.first('SELECT status FROM tbl_financial_year WHERE year=?', [current])).status, '1');
  check('previous year cleared',
    (await db.first('SELECT status FROM tbl_financial_year WHERE year=?', [previous])).status, '0');

  // Nothing to do on a normal load: the flag is already right.
  const snapshot = JSON.stringify(await db.query('SELECT year, status FROM tbl_financial_year ORDER BY id'));
  await get(port, '/assessments', 'MM008');
  check('leaves the table alone when already correct',
    JSON.stringify(await db.query('SELECT year, status FROM tbl_financial_year ORDER BY id')), snapshot);

  /* ------------------------------------------------------ open / closed */
  check('current open', await fy.isOpen(current), true);
  check('previous open', await fy.isOpen(previous), true);
  const older = `${prevStart - 1}-${prevStart}`;
  check(`${older} closed`, await fy.isOpen(older), false);

  /* ----------------------------------------------- who may write, by year */
  // Build the fixture here: an approved profile with one member assessed for this year.
  const fixture = await makeAssessedProfile(port);
  check('a profile was set up to test the year rules on', !!fixture, true);
  const profile = fixture.profile;
  const member = { emp_code: fixture.empCode };
  const url = (y, ) => `/role-profiles/${profile.id}/assess/${member.emp_code}?fy=${encodeURIComponent(y)}`;
  const editable = (body) => /rp-btn-save/.test(body);

  // Make sure every year under test exists in the master, so ?fy= is honoured.
  for (const y of [previous, older]) {
    if (!(await db.first('SELECT id FROM tbl_financial_year WHERE year=?', [y]))) {
      await db.run('INSERT INTO tbl_financial_year (year, status) VALUES (?, 0)', [y]);
    }
  }

  // The one stored assessment is for the current year.
  const stored = await db.first(
    'SELECT financial_year FROM rp_assessments WHERE role_profile_id=? AND emp_code=?', [profile.id, member.emp_code]);
  check('the fixture was assessed for this year', stored ? stored.financial_year : 'none', current);

  check('PSP Approver may correct current year', editable((await get(port, url(current), 'MM008')).body), true);
  check('PSP Approver may write last year', editable((await get(port, url(previous), 'MM008')).body), true);
  // An older year is not just closed but not offered at all (financialYear.years() only
  // ever spans current + previous) — ?fy= for one no longer reaches a "closed" page for
  // it, it silently falls back to the current year instead.
  check('PSP Approver falls back to current year for an older year',
    editable((await get(port, url(older), 'MM008')).body), true);
  check('older year is simply not offered, so no page for it is ever "closed"',
    /is closed/.test((await get(port, url(older), 'MM008')).body), false);

  check('RP Creator done for current year', editable((await get(port, url(current), 'M00151')).body), false);
  check('RP Creator may assess last year', editable((await get(port, url(previous), 'M00151')).body), true);
  check('RP Creator falls back to current year for an older year (already assessed there)',
    editable((await get(port, url(older), 'M00151')).body), false);

  // The picker must actually offer the open years.
  const page = (await get(port, url(current), 'MM008')).body;
  check('picker offers current', page.includes(`value="${current}"`), true);
  check('picker offers previous', page.includes(`value="${previous}"`), true);
  check('picker marks current', new RegExp(`${current}\\s*—\\s*current`).test(page), true);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
