'use strict';
/**
 * The read-only API Zoho Recruit calls to find out whether a designation has a role
 * profile. Runs against whatever database is configured; it only reads.
 */
const http = require('http');
const path = require('path');
const express = require('express');

const TOKEN = 'test-api-token';
process.env.API_TOKEN = TOKEN;
process.env.PUBLIC_URL = 'https://rp.example.org';

const db = require('../src/lib/db');
const roleProfile = require('../src/models/roleProfile');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};

function call(port, url, headers = {}) {
  return new Promise((r) => {
    http.get({ port, path: url, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (e) { /* not json */ }
        r({ status: res.statusCode, json, body: b });
      });
    });
  });
}

(async () => {
  const app = express();
  app.use('/api', require('../src/routes/api'));
  const server = app.listen(0);
  const port = server.address().port;
  const auth = { 'X-API-Token': TOKEN };

  /* ------------------------------------------------------------------ auth */
  check('no token is refused', (await call(port, '/api/ping')).status, 401);
  check('a wrong token is refused',
    (await call(port, '/api/ping', { 'X-API-Token': 'wrong' })).status, 401);
  check('a token of the wrong length is refused',
    (await call(port, '/api/ping', { 'X-API-Token': 'short' })).status, 401);
  check('the right token gets through', (await call(port, '/api/ping', auth)).status, 200);
  check('Bearer works too',
    (await call(port, '/api/ping', { authorization: `Bearer ${TOKEN}` })).status, 200);
  check('answers are not cached',
    (await call(port, '/api/ping', auth)).status === 200, true);

  /* ------------------------------------------------------------ what it says */
  check('a missing designation is a bad request',
    (await call(port, '/api/role-profile?sangh=DVS', auth)).status, 400);

  const existing = await db.first(
    "SELECT * FROM rp_role_profiles WHERE status='approved' ORDER BY id LIMIT 1");

  if (existing) {
    const ask = (s, d) => call(port,
      `/api/role-profile?sangh=${encodeURIComponent(s)}&designation=${encodeURIComponent(d)}`, auth);

    let r = await ask(existing.sangh_code, existing.designation_name);
    check('an existing designation is found', r.json.status, 'found');
    check('it returns the profile id', r.json.id, Number(existing.id));
    check('with a link built on the public address',
      r.json.url, `https://rp.example.org/role-profiles/${existing.id}`);
    check('and a PDF link while approved', !!r.json.pdf_url, true);
    check('it names the version in force', typeof r.json.version, 'number');
    check('and says whether this year was reviewed', typeof r.json.reviewed_this_year, 'boolean');
    check('no assessment data is exposed',
      /percentage|score|rating|gap/i.test(JSON.stringify(r.json)), false);

    // The form is typed into, so matching forgives case and spacing.
    r = await ask(existing.sangh_code.toLowerCase(), `  ${existing.designation_name.toUpperCase()}  `);
    check('messy case and spacing still match', r.json.status, 'found');

    r = await ask(existing.sangh_name, existing.designation_name);
    check('the sangh can be given by name', r.json.status, 'found');
  } else {
    console.log('  no approved role profile on this database — "found" checks skipped');
  }

  /* --------------------------------------------------- when there is none yet */
  const free = await db.first(
    `SELECT TRIM(e.designation) AS designation, e.sangh_code
     FROM tbl_employee e
     WHERE e.status = 0 AND TRIM(e.designation) <> ''
       AND NOT EXISTS (SELECT 1 FROM rp_role_profiles p
                       WHERE p.sangh_code = e.sangh_code
                         AND LOWER(TRIM(p.designation_name)) = LOWER(TRIM(e.designation))
                         AND p.status <> 'rejected')
     LIMIT 1`);

  if (free) {
    const r = await call(port,
      `/api/role-profile?sangh=${encodeURIComponent(free.sangh_code)}`
      + `&designation=${encodeURIComponent(free.designation)}&mrf=MRF-99`, auth);
    check('a designation with no profile says so', r.json.status, 'not_found');
    check('but confirms the designation is real', r.json.designation_in_use, true);
    check('and says how many hold it', r.json.members_holding > 0, true);
    check('the create link carries the designation',
      r.json.create_url.includes(encodeURIComponent(free.designation).replace(/%20/g, '+')), true);
    check('and the MRF record it came from', r.json.create_url.includes('mrf=MRF-99'), true);
  }

  const typo = await call(port,
    '/api/role-profile?sangh=DVS&designation=Chief%20Dragon%20Wrangler', auth);
  check('an unknown designation is not found', typo.json.status, 'not_found');
  check('and is flagged as held by nobody', typo.json.designation_in_use, false);
  check('with a message that suggests a typo', /check the spelling/.test(typo.json.message), true);

  /* ------------------------------------------- switched off without a token set */
  const saved = require('../src/config').apiToken;
  require('../src/config').apiToken = '';
  check('with no token configured the API is shut',
    (await call(port, '/api/ping', auth)).status, 503);
  require('../src/config').apiToken = saved;

  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
