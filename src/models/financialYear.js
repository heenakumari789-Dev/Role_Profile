'use strict';
const db = require('../lib/db');

/**
 * Financial years come from the shared master `tbl_financial_year`, the same list the
 * LP and PSP portals use. The current year is derived from the calendar (April–March)
 * so it rolls over on 1 April without anyone editing the master.
 *
 * Role profiles and assessments in this portal start from 2026-2027 — the master carries
 * older years for the other portals, but they are not offered here.
 */
const START_YEAR = '2026-2027';

/** The Indian financial year containing a date, e.g. 2026-2027. */
function yearFor(date = new Date()) {
  let y = date.getFullYear();
  if (date.getMonth() + 1 < 4) y--;
  return `${y}-${y + 1}`;
}

const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

/**
 * The twelve month labels a financial year carries, in the format the master already
 * uses: 2026-2027 runs '26-Apr' through '27-Mar'. The LP portal reads these for its
 * month filter, so a year we add has to look like one entered by hand.
 */
function monthLabels(year) {
  const start = Number(year.split('-')[0]);
  return MONTHS.map((m, i) => {
    // January onwards belongs to the second calendar year.
    const y = i < 9 ? start : start + 1;
    return `${String(y).slice(2)}-${m}`;
  });
}

/**
 * Move the shared `status = '1'` flag onto the given year, if it is not already there.
 *
 * That flag is what the LP and PSP portals read as "the current year", so this changes
 * what they show as well — which is the point: on 1 April all three portals should roll
 * over together without anyone editing the table by hand. It also means a flag moved
 * manually onto some other year will be pulled back to the calendar year on the next
 * page load.
 *
 * Both statements run in one transaction so the table is never left with no current year.
 */
async function ensureCurrentFlag(year) {
  const row = await db.first('SELECT status FROM tbl_financial_year WHERE year = ? LIMIT 1', [year]);
  if (!row || String(row.status) === '1') return;

  await db.transaction(async (conn) => {
    await conn.query("UPDATE tbl_financial_year SET status = '0' WHERE status = '1'");
    await conn.query("UPDATE tbl_financial_year SET status = '1' WHERE year = ?", [year]);
  });
}

/**
 * Make sure today's financial year exists in the shared master, adding it if not, and
 * that it is the one flagged as current.
 *
 * `status` is an enum('1','0') and the month columns are NOT NULL without defaults, so
 * every one of them has to be supplied or the insert is rejected under strict mode.
 */
async function ensureCurrentExists() {
  const year = yearFor();
  const row = await db.first('SELECT id FROM tbl_financial_year WHERE year = ? LIMIT 1', [year]);
  if (!row) {
    const months = monthLabels(year);
    await db.run(
      `INSERT INTO tbl_financial_year
        (year, month1, month2, month3, month4, month5, month6,
         month7, month8, month9, month10, month11, month12, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0')`,
      [year, ...months]
    );
  }
  await ensureCurrentFlag(year);
  return year;
}

async function current() {
  return ensureCurrentExists();
}

/** The financial year before the current one. */
async function previous() {
  const start = Number((await current()).split('-')[0]) - 1;
  return `${start}-${start + 1}`;
}

/**
 * Years newest first, only those actually usable — 2026-2027 onwards, except that the
 * current year's open "previous year" is never hidden even while it is still earlier
 * than that (true for the whole first year of this system, since 2026-2027's own
 * previous is 2025-2026) — otherwise the "current + previous both open" rule below would
 * point at a year nobody could actually pick.
 */
async function years() {
  await ensureCurrentExists();
  const prev = await previous();
  const floor = prev < START_YEAR ? prev : START_YEAR;
  const rows = await db.query(
    `SELECT year, status FROM tbl_financial_year
     WHERE TRIM(COALESCE(year,'')) <> '' AND year >= ? ORDER BY id DESC`,
    [floor]
  );
  const now = yearFor();
  return rows.map((r) => ({ year: r.year, is_current: r.year === now }));
}

async function isValid(year) {
  return (await years()).some((y) => y.year === year);
}

/**
 * Assessments may only be entered or corrected for the current year and the one before
 * it; anything older is closed.
 */
async function isOpen(year) {
  return year === (await current()) || year === (await previous());
}

module.exports = { START_YEAR, yearFor, monthLabels, ensureCurrentFlag, ensureCurrentExists, current, previous, years, isValid, isOpen };
