'use strict';
/**
 * Who the assign pickers offer: a sangh's own active members when assigning to the whole
 * sangh, every active member when assigning to one. Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const http = require('http');
const { build, signIn, get } = require('./smoke');
const db = require('../src/lib/db');
const leader = require('../src/models/leader');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};
function post(port, path, who, form) {
  const params = new URLSearchParams({ ...form, csrf_test_name: 'test-token' });
  const body = params.toString();
  return new Promise((r) => {
    const req = http.request({ port, path, method: 'POST', headers: {
      'x-test-user': who, 'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c));
                 res.on('end', () => r({ status: res.statusCode, body: b })); });
    req.end(body);
  });
}

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  const app = build(); const server = app.listen(0); const port = server.address().port;
  signIn({ code: 'MM008', name: 'LMS', isAdmin: true });

  const activeMembers = (await db.first(
    "SELECT COUNT(*) n FROM tbl_employee WHERE status=0 AND TRIM(name)<>'' AND TRIM(emp_code)<>'' AND sangh_code NOT IN ('SS','SS1')")).n;

  /* ------------------------------------------------- the pool is the members */
  const pool = await leader.memberCandidates();
  check('every active member is a candidate', pool.length, activeMembers);
  check('each carries a code, name and sangh',
    pool.every(c => c.emp_code && c.name && 'sangh_code' in c), true);

  const all = await leader.allCandidates();
  check('all three roles draw on the same pool',
    Object.values(all).every(list => list.length === activeMembers), true);

  /* ------------------------------------------- the map holds a sangh's members */
  const map = await leader.sanghLeaderMap();
  const mssActive = (await db.first("SELECT COUNT(*) n FROM tbl_employee WHERE status=0 AND sangh_code='MSS' AND TRIM(name)<>'' AND TRIM(emp_code)<>''")).n;
  check('a sangh maps to its own active members', map.MSS.pracharak.length, mssActive);
  check('and to the same people for every role',
    map.MSS.sevak.length === mssActive && map.MSS.sanghrakshak.length === mssActive, true);

  const mssCodes = new Set((await db.query(
    "SELECT emp_code FROM tbl_employee WHERE status=0 AND sangh_code='MSS'")).map(r => r.emp_code));
  check('nobody from another sangh is in that list',
    map.MSS.pracharak.every(code => mssCodes.has(code)), true);

  /* --------------------------------------------- the pages hand both to the UI */
  const bySangh = (await get(port, '/assign/sangh', 'MM008')).body;
  const candA = JSON.parse(bySangh.match(/var CANDIDATES = (.*?);\n/)[1]);
  const mapA = JSON.parse(bySangh.match(/var SANGH_LEADERS = (.*?);\n/)[1]);
  check('the by-sangh page ships the full pool', candA.pracharak.length, activeMembers);
  check('and the per-sangh lists to narrow it with', mapA.MSS.pracharak.length, mssActive);
  check('the picker restricts when the scope is a sangh',
    /current\.scope === 'sangh'/.test(bySangh), true);
  check('candidate labels show the sangh', /· MSS|Â· MSS/.test(JSON.stringify(candA.pracharak)), true);

  const byMember = (await get(port, '/assign', 'MM008')).body;
  const candB = JSON.parse(byMember.match(/var CANDIDATES = (.*?);\n/)[1]);
  check('the by-member page offers every active member', candB.pracharak.length, activeMembers);

  /* ------------------------------------------------------- what the server takes */
  const outsider = await db.first(
    "SELECT emp_code, name FROM tbl_employee WHERE status=0 AND sangh_code<>'MSS' AND sangh_code NOT IN ('SS','SS1') LIMIT 1");
  const insider = await db.first(
    "SELECT emp_code, name FROM tbl_employee WHERE status=0 AND sangh_code='MSS' AND TRIM(name)<>'' LIMIT 1");

  let r = await post(port, '/assign/save-sangh', 'MM008',
    { sangh_code: 'MSS', role: 'pracharak', person_code: insider.emp_code });
  check('a sangh accepts one of its own members', JSON.parse(r.body).affected, mssActive);
  check('and it was stored',
    (await db.first("SELECT pracharak_name n FROM tbl_employee WHERE sangh_code='MSS' AND status=0 LIMIT 1")).n,
    insider.name);

  r = await post(port, '/assign/save-sangh', 'MM008',
    { sangh_code: 'MSS', role: 'pracharak', person_code: outsider.emp_code });
  check('a whole-sangh assignment refuses an outsider', r.status, 422);
  check('and says why', /not a member of MSS/.test(r.body), true);
  check('nothing changed',
    (await db.first("SELECT pracharak_name n FROM tbl_employee WHERE sangh_code='MSS' AND status=0 LIMIT 1")).n,
    insider.name);

  /* ------------------------------- one member may be given anyone active */
  const target = await db.first("SELECT emp_code FROM tbl_employee WHERE status=0 AND sangh_code='MSS' LIMIT 1");
  r = await post(port, '/assign/save', 'MM008',
    { emp_code: target.emp_code, role: 'pracharak', person_code: outsider.emp_code });
  check('one member can be given someone from another sangh', r.status, 200);
  check('and that is what was stored',
    (await db.first('SELECT pracharak_name n FROM tbl_employee WHERE emp_code=?', [target.emp_code])).n,
    outsider.name);

  r = await post(port, '/assign/save', 'MM008',
    { emp_code: target.emp_code, role: 'pracharak', person_code: 'NOBODY' });
  check('but somebody who is not an active member is refused', r.status, 422);
  check('with a plain reason', /not an active member/.test(r.body), true);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
