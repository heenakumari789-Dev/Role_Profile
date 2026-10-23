'use strict';
const config = require('../config');

/**
 * The PSP Approver and the LDP Admin are shown as "Admin", not by the name on their member
 * row (MM008's reads "LMS"). Used when they sign in, so what they do is recorded as Admin,
 * and when rendering, so rows saved under the old name read the same way.
 */
const ADMIN_LABEL = 'Admin';

function isAdminCode(code) {
  const c = String(code || '').trim();
  return !!c && (config.adminCodes.includes(c) || config.ldpAdminCodes.includes(c));
}

function displayName(code, name) {
  return isAdminCode(code) ? ADMIN_LABEL : (name || code || '');
}

module.exports = { ADMIN_LABEL, isAdminCode, displayName };
