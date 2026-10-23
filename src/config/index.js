'use strict';
require('dotenv').config();

const list = (value, fallback) =>
  String(value ?? fallback ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

module.exports = {
  port: Number(process.env.PORT || 3000),
  basePath: process.env.BASE_PATH || '/',
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || 'root',
    database: process.env.DB_NAME || 'yashpakk_displ7qd_yash_lp',
  },

  // Read by the LMS join in a couple of queries; kept configurable like the PHP app.
  lmsSchema: process.env.LMS_SCHEMA || 'pakka_lms',

  // Shared secret for the read-only API that Zoho Recruit calls. Unset means switched off.
  apiToken: process.env.API_TOKEN || '',
  // How the portal is reached from outside, used to build links for Recruit.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),

  // PSP Admin — reaches the assign pages, approves role profiles, etc.
  adminCodes: list(process.env.ADMIN_CODES, 'MM008'),
  // LDP Admin — manages sevak/sanghrakshak members (tbl_leaders). Defaults to the same
  // codes as PSP so one person holds both until this is deliberately split apart.
  ldpAdminCodes: list(process.env.LDP_ADMIN_CODES, process.env.ADMIN_CODES || 'MM008'),
  excludedSanghs: list(process.env.EXCLUDED_SANGHS, 'SS,SS1'),
};
