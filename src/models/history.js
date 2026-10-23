'use strict';
const db = require('../lib/db');
const { nowStamp } = require('./roleProfile');

/** Append-only audit trail for a role profile — never edited or deleted. */
const ACTION = {
  CREATED: 'created',
  DRAFT_SAVED: 'draft_saved',
  EDITED: 'edited',
  SUBMITTED: 'submitted',
  RESUBMITTED: 'resubmitted',
  SEVAK_APPROVED: 'sevak_approved',
  ADMIN_APPROVED: 'admin_approved',
  REJECTED: 'rejected',
  ASSIGNED: 'members_assigned',
  UNASSIGNED: 'member_removed',
  ASSESSED: 'assessed',
  REVIEWED: 'reviewed',
  AUTO_APPLIED: 'auto_applied',
};

/** Label, icon and colour for each action, used by the timeline. */
const META = {
  created: ['Created', 'mdi-file-plus-outline', 'info'],
  draft_saved: ['Draft saved', 'mdi-content-save-outline', 'muted'],
  edited: ['Edited', 'mdi-pencil-outline', 'muted'],
  submitted: ['Submitted for approval', 'mdi-send', 'info'],
  resubmitted: ['Resubmitted for approval', 'mdi-send-clock-outline', 'info'],
  sevak_approved: ['Approved by RP Approver', 'mdi-check', 'ok'],
  // The PSP Approver for PSP profiles, the LDP Admin for LDP ones — the entry names who.
  admin_approved: ['Final approval', 'mdi-check-decagram-outline', 'ok'],
  rejected: ['Rejected', 'mdi-close-circle-outline', 'bad'],
  members_assigned: ['Members assigned', 'mdi-account-multiple-plus-outline', 'ok'],
  member_removed: ['Member removed', 'mdi-account-minus-outline', 'muted'],
  assessed: ['Assessment recorded', 'mdi-clipboard-check-outline', 'ok'],
  reviewed: ['Yearly review', 'mdi-calendar-check-outline', 'info'],
  auto_applied: ['Applied automatically', 'mdi-badge-account-outline', 'ok'],
};

async function log(profileId, action, actor, note = '') {
  await db.run(
    `INSERT INTO rp_role_profile_history
       (role_profile_id, action, actor_code, actor_name, note, created_at)
     VALUES (?,?,?,?,?,?)`,
    [profileId, action, actor.code || '', actor.name || '', note, nowStamp()]
  );
}

async function forProfile(profileId) {
  return db.query(
    'SELECT * FROM rp_role_profile_history WHERE role_profile_id = ? ORDER BY id ASC',
    [profileId]
  );
}

module.exports = { ACTION, META, log, forProfile };
