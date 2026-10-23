'use strict';
/**
 * Read-only smoke test. Builds the same middleware + router stack as server.js but
 * swaps express-session for an in-memory stub, so pages can be fetched as any member
 * without a password. GET only — nothing here writes to the database.
 */
const path = require('path');
const express = require('express');
const http = require('http');
const mw = require('../src/middleware');

const SESSIONS = {};

function build() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));

  // Session stub: the "who" comes from a test header.
  app.use((req, res, next) => {
    const who = req.headers['x-test-user'] || '';
    SESSIONS[who] = SESSIONS[who] || {};
    req.session = SESSIONS[who];
    req.session.destroy = (cb) => { SESSIONS[who] = {}; cb && cb(); };
    req.session.save = (cb) => { cb && cb(); };
    next();
  });

  app.use(mw.csrf);
  app.use(mw.viewLocals);
  require('../src/lib/render').attach(app);

  app.use('/', require('../src/routes/auth'));
  app.use('/', require('../src/routes/home'));
  app.use('/my-members', require('../src/routes/myMembers'));
  app.use('/notifications', require('../src/routes/notifications'));
  app.use('/role-profiles/:id(\\d+)/assess', require('../src/routes/assess'));
  app.use('/role-profiles', require('../src/routes/roleProfiles'));
  app.use('/assessments', require('../src/routes/assessments'));
  app.use('/designations', require('../src/routes/designations'));
  app.use('/assign', require('../src/routes/assign'));

  app.use((req, res) => { res.status(404); res.page('error', { code: 404, message: 'Not found', pageTitle: 'Not found' }); });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return;
    res.status(500).type('text').send('ERROR: ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
  });
  return app;
}

function signIn(user) {
  SESSIONS[user.code] = {
    logged_in: true, emp_code: user.code, emp_name: user.name,
    is_admin: !!user.isAdmin, csrfToken: 'test-token',
  };
}

function get(port, url, who) {
  return new Promise((resolve) => {
    http.get({ port, path: url, headers: { 'x-test-user': who } }, (res) => {
      let body = '';
      res.setEncoding('latin1');   // preserve PDF bytes through string concat
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({
        status: res.statusCode, location: res.headers.location || '', headers: res.headers, body,
      }));
    });
  });
}

/**
 * Designations this leader can still write a profile against. The suites share one
 * sandbox, so each has to pick one nobody has claimed yet.
 */
async function freeDesignations(empCode, name) {
  const roleProfile = require('../src/models/roleProfile');
  const ldp = require('../src/models/ldp');
  const free = async () => {
    const taken = await roleProfile.takenDesignations();
    const ldpDesignations = await ldp.designationSet();
    // Every designation the leader's sanghs have had, held now or not, plus portal-created ones.
    const held = new Map((await roleProfile.designationsForLeader(empCode, name))
      .map((d) => [`${d.sangh_code}|${d.designation}`, Number(d.members)]));
    const all = (await roleProfile.designationChoices(empCode, name))
      .map((d) => ({ ...d, members: held.get(`${d.sangh_code}|${d.designation}`) || 0 }));
    // Most of these fixtures build a plain PSP profile (as few as 1-2 outcomes) — skip LDP
    // designations (min 3 outcomes) so a fixture doesn't fail depending on which sangh
    // happens to come back first.
    return all.filter((d) => !taken.has(`${d.sangh_code}|${d.designation}`)
      && !ldpDesignations.has(`${d.sangh_code}|${d.designation}`)
      && roleProfile.sanghProgram(d.sangh_code) === 'psp');
  };

  // The suites share one sandbox and use designations up; top it up with portal-created ones.
  let list = await free();
  if (list.length < 4) {
    const sangh = (await roleProfile.sanghsForLeader(empCode, name))
      .find((s) => roleProfile.sanghProgram(s.sangh_code) === 'psp');
    if (sangh) {
      for (let i = 0; i < 4; i++) {
        await roleProfile.createDesignation(sangh.sangh_code, `Fixture Role ${Date.now()}-${i}`, { code: empCode, name });
      }
      list = await free();
    }
  }
  return list;
}

/**
 * Take a submitted profile all the way to approved: its RP Approver first when it is waiting
 * on one, then the PSP Approver — who then assigns members, since nothing is applied
 * automatically. By default that is whoever holds the designation (or, if nobody does, one
 * member of the sangh not on another profile), so suites that assess have someone to assess.
 * `post` is the suite's own (port, path, who, form) helper.
 */
async function approveFully(post, port, id, { assign = true } = {}) {
  const db = require('../src/lib/db');
  const roleProfile = require('../src/models/roleProfile');
  const row = await db.first('SELECT status, rp_approver_code, rp_approver_name FROM rp_role_profiles WHERE id = ?', [id]);
  if (row && row.status === 'pending_sevak') {
    signIn({ code: row.rp_approver_code, name: row.rp_approver_name, isAdmin: false });
    await post(port, `/role-profiles/${id}/decide`, row.rp_approver_code, { action: 'approve' });
  }
  signIn({ code: 'MM008', name: 'LMS', isAdmin: true });
  SESSIONS.MM008.is_ldp_admin = true;
  const res = await post(port, `/role-profiles/${id}/decide`, 'MM008', { action: 'approve' });

  if (assign) {
    const profile = await roleProfile.find(id);
    const pool = await roleProfile.assignableMembers(profile);
    let pick = pool.filter((m) => m.holds_designation && !m.assigned);
    if (!pick.length) pick = pool.filter((m) => !m.assigned && !m.other_profile).slice(0, 1);
    if (pick.length) {
      await post(port, `/role-profiles/${id}/assign-members`, 'MM008', { 'emp_codes[]': pick.map((m) => m.emp_code) });
    }
  }
  return res;
}

module.exports = { build, signIn, get, freeDesignations, approveFully, SESSIONS };
