'use strict';
/** Read-only: render both PDFs from live data so they can be eyeballed. */
const fs = require('fs');
const path = require('path');
const db = require('../src/lib/db');
const pdf = require('../src/lib/pdf');
const roleProfile = require('../src/models/roleProfile');
const assessment = require('../src/models/assessment');

const OUT = process.argv[2] || '/tmp';

(async () => {
  const profile = await roleProfile.find(1);
  const outcomes = await db.query(
    'SELECT outcome FROM rp_role_key_outcomes WHERE role_profile_id=? ORDER BY sort_order', [profile.id]);

  const plain = await assessment.skillsFor(profile.id, null);
  await new Promise((r) => {
    const w = fs.createWriteStream(path.join(OUT, 'role-profile.pdf'));
    pdf.roleProfile({ profile, outcomes, details: plain }).pipe(w);
    w.on('finish', r);
  });

  const a = await db.first('SELECT * FROM rp_assessments WHERE role_profile_id=? LIMIT 1', [profile.id]);
  // Ratings hang off the frozen version, the same as the route that builds the real PDF.
  const version = require('../src/models/version');
  const scored = a.version_id
    ? await version.detailsFor(a.version_id, a.id)
    : await assessment.skillsFor(profile.id, a.id);
  await new Promise((r) => {
    const w = fs.createWriteStream(path.join(OUT, 'assessment.pdf'));
    pdf.roleProfile({ profile, outcomes, details: scored, assessment: a }).pipe(w);
    w.on('finish', r);
  });

  console.log('role-profile.pdf  attributes:', new Set(plain.map(d => d.attribute_no)).size, 'skills:', plain.length);
  console.log('assessment.pdf    rated:', scored.filter(s => s.rating != null).length,
              'gaps:', scored.filter(s => String(s.training_gap || '').trim()).length,
              a.percentage + '%');
  process.exit(0);
})();
