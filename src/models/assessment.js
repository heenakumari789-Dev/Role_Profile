'use strict';
const db = require('../lib/db');
const roleProfile = require('./roleProfile');

/**
 * Assessment of one member against the role profile that applies to them, per financial
 * year. Every technical skill carries a weight; the assessor gives a rating and the line
 * score is weight x rating. Weights total 100, so a perfect assessment scores 400.
 * Ratings run 1..4 as whole numbers only.
 */
const RATING_MIN = 1;
const RATING_MAX = 4;
const RATING_STEP = 1;

function ratingScale() {
  const scale = [];
  for (let r = RATING_MIN; r <= RATING_MAX; r += RATING_STEP) scale.push(r);
  return scale;
}

function isValidRating(rating) {
  if (!Number.isFinite(rating)) return false;
  if (rating < RATING_MIN || rating > RATING_MAX) return false;
  return Number.isInteger(rating);
}

/** The skills to be rated, in profile order, with any rating already recorded. */
async function skillsFor(profileId, assessmentId) {
  return db.query(
    `SELECT d.id, d.attribute_no, d.attribute, d.attribute_weight,
            d.tech_skill, d.tech_weight,
            r.rating, r.score, r.training_gap
     FROM rp_role_profile_details d
     LEFT JOIN rp_assessment_ratings r
            ON r.role_profile_detail_id = d.id AND r.assessment_id = ?
     WHERE d.role_profile_id = ? AND TRIM(COALESCE(d.tech_skill, '')) <> ''
     ORDER BY d.attribute_no ASC, d.sort_order ASC`,
    [Number(assessmentId) || 0, profileId]
  );
}

async function forMember(profileId, empCode, financialYear) {
  return db.first(
    `SELECT * FROM rp_assessments
     WHERE role_profile_id = ? AND emp_code = ? AND financial_year = ? LIMIT 1`,
    [profileId, empCode, financialYear]
  );
}

/** Every year this member has been assessed for on this profile, newest first. */
async function yearsForMember(profileId, empCode) {
  return db.query(
    `SELECT * FROM rp_assessments WHERE role_profile_id = ? AND emp_code = ?
     ORDER BY financial_year DESC`,
    [profileId, empCode]
  );
}

async function forProfile(profileId, financialYear) {
  return db.query(
    `SELECT * FROM rp_assessments WHERE role_profile_id = ? AND financial_year = ?
     ORDER BY total_score DESC`,
    [profileId, financialYear]
  );
}

/**
 * Every (approved profile x member) pair this person may see, with the assessment if
 * one exists. The RP Creator sees members of profiles they wrote; a member sees only
 * their own; the PSP Approver sees everything.
 */
async function overviewFor(empCode, isAdmin, financialYear) {
  const rows = [];

  // Both programmes for the PSP Approver here, as before: assessments are not split by programme.
  for (const profile of await roleProfile.visibleTo(empCode, isAdmin, isAdmin)) {
    if (profile.status !== roleProfile.STATUS.APPROVED) continue;
    const isCreator = profile.created_by === empCode;

    for (const member of await roleProfile.effectiveMembers(profile)) {
      if (!isCreator && !isAdmin && member.emp_code !== empCode) continue;

      rows.push({
        profile_id: Number(profile.id),
        designation_name: profile.designation_name,
        sangh_name: profile.sangh_name,
        program: profile.program || 'psp',
        emp_code: member.emp_code,
        member_name: member.name || member.emp_code,
        designation: member.designation || '',
        can_assess: isCreator,
        assessment: await forMember(Number(profile.id), member.emp_code, financialYear),
      });
    }
  }

  // Unassessed first — those are the ones needing attention.
  rows.sort((a, b) => {
    const ax = a.assessment ? 1 : 0;
    const bx = b.assessment ? 1 : 0;
    if (ax !== bx) return ax - bx;
    return String(a.member_name).localeCompare(String(b.member_name), undefined, { sensitivity: 'base' });
  });

  return rows;
}

/**
 * Save an assessment and its per-skill ratings. Re-assessing replaces the ratings
 * rather than stacking a second set.
 */
async function save(profileId, member, actor, ratings, financialYear, gaps = {}, versionId = null) {
  return db.transaction(async (conn) => {
    const [existingRows] = await conn.query(
      'SELECT * FROM rp_assessments WHERE role_profile_id = ? AND emp_code = ? AND financial_year = ? LIMIT 1',
      [profileId, member.emp_code, financialYear]
    );
    const existing = existingRows.length ? existingRows[0] : null;
    const now = roleProfile.nowStamp();
    const prior = new Map();
    const written = new Map();

    let assessmentId;
    if (!existing) {
      const [res] = await conn.query(
        `INSERT INTO rp_assessments
           (role_profile_id, version_id, emp_code, financial_year, member_name, assessed_by, assessed_by_name, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [profileId, versionId, member.emp_code, financialYear, member.name, actor.code, actor.name, now]
      );
      assessmentId = res.insertId;
    } else {
      assessmentId = existing.id;
      // A correction stays on the version the assessment was originally written against.
      versionId = existing.version_id || versionId;
      // Keep the old lines so a save that changes nothing can be told apart from a real one.
      const [priorRows] = await conn.query(
        `SELECT version_detail_id, role_profile_detail_id, rating, training_gap
         FROM rp_assessment_ratings WHERE assessment_id = ?`, [assessmentId]);
      for (const row of priorRows) {
        prior.set(String(row.version_detail_id ?? row.role_profile_detail_id),
          `${Number(row.rating)}|${String(row.training_gap || '').trim()}`);
      }
      await conn.query('DELETE FROM rp_assessment_ratings WHERE assessment_id = ?', [assessmentId]);
    }

    // Weights and the skill list come from the frozen version, never from the form — so a
    // later edit to the live profile cannot change what an assessment was scored on.
    const [skillRows] = versionId
      ? await conn.query(
        `SELECT id, tech_weight FROM rp_version_details
         WHERE version_id = ? AND TRIM(COALESCE(tech_skill,'')) <> ''`, [versionId])
      : await conn.query(
        `SELECT id, tech_weight FROM rp_role_profile_details
         WHERE role_profile_id = ? AND TRIM(COALESCE(tech_skill,'')) <> ''`, [profileId]);

    let total = 0;
    let weightTotal = 0;
    let rated = 0;
    let gapCount = 0;

    for (const skill of skillRows) {
      const detailId = Number(skill.id);
      const weight = Number(skill.tech_weight) || 0;
      const rating = Number(ratings[detailId] ?? 0);
      const gap = String(gaps[detailId] ?? '').trim();
      const scored = rating > 0 && isValidRating(rating);

      // A skill is stored if it was rated OR a gap was noted, so a gap recorded
      // without a rating is not silently thrown away.
      if (!scored && gap === '') continue;

      const score = scored ? Math.round(weight * rating * 100) / 100 : 0;
      await conn.query(
        `INSERT INTO rp_assessment_ratings
           (assessment_id, role_profile_detail_id, version_detail_id, rating, score, training_gap)
         VALUES (?,?,?,?,?,?)`,
        [assessmentId, versionId ? null : detailId, versionId ? detailId : null,
         scored ? rating : 0, score, gap === '' ? null : gap]
      );

      written.set(String(detailId), `${scored ? rating : 0}|${gap}`);
      if (scored) { total += score; weightTotal += weight; rated++; }
      if (gap !== '') gapCount++;
    }

    const max = Math.round(weightTotal * RATING_MAX * 100) / 100;
    // Score as a share of what was achievable on the skills actually rated.
    const percentage = max > 0 ? Math.round((total / max) * 10000) / 100 : 0;

    await conn.query(
      `UPDATE rp_assessments
       SET version_id = ?, member_name = ?, assessed_by = ?, assessed_by_name = ?,
           weight_total = ?, total_score = ?, max_score = ?, percentage = ?, gap_count = ?, updated_at = ?
       WHERE id = ?`,
      [versionId, member.name, actor.code, actor.name, weightTotal,
       Math.round(total * 100) / 100, max, percentage, gapCount, now, assessmentId]
    );

    // Nothing to report if every line came back with the same rating and the same gap.
    const changed = !existing
      || prior.size !== written.size
      || [...written].some(([key, value]) => prior.get(key) !== value);

    return {
      id: assessmentId, total: Math.round(total * 100) / 100, max, percentage,
      rated, gaps: gapCount, changed,
    };
  });
}

module.exports = {
  RATING_MIN, RATING_MAX, RATING_STEP,
  ratingScale, isValidRating, skillsFor, forMember, yearsForMember,
  forProfile, overviewFor, save,
};
