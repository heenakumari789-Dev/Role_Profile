'use strict';
/**
 * The full life of a role profile across years: approve → version 1 → assess →
 * yearly review → update → version 2 → assess against v2, with version 1 and the
 * assessment written against it still readable.
 *
 * Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const http = require('http');
const { build, signIn, freeDesignations, approveFully } = require('./smoke');
const db = require('../src/lib/db');
const version = require('../src/models/version');
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
  return new Promise((resolve) => {
    const req = http.request({ port, path, method: 'POST', headers: {
      'x-test-user': who, 'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || '', body: b })); });
    req.end(body);
  });
}
const get = (port, path, who) => new Promise((r) => {
  http.get({ port, path, headers: { 'x-test-user': who } }, (res) => {
    let b = ''; res.setEncoding('latin1'); res.on('data', c => (b += c));
    res.on('end', () => r({ status: res.statusCode, location: res.headers.location || '', headers: res.headers, body: b }));
  });
});

/** Build the create/edit form body for a profile with 9 attributes totalling 100. */
function profileForm(designation, sangh, mission, outcomes, skillPrefix) {
  const form = { designation_name: designation, sangh_code: sangh, mission, outcomes, action: 'submit' };
  const weights = [12, 11, 11, 11, 11, 11, 11, 11, 11];
  weights.forEach((w, i) => {
    const n = i + 1;
    form[`attribute[${n}]`] = `Attribute ${n}`;
    form[`attribute_weight[${n}]`] = String(w);
    form[`assessment[${n}]`] = '';
    form[`tech_skill[${n}][1]`] = `${skillPrefix} skill ${n}.1`;
    form[`tech_weight[${n}][1]`] = String(w);
  });
  return form;
}

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  const app = build(); const server = app.listen(0); const port = server.address().port;
  const ADMIN = { code: 'MM008', name: 'LMS', isAdmin: true };
  const CREATOR = { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false };
  const MEMBER = { code: 'M01078', name: 'Heena Kumari', isAdmin: false };
  [ADMIN, CREATOR, MEMBER].forEach(signIn);

  const [d] = await freeDesignations(CREATOR.code, CREATOR.name);
  check('a designation is free to write against', !!d, true);
  const DESIG = d.designation;

  /* ------------------------------------------ create, approve → version 1 */
  await post(port, '/role-profiles/store', 'M00151',
    profileForm(DESIG, d.sangh_code, 'Mission as first written.', ['Outcome A', 'Outcome B'], 'Original'));
  const profile = await db.first('SELECT * FROM rp_role_profiles WHERE designation_name=? ORDER BY id DESC LIMIT 1', [DESIG]);
  await approveFully(post, port, profile.id);

  const v1 = await db.first('SELECT * FROM rp_profile_versions WHERE role_profile_id=? ORDER BY version_no', [profile.id]);
  check('approval froze version 1', v1 ? v1.version_no : 'none', 1);
  check('version 1 copied the skills',
    (await db.first('SELECT COUNT(*) n FROM rp_version_details WHERE version_id=?', [v1.id])).n, 9);
  check('version 1 copied the outcomes',
    (await db.first('SELECT COUNT(*) n FROM rp_version_outcomes WHERE version_id=?', [v1.id])).n, 2);
  check('version 1 kept the original mission', v1.mission, 'Mission as first written.');

  const fy = v1.effective_from_year;
  const review1 = await db.first('SELECT * FROM rp_profile_reviews WHERE role_profile_id=? AND financial_year=?', [profile.id, fy]);
  check('approval settled the current year', review1 ? review1.outcome : 'none', 'created');

  // A year the profile predates is never asked to be reviewed. Checked here, before the
  // "previous year" steps further down deliberately review that same year for real.
  const fyStart = Number(fy.split('-')[0]);
  const priorYear = `${fyStart - 1}-${fyStart}`;
  const beforeBirth = (await get(port, `/role-profiles?fy=${priorYear}`, 'M00151')).body;
  const stripTags = (t) => String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fyCellFor = (id, body) => {
    const rows = [...body.matchAll(/<tr>[\s\S]*?<\/tr>/g)];
    const mine = rows.find((r) => r[0].includes(`/role-profiles/${id}"`));
    if (!mine) return '';
    const cell = mine[0].match(/<td>\s*(?:<span class="rp-review-tag|<span class="rp-none")[\s\S]*?<\/td>/);
    return cell ? stripTags(cell[0]) : '';
  };
  check('a year before the profile existed says so',
    /did not exist yet/.test(fyCellFor(profile.id, beforeBirth)), true);
  check('no review is demanded for it', /still need/.test(beforeBirth), false);

  /* --------------------------------------------- assess against version 1 */
  // Only the admin assigns members.
  await post(port, `/role-profiles/${profile.id}/assign-members`, 'MM008', { 'emp_codes[]': ['M01078'] });
  const v1Skills = await db.query('SELECT id, tech_weight FROM rp_version_details WHERE version_id=? ORDER BY id', [v1.id]);
  const ratings = { financial_year: fy };
  v1Skills.forEach((sk) => { ratings[`rating[d${sk.id}]`] = '3'; });
  ratings[`gap[d${v1Skills[0].id}]`] = 'Original gap note';

  await post(port, `/role-profiles/${profile.id}/assess/M01078`, 'M00151', ratings);
  const a1 = await db.first('SELECT * FROM rp_assessments WHERE role_profile_id=? AND financial_year=?', [profile.id, fy]);
  check('assessment recorded', a1 ? Number(a1.percentage) : 'none', 75);
  check('assessment names its version', Number(a1.version_id), Number(v1.id));
  check('ratings point at version rows',
    (await db.first('SELECT COUNT(*) n FROM rp_assessment_ratings WHERE assessment_id=? AND version_detail_id IS NOT NULL', [a1.id])).n, 9);

  /* ------------- each rating must land on the skill it was entered against ------ */
  // Distinct values, so any renumbering by the query parser shows up immediately.
  const distinct = { financial_year: fy };
  const expected = new Map();
  const expectedGap = new Map();
  v1Skills.forEach((sk, i) => {
    // Ratings are whole numbers only now; still varied enough (no two neighbours equal)
    // to catch a renumbering bug the same way distinct values did before.
    const value = [1, 2, 3, 4, 2, 3, 4, 1, 3][i];
    distinct[`rating[d${sk.id}]`] = String(value);
    expected.set(Number(sk.id), value);
    // A rating of 2 or below now requires its own gap noted, same as everywhere else.
    if (value <= 2) {
      distinct[`gap[d${sk.id}]`] = `Gap for skill ${i}`;
      expectedGap.set(Number(sk.id), `Gap for skill ${i}`);
    }
  });
  distinct[`gap[d${v1Skills[3].id}]`] = 'Gap against the fourth skill only';
  expectedGap.set(Number(v1Skills[3].id), 'Gap against the fourth skill only');

  await post(port, `/role-profiles/${profile.id}/assess/M01078`, 'MM008', distinct);
  const stored = await db.query(
    'SELECT version_detail_id, rating, training_gap FROM rp_assessment_ratings WHERE assessment_id=?', [a1.id]);
  const wrong = stored.filter((row) => Number(row.rating) !== expected.get(Number(row.version_detail_id)));
  check('every rating stayed with its own skill', wrong.length, 0);
  const gapWrong = stored.filter((row) =>
    (row.training_gap || '') !== (expectedGap.get(Number(row.version_detail_id)) || ''));
  check('the gap stayed on the skill it was typed against', gapWrong.length, 0);

  const expTotal = v1Skills.reduce((t, sk) => t + Number(sk.tech_weight) * expected.get(Number(sk.id)), 0);
  check('total matches the distinct ratings',
    Number((await db.first('SELECT total_score FROM rp_assessments WHERE id=?', [a1.id])).total_score),
    Math.round(expTotal * 100) / 100);

  // Put the uniform 3s back so the later checks read as before.
  await post(port, `/role-profiles/${profile.id}/assess/M01078`, 'MM008', ratings);

  /* ------------------------------------------------ the next year: review */
  const nextStart = Number(fy.split('-')[0]) + 1;
  const nextFy = `${nextStart}-${nextStart + 1}`;
  await db.run("INSERT IGNORE INTO tbl_financial_year (year, month1,month2,month3,month4,month5,month6,month7,month8,month9,month10,month11,month12, status) VALUES (?, '','','','','','','','','','','','', '0')", [nextFy]);

  check('next year starts unreviewed', await version.reviewDue(profile.id, nextFy), true);

  /* ------------------------- edit → resubmit → approve again → version 2 */
  const edit = profileForm(DESIG, d.sangh_code, 'Mission after the yearly review.', ['Outcome A', 'Outcome B', 'Outcome C'], 'Revised');
  await post(port, `/role-profiles/${profile.id}/update`, 'M00151', edit);
  await approveFully(post, port, profile.id);

  const versions = await db.query('SELECT * FROM rp_profile_versions WHERE role_profile_id=? ORDER BY version_no', [profile.id]);
  check('second approval froze version 2', versions.length, 2);
  const v2 = versions[1];
  check('version 2 has the new mission', v2.mission, 'Mission after the yearly review.');
  check('version 1 still has the old mission',
    (await db.first('SELECT mission FROM rp_profile_versions WHERE id=?', [v1.id])).mission, 'Mission as first written.');
  check('version 1 skills untouched by the edit',
    (await db.first("SELECT COUNT(*) n FROM rp_version_details WHERE version_id=? AND tech_skill LIKE 'Original%'", [v1.id])).n, 9);
  check('version 2 has the revised skills',
    (await db.first("SELECT COUNT(*) n FROM rp_version_details WHERE version_id=? AND tech_skill LIKE 'Revised%'", [v2.id])).n, 9);

  /* --------------------------- the old assessment still reads as it did */
  const oldSkills = await version.detailsFor(v1.id, a1.id);
  check('old assessment still has 9 rated lines', oldSkills.filter(s => s.rating != null).length, 9);
  check('old assessment still shows the original wording',
    oldSkills.every(s => String(s.tech_skill).startsWith('Original')), true);
  check('old assessment gap survived',
    oldSkills.filter(s => String(s.training_gap || '').trim()).length, 1);
  check('old assessment total unchanged',
    Number((await db.first('SELECT total_score FROM rp_assessments WHERE id=?', [a1.id])).total_score),
    Number(a1.total_score));

  /* --------------------------------------- the version 1 page still works */
  let r = await get(port, `/role-profiles/${profile.id}/versions/${v1.id}`, 'M00151');
  check('version 1 page renders', r.status, 200);
  check('version 1 page shows the original mission', /Mission as first written\./.test(r.body), true);
  check('version 1 page marked superseded', /revised since/.test(r.body), true);

  r = await get(port, `/role-profiles/${profile.id}/versions/${v1.id}/pdf`, 'M00151');
  check('version 1 PDF downloads', r.status === 200 && r.body.slice(0, 5) === '%PDF-', true);

  r = await get(port, `/role-profiles/${profile.id}/assess/M01078/pdf?fy=${fy}`, 'M00151');
  check('old assessment PDF still builds', r.status === 200 && r.body.slice(0, 5) === '%PDF-', true);

  /* ----------------------------- assessment is blocked until the year is settled */
  // Use the previous financial year: it is open for entry and has no review yet, so the
  // review gate is what is being tested rather than the closed-year rule.
  const prevStart = Number(fy.split('-')[0]) - 1;
  const prevFy = `${prevStart}-${prevStart + 1}`;
  check('previous year is open', await require('../src/models/financialYear').isOpen(prevFy), true);
  check('previous year starts unreviewed', await version.reviewDue(profile.id, prevFy), true);

  const v2Skills = await db.query('SELECT id, tech_weight FROM rp_version_details WHERE version_id=? ORDER BY id', [v2.id]);
  const prevRatings = { financial_year: prevFy };
  v2Skills.forEach((sk) => { prevRatings[`rating[d${sk.id}]`] = '4'; });

  let rr = await post(port, `/role-profiles/${profile.id}/assess/M01078`, 'M00151', prevRatings);
  check('assessing an unreviewed year is refused',
    (await db.first('SELECT COUNT(*) n FROM rp_assessments WHERE role_profile_id=? AND financial_year=?', [profile.id, prevFy])).n, 0);
  check('refusal points at the review', /tab=versions/.test(rr.location), true);

  /* ------------------------------------- record "no change" and assess again */
  await post(port, `/role-profiles/${profile.id}/review`, 'M00151', { financial_year: prevFy, note: 'Still accurate' });
  const carried = await db.first('SELECT * FROM rp_profile_reviews WHERE role_profile_id=? AND financial_year=?', [profile.id, prevFy]);
  check('review recorded for that year', carried ? carried.outcome : 'none', 'unchanged');
  check('review carried the latest version forward', Number(carried.version_id), Number(v2.id));
  check('a second review of the same year is refused',
    (await post(port, `/role-profiles/${profile.id}/review`, 'M00151', { financial_year: prevFy })).location.includes('tab=versions'), true);
  check('the second review did not overwrite the first',
    (await db.first('SELECT COUNT(*) n FROM rp_profile_reviews WHERE role_profile_id=? AND financial_year=?', [profile.id, prevFy])).n, 1);

  await post(port, `/role-profiles/${profile.id}/assess/M01078`, 'M00151', prevRatings);
  const a2 = await db.first('SELECT * FROM rp_assessments WHERE role_profile_id=? AND financial_year=?', [profile.id, prevFy]);
  check('that year assessed once settled', a2 ? Number(a2.percentage) : 'none', 100);
  check('new assessment bound to version 2', Number(a2.version_id), Number(v2.id));
  check('both assessments coexist',
    (await db.first('SELECT COUNT(*) n FROM rp_assessments WHERE role_profile_id=?', [profile.id])).n, 2);

  const newSkills = await version.detailsFor(v2.id, a2.id);
  check('new assessment reads the revised wording',
    newSkills.every(s => String(s.tech_skill).startsWith('Revised')), true);

  // And the earlier assessment is still exactly as it was.
  const stillOld = await version.detailsFor(v1.id, a1.id);
  check('earlier assessment unaffected by the newer one',
    stillOld.every(s => String(s.tech_skill).startsWith('Original')) && stillOld.filter(s => s.rating != null).length === 9, true);

  check('a closed year cannot be reviewed',
    (await post(port, `/role-profiles/${profile.id}/review`, 'M00151', { financial_year: '2019-2020' })).location.includes('tab=versions'), true);
  check('no review row was written for the closed year',
    (await db.first("SELECT COUNT(*) n FROM rp_profile_reviews WHERE role_profile_id=? AND financial_year='2019-2020'", [profile.id])).n, 0);

  /* ------------------------- a save that changes nothing leaves no trace ------- */
  const before = (await db.first(
    "SELECT COUNT(*) n FROM rp_role_profile_history WHERE role_profile_id=? AND action='assessed'", [profile.id])).n;
  await post(port, `/role-profiles/${profile.id}/assess/M01078`, 'MM008', ratings);
  check('re-saving identical ratings adds no history row',
    (await db.first("SELECT COUNT(*) n FROM rp_role_profile_history WHERE role_profile_id=? AND action='assessed'", [profile.id])).n,
    before);

  // But a real change still logs.
  const tweak = { ...ratings };
  tweak[`rating[d${v1Skills[0].id}]`] = '4';
  await post(port, `/role-profiles/${profile.id}/assess/M01078`, 'MM008', tweak);
  check('a real change still logs',
    (await db.first("SELECT COUNT(*) n FROM rp_role_profile_history WHERE role_profile_id=? AND action='assessed'", [profile.id])).n,
    Number(before) + 1);
  // Put it back.
  await post(port, `/role-profiles/${profile.id}/assess/M01078`, 'MM008', ratings);

  /* ------------------------------------- the year table on the profile page */
  const page = (await get(port, `/role-profiles/${profile.id}?tab=versions`, 'M00151')).body;
  check('year table rendered', /Financial year<\/th>/.test(page), true);
  const listed = [...page.matchAll(/<span class="rp-year-tag">([^<]+)<\/span>/g)].map(m => m[1]);
  check('current year listed', listed.includes(fy), true);
  check('previous year listed once it carries a review', listed.includes(prevFy), true);
  // Old years appear only because they carry a review; nothing older is offered up.
  check('no unreviewed year older than the first version',
    listed.filter(y => y < v1.effective_from_year).every(y => y === prevFy), true);
  check('a long-past year is not listed at all', listed.includes('2019-2020'), false);
  check('a settled year offers no review button',
    /No change/.test(page), false);
  check('the draft box is not shown on an approved profile', /This is your draft/.test(page), false);

  /* ------------------------ the list page reads a year at a time ------------- */
  const strip = (t) => String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fyCell = (body) => {
    const rows = [...body.matchAll(/<tr>[\s\S]*?<\/tr>/g)];
    const mine = rows.find((r) => r[0].includes(`/role-profiles/${profile.id}"`));
    if (!mine) return '';
    const cell = mine[0].match(/<td>\s*(?:<span class="rp-review-tag|<span class="rp-none")[\s\S]*?<\/td>/);
    return cell ? strip(cell[0]) : '';
  };

  let list = (await get(port, `/role-profiles?fy=${fy}`, 'M00151')).body;
  check('list has a financial-year picker', /name="fy"/.test(list), true);
  check('settled year shows its version', /v2/.test(fyCell(list)), true);

  // Simulate the new year arriving: the year loses its review, so it falls due.
  const saved = await db.first('SELECT * FROM rp_profile_reviews WHERE role_profile_id=? AND financial_year=?', [profile.id, fy]);
  await db.run('DELETE FROM rp_profile_reviews WHERE id=?', [saved.id]);

  list = (await get(port, `/role-profiles?fy=${fy}`, 'M00151')).body;
  check('an unreviewed open year reads "Review due"', /Review due/.test(fyCell(list)), true);
  check('it names the version that would apply', /would be v2/.test(fyCell(list)), true);
  check('the banner counts it', /still need/.test(list), true);
  check('the action becomes Review', new RegExp(`Review ${fy}`).test(list), true);

  // Put the review back so later checks see the settled state.
  await db.run(
    `INSERT INTO rp_profile_reviews
       (role_profile_id, financial_year, version_id, outcome, reviewed_by, reviewed_by_name, note, reviewed_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [saved.role_profile_id, saved.financial_year, saved.version_id, saved.outcome,
     saved.reviewed_by, saved.reviewed_by_name, saved.note, saved.reviewed_at]);

  /* ------------------- the totals row reads the same in both views ------------- */
  // Gaps live on the rows; the locked view has no inputs to count, so the number has to
  // come from the data or it silently reads zero.
  const gapRatings = { financial_year: fy };
  v1Skills.forEach((sk) => { gapRatings[`rating[d${sk.id}]`] = '3'; });
  gapRatings[`gap[d${v1Skills[0].id}]`] = 'Gap one';
  gapRatings[`gap[d${v1Skills[2].id}]`] = 'Gap two';
  gapRatings[`gap[d${v1Skills[4].id}]`] = 'Gap three';
  await post(port, `/role-profiles/${profile.id}/assess/M01078`, 'MM008', gapRatings);

  const storedGaps = Number((await db.first(
    'SELECT gap_count FROM rp_assessments WHERE id=?', [a1.id])).gap_count);
  check('three gaps were stored', storedGaps, 3);

  const gapCountIn = (body) => (body.match(/id="gapCount">(\d+)</) || [])[1];

  const editable = (await get(port, `/role-profiles/${profile.id}/assess/M01078?fy=${fy}`, 'MM008')).body;
  check('the editable view counts the gaps', gapCountIn(editable), String(storedGaps));
  check('and it has the gap inputs', /class="rp-gap js-gap"/.test(editable), true);

  const locked = (await get(port, `/role-profiles/${profile.id}/assess/M01078?fy=${fy}`, 'M00151')).body;
  check('the locked view has no gap inputs', /class="rp-gap js-gap"/.test(locked), false);
  check('but still counts the gaps', gapCountIn(locked), String(storedGaps));
  check('and shows each one', (locked.match(/rp-gap-read(?! none)/g) || []).length, storedGaps);

  // Back to the uniform ratings the later checks expect.
  await post(port, `/role-profiles/${profile.id}/assess/M01078`, 'MM008', ratings);

  /* -------------------- the Assess button lands on the assessment screen ------- */
  const rpList = (await get(port, `/role-profiles?fy=${fy}`, 'M00151')).body;
  const assessHref = (rpList.match(/href="([^"]*)"[^>]*>\s*<i class="mdi mdi-clipboard-edit-outline"/) || [])[1] || '';
  check('the Assess button points at the assessments page',
    /^\/assessments\?/.test(assessHref.replace(/&amp;/g, '&')), true);
  check('and names the profile it came from', /profile=\d+/.test(assessHref), true);

  const landed = await get(port, assessHref.replace(/&amp;/g, '&'), 'M00151');
  check('that page opens', landed.status, 200);
  check('it says it is narrowed to that profile', /Showing only/.test(landed.body), true);
  check('and offers a way back to everyone', /Show everyone/.test(landed.body), true);
  check('it carries an assess link for the member', /\/assess\//.test(landed.body), true);

  // An unknown profile is ignored rather than showing an empty page.
  const bogusFilter = await get(port, `/assessments?fy=${fy}&profile=999999`, 'M00151');
  check('an unknown profile filter falls back to everyone',
    /Showing only/.test(bogusFilter.body), false);

  /* ------------------------------------------------------- history record */
  check('yearly review logged in history',
    (await db.first("SELECT COUNT(*) n FROM rp_role_profile_history WHERE role_profile_id=? AND action='reviewed'", [profile.id])).n, 1);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
