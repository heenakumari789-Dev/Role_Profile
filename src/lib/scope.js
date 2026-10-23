'use strict';
const config = require('../config');

/**
 * Which members this portal is about.
 *
 * SS (Sanghrakshak Sangh) and SS1 (Seva Sangh) belong to the LDP programme, not PSP.
 * Their members are excluded as SUBJECTS — absent from member lists, assignment, role
 * profiles and assessments — but people in those sanghs can still sign in and act as
 * an RP Creator or RP Approver for members elsewhere.
 */
function sqlCondition(alias = 'e') {
  const codes = config.excludedSanghs;
  if (!codes.length) return '1=1';
  const quoted = codes.map((c) => `'${String(c).replace(/'/g, "''")}'`).join(',');
  return `${alias}.sangh_code NOT IN (${quoted})`;
}

/** The inverse of sqlCondition() — matches only members of the LDP sanghs (SS/SS1). */
function excludedSanghCondition(alias = 'e') {
  const codes = config.excludedSanghs;
  if (!codes.length) return '1=0';
  const quoted = codes.map((c) => `'${String(c).replace(/'/g, "''")}'`).join(',');
  return `${alias}.sangh_code IN (${quoted})`;
}

module.exports = { sqlCondition, excludedSanghCondition, excluded: () => config.excludedSanghs };
