'use strict';
const db = require('../lib/db');
const roleProfile = require('./roleProfile');
const ldp = require('./ldp');

/**
 * LDP's assessment: the member self-rates, then their leader gives the final rating.
 * Same rating scale as PSP (1..4, whole numbers only) and the same shared tables
 * (rp_assessments / rp_assessment_ratings) — self_rating/self_score are new columns
 * alongside the existing rating/score (which here hold the leader's final line values).
 * There is no versioning: always against the live rp_role_profile_details.
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

/** The skills to be rated, in profile order, with the assessment mechanism and any ratings. */
async function skillsFor(profileId, assessmentId) {
  return db.query(
    `SELECT d.id, d.attribute_no, d.attribute, d.assessment, d.attribute_weight,
            d.tech_skill, d.tech_weight,
            r.self_rating, r.self_score,
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

async function yearsForMember(profileId, empCode) {
  return db.query(
    `SELECT * FROM rp_assessments WHERE role_profile_id = ? AND emp_code = ?
     ORDER BY financial_year DESC`,
    [profileId, empCode]
  );
}

/**
 * Every (LDP profile x member) pair this person leads (tbl_employee.leader_id), with the
 * assessment if one exists. This is a different visibility rule from
 * roleProfile.visibleTo() — a leader is not necessarily the RP Creator, RP Approver, or
 * the member, so they would not otherwise see the profile at all.
 */
async function overviewForLeader(leaderCode, financialYear) {
  const profiles = await db.query(
    `SELECT * FROM rp_role_profiles WHERE status = ? AND program = ?`,
    [roleProfile.STATUS.APPROVED, roleProfile.PROGRAM.LDP]
  );

  const rows = [];
  for (const profile of profiles) {
    for (const member of await roleProfile.effectiveMembers(profile)) {
      const leader = await ldp.resolveLeader(member.emp_code);
      if (!leader || leader.code !== leaderCode) continue;

      rows.push({
        profile_id: Number(profile.id),
        designation_name: profile.designation_name,
        sangh_name: profile.sangh_name,
        program: roleProfile.PROGRAM.LDP,
        emp_code: member.emp_code,
        member_name: member.name || member.emp_code,
        designation: member.designation || '',
        can_assess: false,
        assessment: await forMember(Number(profile.id), member.emp_code, financialYear),
      });
    }
  }
  return rows;
}

/** Detail rows carrying a weight, used to compute what "everything rated" would total. */
async function weightedSkills(profileId) {
  return db.query(
    `SELECT id, tech_weight FROM rp_role_profile_details
     WHERE role_profile_id = ? AND TRIM(COALESCE(tech_skill,'')) <> ''`,
    [profileId]
  );
}

/**
 * The member rates themselves and submits. One shot — once self_submitted_at is set,
 * saveSelf refuses to run again (checked by the caller before invoking this, and again
 * here as the authoritative guard).
 */
async function saveSelf(profileId, member, ratings, financialYear) {
  return db.transaction(async (conn) => {
    const [existingRows] = await conn.query(
      'SELECT * FROM rp_assessments WHERE role_profile_id = ? AND emp_code = ? AND financial_year = ? LIMIT 1',
      [profileId, member.emp_code, financialYear]
    );
    const existing = existingRows.length ? existingRows[0] : null;
    if (existing && existing.self_submitted_at) {
      return { error: 'You have already submitted your self-rating for this year.' };
    }

    const now = roleProfile.nowStamp();
    let assessmentId;
    if (!existing) {
      const [res] = await conn.query(
        `INSERT INTO rp_assessments (role_profile_id, emp_code, financial_year, member_name, created_at)
         VALUES (?,?,?,?,?)`,
        [profileId, member.emp_code, financialYear, member.name, now]
      );
      assessmentId = res.insertId;
    } else {
      assessmentId = existing.id;
    }

    const skillRows = await weightedSkills(profileId);
    let selfTotal = 0;
    let weightTotal = 0;

    for (const skill of skillRows) {
      const detailId = Number(skill.id);
      const weight = Number(skill.tech_weight) || 0;
      const rating = Number(ratings[detailId] ?? 0);
      const scored = rating > 0 && isValidRating(rating);
      if (!scored) continue;

      const score = Math.round(weight * rating * 100) / 100;
      const [existingRating] = await conn.query(
        'SELECT id FROM rp_assessment_ratings WHERE assessment_id = ? AND role_profile_detail_id = ?',
        [assessmentId, detailId]
      );
      if (existingRating.length) {
        await conn.query(
          'UPDATE rp_assessment_ratings SET self_rating = ?, self_score = ? WHERE id = ?',
          [rating, score, existingRating[0].id]
        );
      } else {
        await conn.query(
          `INSERT INTO rp_assessment_ratings (assessment_id, role_profile_detail_id, self_rating, self_score)
           VALUES (?,?,?,?)`,
          [assessmentId, detailId, rating, score]
        );
      }
      selfTotal += score;
      weightTotal += weight;
    }

    const max = Math.round(weightTotal * RATING_MAX * 100) / 100;
    const percentage = max > 0 ? Math.round((selfTotal / max) * 10000) / 100 : 0;

    await conn.query(
      `UPDATE rp_assessments
       SET member_name = ?, weight_total = ?, self_total_score = ?, self_percentage = ?,
           self_submitted_at = ?, updated_at = ?
       WHERE id = ?`,
      [member.name, weightTotal, Math.round(selfTotal * 100) / 100, percentage, now, now, assessmentId]
    );

    return { id: assessmentId, total: Math.round(selfTotal * 100) / 100, max, percentage };
  });
}

/**
 * The leader gives the final rating, once self-rating is in. Not one-shot — can be
 * re-saved while the financial year stays open.
 */
async function saveFinal(profileId, member, actor, ratings, gaps, financialYear) {
  return db.transaction(async (conn) => {
    const [existingRows] = await conn.query(
      'SELECT * FROM rp_assessments WHERE role_profile_id = ? AND emp_code = ? AND financial_year = ? LIMIT 1',
      [profileId, member.emp_code, financialYear]
    );
    const existing = existingRows.length ? existingRows[0] : null;
    if (!existing || !existing.self_submitted_at) {
      return { error: `${member.name || member.emp_code} has not submitted a self-rating for ${financialYear} yet.` };
    }

    const now = roleProfile.nowStamp();
    const assessmentId = existing.id;
    const skillRows = await weightedSkills(profileId);
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
      if (!scored && gap === '') continue;

      const score = scored ? Math.round(weight * rating * 100) / 100 : 0;
      const [existingRating] = await conn.query(
        'SELECT id FROM rp_assessment_ratings WHERE assessment_id = ? AND role_profile_detail_id = ?',
        [assessmentId, detailId]
      );
      if (existingRating.length) {
        await conn.query(
          'UPDATE rp_assessment_ratings SET rating = ?, score = ?, training_gap = ? WHERE id = ?',
          [scored ? rating : 0, score, gap === '' ? null : gap, existingRating[0].id]
        );
      } else {
        await conn.query(
          `INSERT INTO rp_assessment_ratings (assessment_id, role_profile_detail_id, rating, score, training_gap)
           VALUES (?,?,?,?,?)`,
          [assessmentId, detailId, scored ? rating : 0, score, gap === '' ? null : gap]
        );
      }
      if (scored) { total += score; weightTotal += weight; rated++; }
      if (gap !== '') gapCount++;
    }

    const max = Math.round(weightTotal * RATING_MAX * 100) / 100;
    const percentage = max > 0 ? Math.round((total / max) * 10000) / 100 : 0;

    await conn.query(
      `UPDATE rp_assessments
       SET member_name = ?, assessed_by = ?, assessed_by_name = ?,
           weight_total = ?, total_score = ?, max_score = ?, percentage = ?, gap_count = ?,
           final_submitted_at = ?, updated_at = ?
       WHERE id = ?`,
      [member.name, actor.code, actor.name, weightTotal, Math.round(total * 100) / 100, max,
       percentage, gapCount, now, now, assessmentId]
    );

    return { id: assessmentId, total: Math.round(total * 100) / 100, max, percentage, rated, gaps: gapCount };
  });
}

module.exports = {
  RATING_MIN, RATING_MAX, RATING_STEP,
  ratingScale, isValidRating, skillsFor, forMember, yearsForMember, overviewForLeader,
  saveSelf, saveFinal,
};
