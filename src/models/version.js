'use strict';
const db = require('../lib/db');
const financialYear = require('./financialYear');

/**
 * A role profile is edited in place, but every approval freezes an immutable copy here.
 * Assessments point at the copy they were made against, so an old assessment always
 * shows the wording that was in force when it was written — even after the profile has
 * been rewritten several times since.
 *
 * A review row per financial year says which version applies to that year, and whether
 * the year's review left it unchanged or produced a new version.
 */

const OUTCOME = { CREATED: 'created', UNCHANGED: 'unchanged', UPDATED: 'updated' };
const OUTCOME_LABELS = {
  created: 'First version',
  unchanged: 'Reviewed — no change',
  updated: 'Reviewed — updated',
};

const nowStamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/* --------------------------------------------------------------- writing */

/**
 * Freeze the profile as it stands into a new version, and record it as the version in
 * force for `effectiveYear`. Called on approval, inside the caller's own flow.
 */
async function freeze(profile, { effectiveYear, reason, outcome, actor }) {
  return db.transaction(async (conn) => {
    const [[{ next }]] = await conn.query(
      'SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM rp_profile_versions WHERE role_profile_id = ?',
      [profile.id]);
    const now = nowStamp();

    const [res] = await conn.query(
      `INSERT INTO rp_profile_versions
         (role_profile_id, version_no, designation_name, designation_id, sangh_code, sangh_name, mission,
          created_by, created_by_name, rp_approver_code, rp_approver_name, rp_approver_action_by, rp_approver_action_at,
          admin_action_by, admin_action_at, approved_at, effective_from_year, reason, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [profile.id, next, profile.designation_name, profile.designation_id, profile.sangh_code,
       profile.sangh_name, profile.mission, profile.created_by, profile.created_by_name,
       profile.rp_approver_code || '', profile.rp_approver_name || '', profile.rp_approver_action_by, profile.rp_approver_action_at,
       profile.admin_action_by, profile.admin_action_at, now, effectiveYear, reason || '', now]);
    const versionId = res.insertId;

    const [outcomes] = await conn.query(
      'SELECT outcome, sort_order FROM rp_role_key_outcomes WHERE role_profile_id = ? ORDER BY sort_order',
      [profile.id]);
    for (const o of outcomes) {
      await conn.query('INSERT INTO rp_version_outcomes (version_id, outcome, sort_order) VALUES (?,?,?)',
        [versionId, o.outcome, o.sort_order]);
    }

    const [details] = await conn.query(
      'SELECT * FROM rp_role_profile_details WHERE role_profile_id = ? ORDER BY attribute_no, sort_order',
      [profile.id]);
    for (const d of details) {
      await conn.query(
        `INSERT INTO rp_version_details
           (version_id, source_detail_id, attribute_no, attribute, assessment,
            attribute_weight, tech_skill, tech_weight, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [versionId, d.id, d.attribute_no, d.attribute, d.assessment,
         d.attribute_weight, d.tech_skill, d.tech_weight, d.sort_order]);
    }

    await conn.query(
      `INSERT INTO rp_profile_reviews
         (role_profile_id, financial_year, version_id, outcome, reviewed_by, reviewed_by_name, note, reviewed_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         version_id = VALUES(version_id), outcome = VALUES(outcome),
         reviewed_by = VALUES(reviewed_by), reviewed_by_name = VALUES(reviewed_by_name),
         note = VALUES(note), reviewed_at = VALUES(reviewed_at)`,
      [profile.id, effectiveYear, versionId, outcome, actor ? actor.code : profile.created_by,
       actor ? actor.name : profile.created_by_name, reason || '', now]);

    return { id: versionId, version_no: next };
  });
}

/**
 * Record that a year's review found nothing to change: the latest version carries over.
 * Refuses if the year already has a review, so a year is never quietly re-decided.
 */
async function carryForward(profileId, year, actor, note = '') {
  const existing = await reviewFor(profileId, year);
  if (existing) return { ok: false, message: `${year} has already been reviewed.` };

  const latest = await latestFor(profileId);
  if (!latest) return { ok: false, message: 'This role profile has no approved version yet.' };

  await db.run(
    `INSERT INTO rp_profile_reviews
       (role_profile_id, financial_year, version_id, outcome, reviewed_by, reviewed_by_name, note, reviewed_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [profileId, year, latest.id, OUTCOME.UNCHANGED, actor.code, actor.name, note, nowStamp()]);

  return { ok: true, version: latest };
}

/* --------------------------------------------------------------- reading */

async function find(versionId) {
  return db.first('SELECT * FROM rp_profile_versions WHERE id = ?', [versionId]);
}

async function latestFor(profileId) {
  return db.first(
    'SELECT * FROM rp_profile_versions WHERE role_profile_id = ? ORDER BY version_no DESC LIMIT 1', [profileId]);
}

/** Every version, newest first, with the years each one covers. */
async function listFor(profileId) {
  const versions = await db.query(
    'SELECT * FROM rp_profile_versions WHERE role_profile_id = ? ORDER BY version_no DESC', [profileId]);
  if (!versions.length) return [];

  const reviews = await db.query(
    'SELECT * FROM rp_profile_reviews WHERE role_profile_id = ? ORDER BY financial_year', [profileId]);
  const counts = await db.query(
    `SELECT version_id, COUNT(*) n FROM rp_assessments
     WHERE role_profile_id = ? AND version_id IS NOT NULL GROUP BY version_id`, [profileId]);
  const byVersion = new Map(counts.map((c) => [Number(c.version_id), Number(c.n)]));

  for (const v of versions) {
    v.years = reviews.filter((r) => Number(r.version_id) === Number(v.id));
    v.assessment_count = byVersion.get(Number(v.id)) || 0;
  }
  return versions;
}

async function reviewFor(profileId, year) {
  return db.first(
    'SELECT * FROM rp_profile_reviews WHERE role_profile_id = ? AND financial_year = ?', [profileId, year]);
}

async function reviewsFor(profileId) {
  return db.query(
    `SELECT r.*, v.version_no FROM rp_profile_reviews r
     JOIN rp_profile_versions v ON v.id = r.version_id
     WHERE r.role_profile_id = ? ORDER BY r.financial_year DESC`, [profileId]);
}

/**
 * The version an assessment for `year` must be written against: whatever that year's
 * review settled on. Falls back to the newest version approved on or before that year,
 * so a year that was never reviewed still resolves to something sensible.
 */
async function versionForYear(profileId, year) {
  const review = await reviewFor(profileId, year);
  if (review) return find(review.version_id);

  const earlier = await db.first(
    `SELECT * FROM rp_profile_versions
     WHERE role_profile_id = ? AND effective_from_year <= ?
     ORDER BY effective_from_year DESC, version_no DESC LIMIT 1`, [profileId, year]);
  return earlier || latestFor(profileId);
}

/** Is this year's review still outstanding? */
async function reviewDue(profileId, year) {
  return !(await reviewFor(profileId, year));
}

async function outcomesFor(versionId) {
  return db.query('SELECT outcome FROM rp_version_outcomes WHERE version_id = ? ORDER BY sort_order', [versionId]);
}

/** The skills of a version, with any ratings from the given assessment attached. */
async function detailsFor(versionId, assessmentId = null) {
  return db.query(
    `SELECT d.id, d.attribute_no, d.attribute, d.attribute_weight,
            d.tech_skill, d.tech_weight,
            r.rating, r.score, r.training_gap
     FROM rp_version_details d
     LEFT JOIN rp_assessment_ratings r
            ON r.version_detail_id = d.id AND r.assessment_id = ?
     WHERE d.version_id = ? AND TRIM(COALESCE(d.tech_skill, '')) <> ''
     ORDER BY d.attribute_no ASC, d.sort_order ASC`,
    [Number(assessmentId) || 0, versionId]);
}

/** What changed between two versions, in plain terms. */
function diff(oldV, newV, oldDetails, newDetails, oldOutcomes, newOutcomes) {
  const changes = [];
  if (String(oldV.mission || '').trim() !== String(newV.mission || '').trim()) changes.push('Mission reworded');

  const outText = (list) => list.map((o) => String(o.outcome).trim()).join(' | ');
  if (outText(oldOutcomes) !== outText(newOutcomes)) changes.push('Key outcomes changed');

  const key = (d) => `${d.attribute_no}|${String(d.attribute).trim()}|${String(d.tech_skill).trim()}|${d.tech_weight}`;
  const oldKeys = new Set(oldDetails.map(key));
  const newKeys = new Set(newDetails.map(key));
  const added = newDetails.filter((d) => !oldKeys.has(key(d))).length;
  const removed = oldDetails.filter((d) => !newKeys.has(key(d))).length;
  if (added) changes.push(`${added} skill line${added > 1 ? 's' : ''} added or reworded`);
  if (removed) changes.push(`${removed} skill line${removed > 1 ? 's' : ''} removed or replaced`);

  const attrs = (list) => [...new Set(list.map((d) => `${d.attribute_no}:${d.attribute_weight}`))].join(',');
  if (attrs(oldDetails) !== attrs(newDetails)) changes.push('Attribute weights changed');

  return changes.length ? changes : ['No differences in the recorded text'];
}

/**
 * The financial-year view of a role profile: for each year, which version applies, whether
 * the review has been done, and how many assessments were written that year. This is the
 * order things happen in — the year is reviewed, then people are assessed against whatever
 * version that review settled on.
 */
async function yearOverview(profileId, years) {
  const reviews = await db.query(
    `SELECT r.*, v.version_no FROM rp_profile_reviews r
     JOIN rp_profile_versions v ON v.id = r.version_id
     WHERE r.role_profile_id = ?`, [profileId]);
  const byYear = new Map(reviews.map((r) => [r.financial_year, r]));

  const counts = await db.query(
    `SELECT financial_year, COUNT(*) n FROM rp_assessments
     WHERE role_profile_id = ? GROUP BY financial_year`, [profileId]);
  const assessed = new Map(counts.map((c) => [c.financial_year, Number(c.n)]));

  const latest = await latestFor(profileId);

  return years.map((y) => {
    const review = byYear.get(y.year) || null;
    return {
      year: y.year,
      is_current: !!y.is_current,
      open: !!y.open,
      review,
      version_no: review ? review.version_no : null,
      // An unreviewed year would settle on whatever stands today.
      would_use: review ? null : (latest ? latest.version_no : null),
      assessments: assessed.get(y.year) || 0,
    };
  });
}

/**
 * For a list of profiles, where each one stands in a given financial year: the version
 * that year settled on, or that the year would settle on if it were reviewed today.
 * Returns a map keyed by role_profile_id.
 */
async function reviewStateFor(profileIds, year) {
  const out = new Map();
  if (!profileIds.length) return out;

  const marks = profileIds.map(() => '?').join(',');
  const reviews = await db.query(
    `SELECT r.role_profile_id, r.outcome, r.reviewed_by_name, r.reviewed_at, v.version_no
     FROM rp_profile_reviews r
     JOIN rp_profile_versions v ON v.id = r.version_id
     WHERE r.financial_year = ? AND r.role_profile_id IN (${marks})`,
    [year, ...profileIds]);
  const byProfile = new Map(reviews.map((r) => [Number(r.role_profile_id), r]));

  // The newest version of each profile, for the "would be" case, and the year it first
  // had one — a profile cannot be reviewed for a year it did not yet exist in.
  const latest = await db.query(
    `SELECT role_profile_id, MAX(version_no) AS version_no, MIN(effective_from_year) AS born_in
     FROM rp_profile_versions WHERE role_profile_id IN (${marks})
     GROUP BY role_profile_id`, profileIds);
  const newest = new Map(latest.map((r) => [Number(r.role_profile_id), Number(r.version_no)]));
  const bornIn = new Map(latest.map((r) => [Number(r.role_profile_id), r.born_in]));

  const counts = await db.query(
    `SELECT role_profile_id, COUNT(*) n FROM rp_assessments
     WHERE financial_year = ? AND role_profile_id IN (${marks})
     GROUP BY role_profile_id`, [year, ...profileIds]);
  const assessed = new Map(counts.map((c) => [Number(c.role_profile_id), Number(c.n)]));

  for (const id of profileIds) {
    const review = byProfile.get(Number(id)) || null;
    out.set(Number(id), {
      review,
      version_no: review ? Number(review.version_no) : null,
      would_use: review ? null : (newest.get(Number(id)) || null),
      born_in: bornIn.get(Number(id)) || null,
      assessments: assessed.get(Number(id)) || 0,
    });
  }
  return out;
}

module.exports = {
  OUTCOME, OUTCOME_LABELS,
  freeze, carryForward,
  find, latestFor, listFor, reviewFor, reviewsFor, versionForYear, reviewDue,
  outcomesFor, detailsFor, diff, nowStamp, yearOverview, reviewStateFor,
};
