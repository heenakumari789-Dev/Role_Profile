'use strict';
const db = require('../lib/db');
const { nowStamp } = require('./roleProfile');

/** In-app notifications. One row per recipient, so "mark as read" is per person. */
const TYPE = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected', INFO: 'info' };

/**
 * Send one notification to each recipient. Blanks and duplicates are dropped, and
 * nobody is notified about their own action.
 */
async function notify(empCodes, type, title, body = '', link = '', profileId = null, exclude = '') {
  const codes = [...new Set(empCodes.map((c) => String(c || '').trim()))]
    .filter((c) => c !== '' && c !== exclude);
  if (!codes.length) return 0;

  const now = nowStamp();
  const values = codes.map((code) => [code, type, title, body, link, profileId, 0, now]);
  await db.run(
    `INSERT INTO rp_notifications
       (emp_code, type, title, body, link, role_profile_id, is_read, created_at)
     VALUES ?`,
    [values]
  );
  return codes.length;
}

async function forUser(empCode, limit = 50) {
  return db.query(
    `SELECT * FROM rp_notifications WHERE emp_code = ?
     ORDER BY is_read ASC, created_at DESC LIMIT ?`,
    [empCode, limit]
  );
}

async function unreadCount(empCode) {
  if (!empCode) return 0;
  const row = await db.first(
    'SELECT COUNT(*) AS n FROM rp_notifications WHERE emp_code = ? AND is_read = 0',
    [empCode]
  );
  return Number(row ? row.n : 0);
}

async function markAllRead(empCode) {
  await db.run('UPDATE rp_notifications SET is_read = 1 WHERE emp_code = ? AND is_read = 0', [empCode]);
}

async function markRead(id, empCode) {
  await db.run('UPDATE rp_notifications SET is_read = 1 WHERE id = ? AND emp_code = ?', [id, empCode]);
}

async function findFor(id, empCode) {
  return db.first('SELECT * FROM rp_notifications WHERE id = ? AND emp_code = ?', [id, empCode]);
}

module.exports = { TYPE, notify, forUser, unreadCount, markAllRead, markRead, findFor };
