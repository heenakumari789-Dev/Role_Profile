'use strict';
const ExcelJS = require('exceljs');
const roleProfile = require('../models/roleProfile');

/**
 * Read a role profile out of a spreadsheet laid out the way Pakka writes them:
 *
 *   A1                designation
 *   A2                Mission: / Mission- ...
 *   A3..              Key Outcomes:  then one numbered line each, or all in one cell
 *   header row        SN | Attribute | Technical Skills | Weightage | Sub-Weightage
 *   rows              the attribute and its weightage span that attribute's skills
 *   last row          Total
 *
 * Merged cells leave the copies blank, so an attribute and its weight carry down until the
 * next one appears. Nothing here is saved — the parsed content goes back into the form for
 * the creator to check and adjust.
 */

const text = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    // Rich text and formula cells arrive as objects.
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if (value.result !== undefined) return String(value.result);
    if (value.text !== undefined) return String(value.text);
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
};

const number = (value) => {
  const raw = text(value).replace(/[^\d.\-]/g, '');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const isHeaderRow = (cells) => {
  const joined = cells.map((c) => text(c).toLowerCase());
  return joined.some((c) => c === 'sn' || c === 's.n' || c === 'sr no')
    && joined.some((c) => c.includes('weightage') || c.includes('weight'));
};

/**
 * Which column is which, read off the header row itself rather than assumed fixed
 * positions — LDP's sheets add an "Assessment Mechanism" column between Skills and
 * Weightage that PSP's plain 5-column layout doesn't have, shifting everything after it.
 * Falls back to the original SN/Attribute/Skill/Weightage/Sub-Weightage positions for
 * anything the header text doesn't clearly identify.
 */
function detectColumns(cells) {
  const idx = {};
  cells.forEach((cell, i) => {
    const t = text(cell).toLowerCase();
    if (!t) return;
    if (idx.sn === undefined && /^(sn|s\.n\.?|sr\.?\s*no\.?)$/.test(t)) idx.sn = i;
    else if (idx.attribute === undefined && t.includes('attribute')) idx.attribute = i;
    else if (idx.skill === undefined && t.includes('skill')) idx.skill = i;
    else if (idx.assessment === undefined && t.includes('assessment')) idx.assessment = i;
    else if (idx.subWeight === undefined && (t.includes('sub-weight') || t.includes('sub weight') || t.includes('individual weight'))) idx.subWeight = i;
    else if (idx.weight === undefined && t.includes('weight')) idx.weight = i;
  });
  return {
    sn: idx.sn ?? 0,
    attribute: idx.attribute ?? 1,
    skill: idx.skill ?? 2,
    assessment: idx.assessment,
    weight: idx.weight ?? 3,
    subWeight: idx.subWeight ?? 4,
  };
}

/** "Mission- Build ..." / "Mission: Build ..." → "Build ..." */
const afterLabel = (value) => text(value).replace(/^[^:–—-]*[:–—-]\s*/, '').trim();

/**
 * "Outcome 2030 1. First - with a dash 2. Second 3. Third" → three entries.
 *
 * Splits at "1.", "2.", "3." ... in sequence, found anywhere in the text — never at a
 * plain dash, so an outcome that itself reads "Metric - Target%" (the normal Pakka style)
 * isn't mistaken for a label and chopped in half. Anything before the "1." (a title like
 * "Outcome 2030") is discarded, same as a "Key Outcomes:" label would be.
 */
function splitNumbered(value) {
  const raw = text(value);
  if (!raw) return [];

  const marker = /(\d+)[.)]\s+/g;
  const hits = [];
  let m;
  let expected = 1;
  while ((m = marker.exec(raw))) {
    if (Number(m[1]) === expected) {
      hits.push({ start: m.index, end: marker.lastIndex });
      expected++;
    }
  }

  if (!hits.length) {
    const single = afterLabel(raw);
    return single ? [single] : [];
  }

  const parts = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].end;
    const stop = i + 1 < hits.length ? hits[i + 1].start : raw.length;
    const part = raw.slice(start, stop).trim();
    if (part) parts.push(part);
  }
  return parts;
}

/**
 * Read one sheet. A workbook often holds an old version alongside the current one, so the
 * caller reads them all and keeps whichever comes out cleanest.
 */
function parseSheet(sheet) {
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row, n) => {
    const cells = [];
    for (let c = 1; c <= 8; c++) cells.push(row.getCell(c).value);
    rows.push({ n, cells });
  });

  const headerAt = rows.findIndex((r) => isHeaderRow(r.cells));
  if (headerAt === -1) {
    return { error: 'Could not find the table header — a row reading "SN, Attribute, '
      + 'Technical Skills, Weightage, Sub-Weightage". Check the sheet is laid out like the '
      + 'Pakka role profile format.' };
  }

  const warnings = [];

  /* ------------------------------------------------- title, mission, outcomes */
  const above = rows.slice(0, headerAt);
  const designation = text(above.length ? above[0].cells[0] : '');

  let mission = '';
  const missionRow = above.find((r) => /^mission/i.test(text(r.cells[0])));
  if (missionRow) mission = afterLabel(missionRow.cells[0]);

  const outcomes = [];
  const outcomeHeaderAt = above.findIndex((r) => /^(key\s+)?outcomes?\b/i.test(text(r.cells[0])));
  if (outcomeHeaderAt !== -1) {
    const header = above[outcomeHeaderAt];
    const inline = splitNumbered(header.cells[0]);
    // Either they are all in the one cell, or listed one per row underneath.
    if (inline.length > 1) {
      outcomes.push(...inline);
    } else {
      for (const row of above.slice(outcomeHeaderAt + 1)) {
        const label = text(row.cells[1]) || text(row.cells[0]);
        if (label && !/^mission/i.test(label)) outcomes.push(label.replace(/^\d+[.)]\s*/, ''));
      }
      if (!outcomes.length && inline.length === 1) outcomes.push(inline[0]);
    }
  }

  /* ------------------------------------------------------------------ table */
  const cols = detectColumns(rows[headerAt].cells);
  const attributes = [];
  let current = null;

  for (const row of rows.slice(headerAt + 1)) {
    const sn = row.cells[cols.sn];
    const attribute = row.cells[cols.attribute];
    const skill = row.cells[cols.skill];
    const assessment = cols.assessment !== undefined ? row.cells[cols.assessment] : null;
    const weight = row.cells[cols.weight];
    const subWeight = row.cells[cols.subWeight];
    if (/^total$/i.test(text(sn)) || /^total$/i.test(text(attribute))) break;

    const attrName = text(attribute);
    const skillName = text(skill);
    const assessmentText = text(assessment);
    const attrWeight = number(weight);
    const skillWeight = number(subWeight);

    if (attrName === '' && skillName === '' && assessmentText === '' && attrWeight === null && skillWeight === null) continue;

    // A new attribute starts wherever a name appears; blanks belong to the one above it.
    if (attrName !== '' && (!current || current.attribute !== attrName)) {
      current = { attribute: attrName, assessment: assessmentText, weight: attrWeight, skills: [] };
      attributes.push(current);
    } else if (!current) {
      current = { attribute: attrName || `Attribute ${attributes.length + 1}`, assessment: assessmentText, weight: attrWeight, skills: [] };
      attributes.push(current);
    }
    if (current.weight === null && attrWeight !== null) current.weight = attrWeight;
    if (!current.assessment && assessmentText !== '') current.assessment = assessmentText;

    if (skillName !== '') current.skills.push({ skill: skillName, weight: skillWeight });
  }

  if (!attributes.length) {
    return { error: 'The table header was found but no attribute rows under it.' };
  }

  /* --------------------------------------------------------------- trimming */
  const MAX_A = roleProfile.MAX_ATTRIBUTES;
  const MAX_S = roleProfile.MAX_SKILLS_PER_ATTR;
  // The programme (and so the real outcome limit — PSP's 3 vs LDP's 5) isn't known until a
  // designation is chosen on the form itself; keep the wider bound here so nothing real is
  // silently dropped, and let the form enforce the right one once that choice is made.
  const MAX_O = roleProfile.MAX_OUTCOMES_LDP;

  if (attributes.length > MAX_A) {
    warnings.push(`The sheet has ${attributes.length} skills; only the first ${MAX_A} were taken.`);
  }
  const kept = attributes.slice(0, MAX_A);
  for (const attr of kept) {
    if (attr.skills.length > MAX_S) {
      warnings.push(`"${attr.attribute}" has ${attr.skills.length} attributes; only the first ${MAX_S} were taken.`);
      attr.skills = attr.skills.slice(0, MAX_S);
    }
  }
  if (outcomes.length > MAX_O) {
    warnings.push(`The sheet has ${outcomes.length} key outcomes; only the first ${MAX_O} were taken.`);
  }

  /* ---------------------------------------------------------------- totals */
  const attrTotal = kept.reduce((t, a) => t + (a.weight || 0), 0);
  if (Math.abs(attrTotal - roleProfile.TOTAL_WEIGHT) > 0.001) {
    warnings.push(`The skill weights add up to ${attrTotal}, not ${roleProfile.TOTAL_WEIGHT}. `
      + 'Fix them below before submitting.');
  }
  for (const attr of kept) {
    const sum = attr.skills.reduce((t, s) => t + (s.weight || 0), 0);
    if (attr.weight !== null && Math.abs(sum - attr.weight) > 0.001) {
      warnings.push(`"${attr.attribute}": its attribute weights total ${sum}, but the skill weight is ${attr.weight}.`);
    }
  }

  return {
    sheet: sheet.name,
    designation,
    mission,
    outcomes: outcomes.slice(0, MAX_O),
    attributes: kept,
    skillCount: kept.reduce((t, a) => t + a.skills.length, 0),
    warnings,
  };
}

/**
 * Parse the workbook. Without a sheet name every sheet is read and the tidiest result wins
 * — fewest warnings, then the most complete — because a file commonly carries the previous
 * draft on another tab.
 */
async function parse(buffer, options = {}) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    return { error: 'That file could not be opened as a spreadsheet. Save it as .xlsx and try again.' };
  }
  if (!workbook.worksheets.length) return { error: 'That file has no sheets in it.' };

  const names = workbook.worksheets.map((s) => s.name);

  if (options.sheet) {
    const wanted = workbook.worksheets.find((s) => s.name === options.sheet);
    if (!wanted) return { error: `That workbook has no sheet called "${options.sheet}".` };
    const one = parseSheet(wanted);
    return one.error ? { ...one, sheets: names } : { ...one, sheets: names };
  }

  const results = workbook.worksheets.map((sheet) => parseSheet(sheet)).filter((r) => !r.error);
  if (!results.length) {
    const first = parseSheet(workbook.worksheets[0]);
    return { ...first, sheets: names };
  }

  results.sort((a, b) =>
    a.warnings.length - b.warnings.length
    || b.attributes.length - a.attributes.length
    || b.skillCount - a.skillCount);

  return { ...results[0], sheets: names };
}

module.exports = { parse, parseSheet };
