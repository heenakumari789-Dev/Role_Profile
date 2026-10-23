'use strict';
const { displayName } = require('./displayName');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

/** Brand palette, the same values as public/css/app.css. */
const C = {
  maroon: '#A3243C', maroonDark: '#8B1E33', maroonLight: '#C4324F',
  green: '#5E6337', greenDark: '#4A4E2B',
  blue: '#1EA2DC', blueDark: '#1889BA',
  sand: '#FAE7C1', sandLight: '#FDF3E0', sandDark: '#E8D4A8',
  yellow: '#F8A91B', yellowDark: '#E09510',
  text: '#1A1A2E', textSoft: '#5A5A72', muted: '#8E8EA0',
  border: '#E8E4DD', white: '#FFFFFF',
};

const LOGO = path.join(__dirname, '..', '..', 'public', 'img', 'pakka-logo.png');
const hasLogo = fs.existsSync(LOGO);

const MARGIN = 18;
const PAGE = { size: 'A4', layout: 'landscape' };
const num = (v) => {
  const n = Math.round(Number(v || 0) * 100) / 100;
  return String(n % 1 === 0 ? n : n.toFixed(2).replace(/0$/, ''));
};
const dateText = (v, withTime = false) => {
  if (!v) return '';
  const d = new Date(String(v).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(v);
  if (!withTime) return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());
};

/* ------------------------------------------------------------------ chrome */

/**
 * Maroon band across the top with the logo on it. Drawn on every page, so a table that
 * runs over keeps its identity — and the table header is redrawn to match.
 */
const HEADER_H = 34;
const CONTENT_TOP = HEADER_H + 8;
const FOOTER_H = 14;

function header(doc, title, subtitle) {
  const w = doc.page.width;
  doc.rect(0, 0, w, HEADER_H).fill(C.maroon);
  doc.rect(0, HEADER_H, w, 2).fill(C.yellow);

  const logoW = hasLogo ? 82 : 0;
  if (hasLogo) doc.image(LOGO, MARGIN, 6, { height: 22 });

  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(11)
    .text(title, MARGIN + logoW, 6, { width: w - MARGIN * 2 - logoW - 150, lineBreak: false });

  if (subtitle) {
    doc.font('Helvetica').fontSize(7.5).fillColor(C.sand)
      .text(subtitle, MARGIN + logoW, 19, { width: w - MARGIN * 2 - logoW - 150, lineBreak: false });
  }
  doc.fillColor(C.text);
}

function footer(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    // The footer sits below the bottom margin, and writing there makes PDFKit start a
    // fresh page. Dropping the margin for the duration keeps it on the page it belongs to.
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - FOOTER_H;
    doc.rect(0, y, doc.page.width, FOOTER_H).fill(C.sandLight);
    doc.font('Helvetica').fontSize(6.5).fillColor(C.muted)
      .text('Pakka © ' + new Date().getFullYear() + ' — Role Profile Portal', MARGIN, y + 3, {
        width: doc.page.width - MARGIN * 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, MARGIN, y + 3, {
      width: doc.page.width - MARGIN * 2, align: 'right', lineBreak: false });

    doc.page.margins.bottom = keep;
  }
}

/**
 * A tinted block for the mission, the key outcomes and the training gaps.
 *
 * `lines` is a list of { num?, text, sub? }. The height is measured before anything is
 * drawn, so the background can go down first and the text lands on top of it once.
 */
function panel(doc, x, y, w, label, accent, lines) {
  const LABEL_H = 12;
  const indent = 14;
  const bodyW = w - 14 - indent;

  const measured = lines.map((line) => {
    doc.font(line.sub ? 'Helvetica' : 'Helvetica').fontSize(7.5);
    const width = line.num ? bodyW : w - 14;
    return { ...line, h: doc.heightOfString(line.text, { width }) };
  });
  const bodyH = measured.reduce((t, m) => t + m.h + 1, 0);
  const h = LABEL_H + bodyH + 4;

  doc.roundedRect(x, y, w, h, 4).fill(C.sandLight);
  doc.rect(x, y, 2.5, h).fill(accent);

  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(accent)
    .text(label.toUpperCase(), x + 7, y + 3, { width: w - 14, characterSpacing: 0.5, lineBreak: false });

  let ty = y + LABEL_H;
  measured.forEach((m) => {
    if (m.num) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(accent)
        .text(m.num, x + 7, ty, { width: indent - 2, lineBreak: false });
      doc.font('Helvetica').fontSize(7.5).fillColor(C.text)
        .text(m.text, x + 7 + indent, ty, { width: bodyW });
    } else {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.text)
        .text(m.text, x + 7, ty, { width: w - 14, align: m.justify ? 'justify' : 'left' });
    }
    ty += m.h + 1;
  });

  doc.fillColor(C.text);
  return y + h + 4;
}

/* ------------------------------------------------------------------ tables */

/**
 * Group the flat detail rows into attributes, the way the spreadsheet merges the
 * attribute and weightage cells across an attribute's skills.
 */
function groupAttributes(details) {
  const out = [];
  for (const d of details) {
    let last = out[out.length - 1];
    if (!last || last.no !== d.attribute_no) {
      last = { no: d.attribute_no, name: d.attribute, weight: d.attribute_weight, skills: [] };
      out.push(last);
    }
    last.skills.push(d);
  }
  return out;
}

/** Column widths that fill the printable width exactly. */
function layout(doc, cols) {
  const usable = doc.page.width - MARGIN * 2;
  const total = cols.reduce((t, c) => t + c.w, 0);
  let x = MARGIN;
  return cols.map((c) => {
    const w = (c.w / total) * usable;
    const col = { ...c, x, w };
    x += w;
    return col;
  });
}

function tableHead(doc, cols, y) {
  const h = 14;
  doc.rect(MARGIN, y, doc.page.width - MARGIN * 2, h).fill(C.green);
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.white);
  cols.forEach((c) => {
    doc.text(c.label, c.x + 4, y + 4, { width: c.w - 8, align: c.align || 'left', lineBreak: false });
  });
  doc.fillColor(C.text);
  return y + h;
}

/** How tall a row must be to fit every cell's wrapped text. */
function rowHeight(doc, cols, cells, pad = 4) {
  let h = 10;
  cols.forEach((c, i) => {
    const text = cells[i] == null ? '' : String(cells[i]);
    if (text === '') return;
    doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(c.size || 6.5);
    h = Math.max(h, doc.heightOfString(text, { width: c.w - 8 }) + pad);
  });
  return h;
}

/* ----------------------------------------------------------- role profile */

/**
 * The approved role profile, laid out like the "Proposed" sheet: mission, key outcomes,
 * then SN / Attribute / Technical Skills / Weightage / Sub-Weightage with the attribute
 * cells spanning their skills, and a total row.
 */
function roleProfile({ profile, outcomes, details, assessment = null, versionLabel = null }) {
  const doc = new PDFDocument({ ...PAGE, margin: MARGIN, bufferPages: true,
    info: { Title: `Role Profile — ${profile.designation_name}`, Author: 'Pakka' } });

  const scored = !!assessment;
  // Widths are relative; the two weightage columns need enough room for their headings.
  const cols = layout(doc, scored
    ? [{ label: 'SN', w: 4, align: 'center' }, { label: 'Skill', w: 19 },
       { label: 'Attributes', w: 36 }, { label: 'Weightage', w: 9, align: 'center' },
       { label: 'Sub-Weightage', w: 11, align: 'center' }, { label: 'Rating', w: 6, align: 'center' },
       { label: 'Score', w: 6, align: 'center' }, { label: 'Training Gap', w: 15 }]
    : [{ label: 'SN', w: 5, align: 'center' }, { label: 'Skill', w: 24 },
       { label: 'Attributes', w: 51 }, { label: 'Weightage', w: 9, align: 'center' },
       { label: 'Sub-Weightage', w: 11, align: 'center' }]);

  const title = profile.designation_name;
  const subtitle = [profile.sangh_name, scored ? `Assessment ${assessment.financial_year}` : 'Role Profile', versionLabel]
    .filter(Boolean).join('  ·  ');

  header(doc, title, subtitle);
  let y = CONTENT_TOP;
  const fullW = doc.page.width - MARGIN * 2;

  /* -------- status strip */
  const chips = [];
  if (scored) {
    chips.push(['Member', assessment.member_name || assessment.emp_code]);
    chips.push(['Assessed by', displayName(assessment.assessed_by, assessment.assessed_by_name)]);
    chips.push(['Financial year', assessment.financial_year]);
    chips.push(['Score', `${num(assessment.total_score)} / ${num(assessment.max_score)}`]);
    chips.push(['Percentage', `${num(assessment.percentage)}%`]);
    if (versionLabel) chips.push(['Assessed against', versionLabel]);
  } else {
    chips.push(['Sangh', profile.sangh_name || '—']);
    chips.push(['Written by', displayName(profile.created_by, profile.created_by_name)]);
    if (profile.rp_approver_action_at) chips.push(['RP Approver', `${profile.rp_approver_name || '—'} · ${dateText(profile.rp_approver_action_at)}`]);
    if (profile.admin_action_at) chips.push([require('../models/roleProfile').finalApprover(profile).label, dateText(profile.admin_action_at)]);
    chips.push(['Status', versionLabel ? versionLabel : 'Approved']);
  }

  const CHIP_H = 18;
  const chipW = fullW / chips.length;
  doc.roundedRect(MARGIN, y, fullW, CHIP_H, 3).fill(C.sand);
  chips.forEach((chip, i) => {
    const x = MARGIN + chipW * i;
    if (i > 0) doc.rect(x, y + 3, 0.7, CHIP_H - 6).fill(C.sandDark);
    doc.font('Helvetica').fontSize(5.5).fillColor(C.maroonDark)
      .text(chip[0].toUpperCase(), x + 7, y + 2.5, { width: chipW - 12, characterSpacing: 0.4, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.text)
      .text(String(chip[1] ?? '—'), x + 7, y + 9.5, { width: chipW - 12, lineBreak: false });
  });
  y += CHIP_H + 4;

  /* -------- mission */
  if (String(profile.mission || '').trim()) {
    y = panel(doc, MARGIN, y, fullW, 'Mission', C.maroon, [{ text: profile.mission, justify: true }]);
  }

  /* -------- key outcomes */
  if (outcomes.length) {
    y = panel(doc, MARGIN, y, fullW, 'Key Outcomes', C.blueDark,
      outcomes.map((o, i) => ({ num: `${i + 1}.`, text: o.outcome })));
  }

  /* -------- the table */
  y = tableHead(doc, cols, y + 1);
  const groups = groupAttributes(details);
  const bottomLimit = doc.page.height - FOOTER_H - 4;
  let striped = false;

  const TOTAL_H = 16;

  groups.forEach((g, gi) => {
    // Measure the whole attribute block first — it must not be split across pages.
    const heights = g.skills.map((s) => rowHeight(doc, cols, [
      '', '', s.tech_skill, '', num(s.tech_weight),
      s.rating == null ? '—' : num(s.rating),
      s.rating == null ? '—' : num(Number(s.tech_weight) * Number(s.rating)),
      s.training_gap || '',
    ]));
    const blockH = heights.reduce((t, h) => t + h, 0);

    // The last block reserves room for the total row too, so the table never ends with
    // a page carrying nothing but the total.
    const reserve = gi === groups.length - 1 ? TOTAL_H : 0;
    if (y + blockH + reserve > bottomLimit) {
      doc.addPage();
      header(doc, title, subtitle);
      y = tableHead(doc, cols, CONTENT_TOP);
    }

    const blockTop = y;
    striped = !striped;
    if (striped) doc.rect(MARGIN, blockTop, fullW, blockH).fill(C.sandLight);

    // Merged cells: SN, attribute and weightage span the attribute's skills.
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.maroon)
      .text(String(g.no), cols[0].x + 4, blockTop + 3, { width: cols[0].w - 8, align: 'center', lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.text)
      .text(g.name, cols[1].x + 4, blockTop + 2.5, { width: cols[1].w - 8 });
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.green)
      .text(num(g.weight), cols[3].x + 4, blockTop + 3, { width: cols[3].w - 8, align: 'center', lineBreak: false });

    g.skills.forEach((s, i) => {
      const h = heights[i];
      doc.font('Helvetica').fontSize(6.5).fillColor(C.text)
        .text(s.tech_skill || '', cols[2].x + 4, y + 2, { width: cols[2].w - 8 });
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.textSoft)
        .text(num(s.tech_weight), cols[4].x + 4, y + 2, { width: cols[4].w - 8, align: 'center', lineBreak: false });

      if (scored) {
        const rated = s.rating != null;
        const rating = rated ? Number(s.rating) : null;
        // 4 is full marks, so the band follows the share of it.
        const tone = !rated ? C.muted : rating >= 3.5 ? C.green : rating >= 2.5 ? C.yellowDark : C.maroon;
        doc.font('Helvetica-Bold').fontSize(7).fillColor(tone)
          .text(rated ? num(rating) : '—', cols[5].x + 4, y + 2, { width: cols[5].w - 8, align: 'center', lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(rated ? C.text : C.muted)
          .text(rated ? num(Number(s.tech_weight) * rating) : '—',
            cols[6].x + 4, y + 2, { width: cols[6].w - 8, align: 'center', lineBreak: false });

        const gap = String(s.training_gap || '').trim();
        doc.font('Helvetica').fontSize(6).fillColor(gap ? C.yellowDark : C.muted)
          .text(gap || '—', cols[7].x + 4, y + 2, { width: cols[7].w - 8 });
      }

      y += h;
      if (i < g.skills.length - 1) {
        doc.rect(cols[2].x, y, fullW - (cols[2].x - MARGIN), 0.4).fill(C.border);
      }
    });

    doc.rect(MARGIN, y, fullW, 0.7).fill(C.sandDark);
  });

  /* -------- totals */
  const totalWeight = groups.reduce((t, g) => t + Number(g.weight || 0), 0);
  const subTotal = details.reduce((t, d) => t + Number(d.tech_weight || 0), 0);

  if (y + TOTAL_H > bottomLimit) { doc.addPage(); header(doc, title, subtitle); y = CONTENT_TOP; }
  doc.rect(MARGIN, y, fullW, TOTAL_H).fill(C.maroon);
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C.white)
    .text('Total', cols[0].x + 4, y + 4.5, { width: cols[1].x + cols[1].w - cols[0].x - 8, lineBreak: false });
  doc.text(num(totalWeight), cols[3].x + 4, y + 4.5, { width: cols[3].w - 8, align: 'center', lineBreak: false });
  doc.text(num(subTotal), cols[4].x + 4, y + 4.5, { width: cols[4].w - 8, align: 'center', lineBreak: false });

  if (scored) {
    doc.text(`${num(assessment.total_score)} / ${num(assessment.max_score)}`,
      cols[5].x + 4, y + 4.5, { width: cols[6].x + cols[6].w - cols[5].x - 8, align: 'center', lineBreak: false });
    doc.fillColor(C.sand)
      .text(`${num(assessment.percentage)}%`, cols[7].x + 4, y + 4.5, { width: cols[7].w - 8, lineBreak: false });
  }
  // Each gap already sits next to its own attribute in the "Training Gap" column above —
  // repeating them in a summary panel here is what pushed a scored profile to a second
  // page, for no information the table didn't already show.

  footer(doc);
  doc.end();
  return doc;
}

module.exports = { roleProfile, C };
