'use strict';
/**
 * Role profiles no longer apply themselves to whoever holds the designation — the admin
 * assigns members. This carries the people the old automatic rule covered over as ordinary
 * assignments, so nobody loses their role profile or the assessments written against it.
 *
 * For every approved profile, each active member holding its designation in its sangh who
 * is not already assigned gets an assignment row, and the profile's history says so.
 *
 *   node scripts/migrate_manual_assignment.js           # preview: lists what would change
 *   node scripts/migrate_manual_assignment.js --apply   # writes it
 *
 * Safe to run more than once: someone already assigned is skipped.
 */
const db = require('../src/lib/db');
const roleProfile = require('../src/models/roleProfile');
const history = require('../src/models/history');

const APPLY = process.argv.includes('--apply');
const ACTOR = { code: 'SYSTEM', name: 'Carried over when automatic matching was switched off' };

async function main() {
  console.log(`${APPLY ? 'Applying to' : 'Preview of'} ${(await db.first('SELECT DATABASE() d')).d}\n`);
  let total = 0;

  const profiles = await db.query('SELECT * FROM rp_role_profiles WHERE status = ? ORDER BY id', [roleProfile.STATUS.APPROVED]);
  for (const profile of profiles) {
    const assigned = new Set((await db.query(
      'SELECT emp_code FROM rp_role_profile_members WHERE role_profile_id = ?', [profile.id])).map((r) => r.emp_code));
    const holders = (await roleProfile.membersWithDesignation(profile.designation_name, profile.sangh_code))
      .filter((m) => !assigned.has(m.emp_code));
    if (!holders.length) continue;

    const names = holders.map((m) => `${m.name} (${m.emp_code})`).join(', ');
    console.log(`  #${profile.id} ${profile.designation_name} (${profile.sangh_name}): ${names}`);
    total += holders.length;

    if (APPLY) {
      await roleProfile.assignMembers(profile.id, holders.map((m) => m.emp_code), ACTOR);
      await history.log(profile.id, history.ACTION.ASSIGNED, ACTOR,
        `Assigned to ${names} — they held the designation when profiles applied themselves`);
    }
  }

  console.log(`\n${total} member${total === 1 ? '' : 's'} ${APPLY ? 'assigned' : 'would be assigned'}.`);
  if (!APPLY && total) console.log('Run again with --apply to write it.');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
