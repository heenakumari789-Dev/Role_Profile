'use strict';
/**
 * Write-path tests. Runs entirely against the sandbox schema (DB_NAME is overridden
 * before anything loads config), so the live database is never written to.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const http = require('http');
const { build, signIn } = require('./smoke');
const db = require('../src/lib/db');
const leader = require('../src/models/leader');

/** A real candidate key for a role, the same value the picker would submit. */
async function candidateKey(role, notKey) {
  const list = await leader.candidates(role);
  const pick = list.find((c) => (c.emp_code || c.name) !== notKey) || list[0];
  return pick ? (pick.emp_code !== '' ? pick.emp_code : pick.name) : '';
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
}

function post(port, path, who, form) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    // Repeat the key for arrays, the way a browser posts checkbox groups.
    if (Array.isArray(v)) v.forEach((one) => params.append(k, one));
    else params.append(k, v);
  }
  params.append('csrf_test_name', 'test-token');
  const body = params.toString();
  return new Promise((resolve) => {
    const req = http.request(
      { port, path, method: 'POST', headers: {
        'x-test-user': who, 'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || '', body: b })); }
    );
    req.end(body);
  });
}
const get = (port, path, who) => new Promise((resolve) => {
  http.get({ port, path, headers: { 'x-test-user': who } }, (res) => {
    let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || '', body: b }));
  });
});

(async () => {
  check('running against sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  const app = build(); const server = app.listen(0); const port = server.address().port;
  const ADMIN = { code: 'MM008', name: 'LMS', isAdmin: true };
  const CREATOR = { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false };
  const MEMBER = { code: 'M01078', name: 'Heena Kumari', isAdmin: false };
  [ADMIN, CREATOR, MEMBER].forEach(signIn);

  /* ---------------------------------------------------------- assignments */
  const victim = await db.first(
    "SELECT emp_code, sevak_code, sevak_name FROM tbl_employee WHERE status=0 AND sangh_code='MSS' LIMIT 1");
  const newSevak = { c: await candidateKey('sevak', victim.sevak_code || '') };

  let r = await post(port, '/assign/save', 'MM008', { emp_code: victim.emp_code, role: 'sevak', person_code: newSevak.c });
  check('assign/save status', r.status, 200);
  check('assign/save persisted',
    (await db.first('SELECT sevak_code c FROM tbl_employee WHERE emp_code=?', [victim.emp_code])).c, newSevak.c);

  r = await post(port, '/assign/save', 'MM008', { emp_code: victim.emp_code, role: 'sevak', person_code: 'NOT-A-PERSON' });
  check('assign/save rejects unknown person', r.status, 422);

  r = await post(port, '/assign/save', 'M01078', { emp_code: victim.emp_code, role: 'sevak', person_code: '' });
  check('assign/save blocked for non-admin', r.status, 302);

  r = await post(port, '/assign/save', 'MM008', { emp_code: victim.emp_code, role: 'sevak', person_code: '' });
  check('assign/save can clear',
    (await db.first('SELECT sevak_name n FROM tbl_employee WHERE emp_code=?', [victim.emp_code])).n, '');

  const before = (await db.first("SELECT COUNT(*) n FROM tbl_employee WHERE status=0 AND sangh_code='YSS'")).n;
  // Assigning to a whole sangh may only pick that sangh's own active members.
  const yssMember = await db.first(
    "SELECT emp_code FROM tbl_employee WHERE status=0 AND sangh_code='YSS' AND TRIM(name)<>'' LIMIT 1");
  r = await post(port, '/assign/save-sangh', 'MM008',
    { sangh_code: 'YSS', role: 'pracharak', person_code: yssMember.emp_code });
  check('assign/save-sangh affected', JSON.parse(r.body).affected, before);

  const three = (await db.query("SELECT emp_code FROM tbl_employee WHERE status=0 AND sangh_code='MSS' LIMIT 3")).map(x => x.emp_code);
  const srKey = await candidateKey('sanghrakshak');
  r = await post(port, '/assign/save-bulk', 'MM008',
    { role: 'sanghrakshak', person_code: srKey, 'emp_codes[]': three });
  check('assign/save-bulk affected', JSON.parse(r.body).affected <= 3, true);
  check('assign/save-bulk persisted',
    (await db.first(`SELECT COUNT(*) n FROM tbl_employee WHERE emp_code IN (?,?,?) AND sanghrakshak_code=?`,
      [...three, srKey])).n, 3);

  /* -------------------------------------------------------- role profiles */
  // Use a sangh/designation the creator actually leads — the form only offers those.
  const roleProfileModel = require('../src/models/roleProfile');
  const [firstDesig] = await roleProfileModel.designationsForLeader(CREATOR.code, CREATOR.name);
  const TEST_DESIG = firstDesig.designation;

  const form = {
    designation_name: TEST_DESIG,
    sangh_code: firstDesig.sangh_code,
    mission: 'Sandbox mission text.',
    outcomes: ['Outcome one', 'Outcome two', ''],
    action: 'draft',
  };
  // 9 attributes totalling 100, each with one skill carrying the whole attribute weight.
  const weights = [12, 11, 11, 11, 11, 11, 11, 11, 11];
  weights.forEach((w, i) => {
    const n = i + 1;
    form[`attribute[${n}]`] = `Attribute ${n}`;
    form[`attribute_weight[${n}]`] = String(w);
    form[`assessment[${n}]`] = '';
    form[`tech_skill[${n}][1]`] = `Skill ${n}.1`;
    form[`tech_weight[${n}][1]`] = String(w);
  });

  r = await post(port, '/role-profiles/store', 'M00151', form);
  check('store draft redirects', r.status, 302);
  const draft = await db.first(
    'SELECT * FROM rp_role_profiles WHERE designation_name=? ORDER BY id DESC LIMIT 1', [TEST_DESIG]);
  if (!draft) {
    const back = await get(port, r.location.replace(/^https?:\/\/[^/]+/, ''), 'M00151');
    const why = (back.body.match(/rp-alert[^>]*>([\s\S]{0,300}?)</) || [])[1] || r.location;
    console.log('  store failed — page said: ' + why.replace(/\s+/g, ' ').trim());
  }
  check('draft created', draft ? draft.status : 'missing', 'draft');
  check('draft outcomes stored',
    (await db.first('SELECT COUNT(*) n FROM rp_role_key_outcomes WHERE role_profile_id=?', [draft.id])).n, 2);
  check('draft skills stored',
    (await db.first('SELECT COUNT(*) n FROM rp_role_profile_details WHERE role_profile_id=?', [draft.id])).n, 9);

  r = await post(port, `/role-profiles/${draft.id}/submit`, 'M00151', {});
  const submitted = await db.first('SELECT status FROM rp_role_profiles WHERE id=?', [draft.id]);
  check('submit moves off draft', submitted.status !== 'draft', true);
  check('submit notified someone',
    (await db.first('SELECT COUNT(*) n FROM rp_notifications WHERE role_profile_id=?', [draft.id])).n > 0, true);

  // Whoever the profile is waiting on decides; the admin can always act.
  r = await post(port, `/role-profiles/${draft.id}/decide`, 'MM008', { action: 'reject', reject_reason: 'Sandbox rejection' });
  const rejected = await db.first('SELECT status, reject_reason FROM rp_role_profiles WHERE id=?', [draft.id]);
  check('reject recorded', rejected.status, 'rejected');
  check('reject reason kept', rejected.reject_reason, 'Sandbox rejection');

  r = await post(port, `/role-profiles/${draft.id}/submit`, 'M00151', {});
  check('resubmit after reject allowed',
    (await db.first('SELECT status FROM rp_role_profiles WHERE id=?', [draft.id])).status !== 'rejected', true);

  r = await post(port, `/role-profiles/${draft.id}/decide`, 'MM008', { action: 'approve' });
  check('approve recorded',
    (await db.first('SELECT status FROM rp_role_profiles WHERE id=?', [draft.id])).status, 'approved');

  check('history trail written',
    (await db.first('SELECT COUNT(*) n FROM rp_role_profile_history WHERE role_profile_id=?', [draft.id])).n >= 5, true);

  r = await post(port, `/role-profiles/${draft.id}/assign-members`, 'M00151', { 'emp_codes[]': ['M01078'] });
  check('member assigned',
    (await db.first('SELECT COUNT(*) n FROM rp_role_profile_members WHERE role_profile_id=? AND emp_code=?',
      [draft.id, 'M01078'])).n, 1);
  check('assignment named in history',
    (await db.first("SELECT COUNT(*) n FROM rp_role_profile_history WHERE role_profile_id=? AND note LIKE '%Heena%'",
      [draft.id])).n > 0, true);

  r = await post(port, `/role-profiles/${draft.id}/unassign-member`, 'M00151', { emp_code: 'M01078' });
  check('member unassigned',
    (await db.first('SELECT COUNT(*) n FROM rp_role_profile_members WHERE role_profile_id=? AND emp_code=?',
      [draft.id, 'M01078'])).n, 0);

  /* ----------------------------------------------------------- assessment */
  await post(port, `/role-profiles/${draft.id}/assign-members`, 'M00151', { 'emp_codes[]': ['M01078'] });
  // Assessments are written against the frozen version, so the ids come from there.
  const frozen = await db.first(
    'SELECT id FROM rp_profile_versions WHERE role_profile_id=? ORDER BY version_no DESC LIMIT 1', [draft.id]);
  const skillRows = await db.query(
    'SELECT id, tech_weight FROM rp_version_details WHERE version_id=? ORDER BY id', [frozen.id]);
  const fy = (await db.first('SELECT year FROM tbl_financial_year ORDER BY id DESC LIMIT 1')).year;

  const ratings = {};
  skillRows.forEach((s, i) => { ratings[`rating[d${s.id}]`] = i === 0 ? '3.5' : '3'; });
  ratings[`gap[d${skillRows[0].id}]`] = 'Needs advanced training';
  ratings.financial_year = '2026-2027';

  r = await post(port, `/role-profiles/${draft.id}/assess/M01078`, 'M00151', ratings);
  const saved = await db.first(
    "SELECT * FROM rp_assessments WHERE role_profile_id=? AND emp_code='M01078' AND financial_year='2026-2027'", [draft.id]);
  const expTotal = skillRows.reduce((t, s, i) => t + Number(s.tech_weight) * (i === 0 ? 3.5 : 3), 0);
  const expMax = skillRows.reduce((t, s) => t + Number(s.tech_weight) * 4, 0);
  check('assessment total', Number(saved.total_score), expTotal);
  check('assessment max', Number(saved.max_score), expMax);
  check('assessment percentage', Number(saved.percentage).toFixed(2), (expTotal / expMax * 100).toFixed(2));
  check('gap counted', Number(saved.gap_count), 1);
  check('ratings stored',
    (await db.first('SELECT COUNT(*) n FROM rp_assessment_ratings WHERE assessment_id=?', [saved.id])).n, skillRows.length);

  // The creator gets one shot per year; the page must now be read-only for them.
  const again = await get(port, `/role-profiles/${draft.id}/assess/M01078`, 'M00151');
  check('creator locked out of a second pass', /rp-btn-save/.test(again.body), false);

  // An out-of-range rating must be refused without destroying what is stored.
  const bad = { ...ratings }; bad[`rating[d${skillRows[1].id}]`] = '7';
  r = await post(port, `/role-profiles/${draft.id}/assess/M01078`, 'MM008', bad);
  const after = await db.first('SELECT total_score FROM rp_assessments WHERE id=?', [saved.id]);
  check('invalid rating refused', Number(after.total_score), expTotal);

  // The PSP Approver may correct the current year.
  const fixed = { ...ratings }; fixed[`rating[d${skillRows[1].id}]`] = '4';
  r = await post(port, `/role-profiles/${draft.id}/assess/M01078`, 'MM008', fixed);
  const corrected = await db.first('SELECT total_score, assessed_by FROM rp_assessments WHERE id=?', [saved.id]);
  check('PSP Approver correction applied',
    Number(corrected.total_score), expTotal + Number(skillRows[1].tech_weight));

  /* -------------------------------------------------------- notifications */
  await post(port, '/notifications/read-all', 'M00151', {});
  check('read-all clears unread',
    (await db.first("SELECT COUNT(*) n FROM rp_notifications WHERE emp_code='M00151' AND is_read=0")).n, 0);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
