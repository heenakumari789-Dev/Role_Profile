'use strict';
const crypto = require('crypto');
const config = require('../config');
const notification = require('../models/notification');
const roleProfile = require('../models/roleProfile');
const employee = require('../models/employee');
const { displayName, isAdminCode } = require('../lib/displayName');

/* -------------------------------------------------------------- helpers */

const isAdmin = (code) => !!code && config.adminCodes.includes(code);
const isLdpAdmin = (code) => !!code && config.ldpAdminCodes.includes(code);

/**
 * How many members this person is responsible for. Cached on the request so the layout,
 * the landing logic and the routes all ask the question once.
 */
async function leadsCount(req) {
  if (req._leadsCount !== undefined) return req._leadsCount;
  const code = req.session.emp_code || '';
  if (!code) return (req._leadsCount = 0);
  const rows = await employee.membersLedBy(code, req.session.emp_name || '');
  return (req._leadsCount = rows.length);
}

/**
 * Where a signed-in person belongs. Never '/' — the member list is admin-only, so
 * pointing anyone else there would bounce them straight back.
 */
async function landingUrl(req) {
  if (req.session.is_admin) return '/assign/sangh';
  if (req.session.is_ldp_admin) return '/ldp-assign';
  return (await leadsCount(req)) > 0 ? '/my-members' : '/role-profiles';
}

/* ------------------------------------------------------------------ CSRF */

/**
 * Small hand-rolled CSRF guard. One token per session (not rotated), matching the PHP
 * app's Security::$regenerate = false, so several AJAX posts can share a token.
 */
/** Does this request carry the session's token? Usable once the body has been parsed. */
function verifyToken(req) {
  const sent = (req.body && req.body.csrf_test_name) || req.get('X-CSRF-TOKEN') || '';
  return !!req.session.csrfToken && sent === req.session.csrfToken;
}

function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    // A file upload is parsed by the route, not here, so its token is not readable yet.
    // Those routes call verifyToken() themselves once the body exists.
    const multipart = String(req.get('content-type') || '').startsWith('multipart/form-data');
    if (!multipart && !verifyToken(req)) {
      res.status(403);
      return res.send('The action you requested is not allowed. (CSRF)');
    }
  }
  next();
}

/* ------------------------------------------------------------------ auth */

/** Requires a signed-in member — any member. */
function loggedIn(req, res, next) {
  if (req.session.logged_in) return next();

  req.session.flashError = 'Please sign in to continue.';
  // Only a GET is worth returning to; replaying a POST target as a GET would fail.
  if (req.method === 'GET') req.session.redirect_after_login = req.originalUrl;
  return res.redirect('/login');
}

/** Guards everything only the PSP Approver may reach. */
async function adminAuth(req, res, next) {
  if (!req.session.logged_in) {
    req.session.flashError = 'Please sign in to continue.';
    if (req.method === 'GET') req.session.redirect_after_login = req.originalUrl;
    return res.redirect('/login');
  }
  if (!isAdmin(req.session.emp_code)) {
    req.session.flashError = 'That page is restricted to the PSP Approver.';
    return res.redirect(await landingUrl(req));
  }
  next();
}

/** Guards everything only the LDP Admin may reach (sevak/sanghrakshak management). */
async function ldpAdminAuth(req, res, next) {
  if (!req.session.logged_in) {
    req.session.flashError = 'Please sign in to continue.';
    if (req.method === 'GET') req.session.redirect_after_login = req.originalUrl;
    return res.redirect('/login');
  }
  if (!isLdpAdmin(req.session.emp_code)) {
    req.session.flashError = 'That page is restricted to the LDP Admin.';
    return res.redirect(await landingUrl(req));
  }
  next();
}

/* ---------------------------------------------------------------- locals */

/** Everything the layout needs on every render. */
async function viewLocals(req, res, next) {
  // Admins already signed in under their member-row name switch to "Admin" too.
  if (req.session.emp_code && isAdminCode(req.session.emp_code)) req.session.emp_name = displayName(req.session.emp_code);
  const me = {
    code: req.session.emp_code || '',
    name: req.session.emp_name || '',
    isAdmin: !!req.session.is_admin,
    isLdpAdmin: !!req.session.is_ldp_admin,
  };

  // One date format for the whole portal: 18 Aug 2026, 3:45 PM.
  const parse = (v) => {
    if (!v) return null;
    const d = new Date(String(v).replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  };
  res.locals.fmtDate = (v) => {
    const d = parse(v);
    return d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  };
  res.locals.fmtDateTime = (v) => {
    const d = parse(v);
    if (!d) return '';
    // en-GB gives "pm"; the portal shows "PM".
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());
  };

  // Escape helper, for the few places a view builds markup by hand.
  res.locals.h = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  res.locals.me = me;
  // "Awaiting LDP Admin" or "Awaiting PSP Approver", by the profile's programme.
  res.locals.statusText = (p) => roleProfile.statusLabel(p);
  res.locals.personName = displayName;
  res.locals.finalApproverLabel = (p) => roleProfile.finalApprover(p).label;
  res.locals.loggedIn = !!req.session.logged_in;
  res.locals.currentPath = req.path;
  res.locals.activeNav = '';
  res.locals.pageTitle = '';
  res.locals.title = 'Pakka Role Profile';

  // Flash messages, consumed once.
  res.locals.flashError = req.session.flashError || '';
  res.locals.flashSuccess = req.session.flashSuccess || '';
  delete req.session.flashError;
  delete req.session.flashSuccess;

  if (req.session.logged_in) {
    res.locals.rpUnread = await notification.unreadCount(me.code);
    res.locals.rpPending = (await roleProfile.awaiting(me.code, me.isAdmin, me.isLdpAdmin)).length;
    res.locals.rpLeads = await leadsCount(req);
  } else {
    res.locals.rpUnread = 0;
    res.locals.rpPending = 0;
    res.locals.rpLeads = 0;
  }

  next();
}

module.exports = {
  isAdmin, isLdpAdmin, leadsCount, landingUrl, csrf, verifyToken, loggedIn,
  adminAuth, ldpAdminAuth, viewLocals,
};
