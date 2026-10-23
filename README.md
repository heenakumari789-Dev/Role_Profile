# Pakka Role Profile — Node.js

A Node/Express port of the CodeIgniter 4 portal in `../role_profile`. Same database,
same screens, same rules; nothing about the data model changed.

## Running it

```
npm install
npm start          # http://localhost:3000
npm run dev        # same, restarting on file changes
```

Settings live in `.env`:

| Key | Meaning |
| --- | --- |
| `PORT` | Port to listen on (3000) |
| `DB_*` | MySQL connection — points at `yashpakk_displ7qd_yash_lp` |
| `LMS_SCHEMA` | Schema holding `emp_master`, joined for Pracharak names (`pakka_lms`) |
| `ADMIN_CODES` | Employee codes that act as PSP Approver (`MM008`) |
| `EXCLUDED_SANGHS` | Sanghs left out as subjects — `SS,SS1` belong to LDP |
| `SESSION_SECRET` | Change this before anything but local use |

Sessions are files under `writable/sessions/`.

## Layout

```
server.js               middleware stack and route mounting
src/config/             .env into one object
src/lib/db.js           mysql2 pool: query / first / run / transaction
src/lib/render.js       res.page(view, data) — renders a view inside the layout
src/lib/scope.js        the SS/SS1 exclusion, as one SQL fragment
src/models/             one file per table group; all SQL lives here
src/middleware/         auth, CSRF, and the locals every page needs
src/routes/             one file per section, mirroring the CI controllers
src/views/              EJS; partials/layout.ejs wraps every page
public/css/app.css      the whole stylesheet, brand colours only
```

EJS has no template inheritance, so `res.page()` renders the page first and passes it
to the layout as `body`. That is the only structural difference from the PHP views.

## Roles

| Sees | Member list | My Members | Create RP | Assign | Assess |
| --- | --- | --- | --- | --- | --- |
| PSP Approver (`MM008`) | yes | — | — | yes | corrections only |
| RP Creator (has members) | — | yes | yes | — | yes, once per year |
| Member | — | — | — | — | own, read-only |

Landing pages follow the same rule as the PHP app: admin to `/assign/sangh`, anyone
with members to `/my-members`, everyone else to `/role-profiles`. Nobody but the admin
is ever sent to `/`.

## Tests

```
npm test           # read-only: every route for every role, plus content vs the database
npm run test:writes
```

`npm test` only reads. `npm run test:writes` first clones the schema into
`yashpakk_rp_sandbox` and runs entirely against that copy — it never writes to the live
database. Drop the sandbox when you are done:

```sql
DROP DATABASE yashpakk_rp_sandbox;
```

`tests/smoke.js` swaps `express-session` for an in-memory stub so pages can be fetched
as any member without a password. That stub is test-only; the app itself has no such
bypass.

## Financial years

The current year is worked out from the calendar (April–March), so it rolls over on
1 April with nobody editing anything. If `tbl_financial_year` has no row for it, the
app adds one, filling `month1`–`month12` in the master's own `26-Apr` … `27-Mar` format
so the row is indistinguishable from a hand-entered one.

It also moves `status = '1'` onto the new year. That flag is how the LP and PSP portals
decide which year is current, so all three roll over together on 1 April with nobody
editing the table. Two consequences worth knowing:

* LP and PSP will show the new year from the moment someone opens this portal on or
  after 1 April.
* If the flag is moved onto some other year by hand, this portal pulls it back to the
  calendar year on the next page load. To park LP/PSP on an older year deliberately,
  this behaviour has to come out of `ensureCurrentFlag()`.

Assessments may be written for the current year and the one before it; everything older
is read-only for everyone. An RP Creator gets one assessment per member per year and it
is final once saved. The PSP Approver may correct an existing one, within the same two-
year window.

## PDF downloads

Two documents, both laid out like the master role-profile spreadsheet — mission, key
outcomes, then SN / Attribute / Technical Skills / Weightage / Sub-Weightage with the
attribute cells spanning their skills, and a total row.

| Where | Link | Contents |
| --- | --- | --- |
| Role profile page, once approved | `/role-profiles/:id/pdf` | The profile as approved |
| Assessment page and the assessment list | `/role-profiles/:id/assess/:code/pdf?fy=YYYY-YYYY` | The same, plus Rating, Score and Training Gap columns, the score and percentage, and a list of the gaps noted |

Built with PDFKit (`src/lib/pdf.js`) — A4 landscape, brand colours throughout, Pakka
logo on the header band of every page. Nothing is fetched at render time.

Access follows the pages themselves: the role profile PDF needs `canView` and an
approved status; the assessment PDF is for the RP Creator, the RP Approver, the PSP
Approver and the member it is about. A year with no assessment has nothing to download
and redirects back with a message.

The logo lives at `public/img/pakka-logo.png` (copied from the PSP portal). Replace that
file to change it — it is read from disk, not over HTTP.

## Who a role profile applies to

Only the members the **admin assigns** — the PSP Approver for a PSP profile, the LDP Admin
for an LDP one. Nothing is applied automatically: holding the profile's designation does not
put anyone on it, and approval alone applies it to nobody. Once a profile is approved the
admin opens its **Members** tab and ticks who it is for; the sangh's members are listed with
those holding the designation first, and anyone already on another profile is flagged.
Assigned members are notified, and so are their RP Creator, RP Approver and Pracharak (the
creator assesses them). Removing someone takes the profile off them. Authors cannot assign
or remove. Someone who has left is neither shown nor assessed. A re-approved profile keeps
its members, who are told about the new version.

Profiles used to apply themselves to everyone holding the designation.
`node scripts/migrate_manual_assignment.js` previews which members that rule covered, and
`--apply` turns them into ordinary assignments so nobody loses their profile or the
assessments written against it. Run it once when deploying this change; it is safe to rerun.

## Admins can write role profiles too

Besides the people who lead members, the **PSP Approver** can create (and import, and clone)
role profiles for any PSP sangh, and the **LDP Admin** for Sanghrakshak Sangh and Seva Sangh.
Neither has an RP Approver of their own, so what they submit goes straight to final
approval — which is theirs — and they approve it themselves; the Create form says so.

## Who gives final approval

Every profile is approved in two stages: the creator's RP Approver, then a final approver.
The final approver depends on the programme:

| Programme | Sanghs | Final approver | Codes |
| --- | --- | --- | --- |
| PSP | every sangh except SS/SS1 | PSP Approver | `ADMIN_CODES` |
| LDP | Sanghrakshak Sangh, Seva Sangh (`EXCLUDED_SANGHS`) | LDP Admin | `LDP_ADMIN_CODES` |

Both stages store `status = pending_admin`; the profile's `program` decides whose desk it is
on, and screens read "Awaiting PSP Approver" or "Awaiting LDP Admin" accordingly. The PSP
Approver sees and acts on PSP profiles, the LDP Admin on LDP ones; notifications, the
pending count and the approval timeline follow the same split. `LDP_ADMIN_CODES` defaults to
`ADMIN_CODES`, so until it is set one person (MM008) holds both roles. Assessments, member
assignment and the yearly review are unchanged and still belong to the PSP Approver. The
rules live in `finalApprover()` in `src/models/roleProfile.js`.

## Editing before approval

A submitted role profile can still be changed while it waits, one level at a time:

| Waiting on | Who may edit |
| --- | --- |
| RP Approver | the author, and the RP Approver |
| Final approver — PSP Approver, or LDP Admin for LDP (the RP Approver has approved) | the final approver only |
| Final approver (no separate RP Approver — the creator is their own) | the author, and the final approver |

An edit keeps the profile where it is — nothing is approved, rejected or sent back — and the
person editing then approves or rejects as usual. Everyone else involved so far gets a
notification, and History records who edited at which stage. Only the content can change at
this point — mission, key outcomes, skills and their weightage, attributes and their
individual weightage, and (for LDP) each skill's assessment mechanism. The sangh and
designation are fixed for everyone, the author included, and the server ignores them if a
form sends something else. Whatever stands at the PSP Approver's approval is what gets
frozen as the new version. Only the author submits; an approver who edits does not.

The rules live in `canEdit()` in `src/models/roleProfile.js`; pending edits are saved by
`updatePending()` in `src/routes/roleProfiles.js`.

## Designations

The Create form's designation list holds every designation the chosen sangh has ever had —
held by current members or only by former ones — plus designations created in the portal for
that sangh. It shows names only, no member counts. "+ New designation" under the list adds a
role nobody has held there yet to the sangh picked in the form (any sangh the person leads);
it goes into the portal's own `rp_designations` table and the shared `designations` master is
not touched. A name that already exists in the sangh, in any capitalisation, is reused rather
than duplicated. A designation typed into a form that the sangh has never had is refused.
While a profile is waiting for approval its designation is fixed, so the option is not shown
on that form.

The **Designations** page (`/designations`, in the sidebar) does the same outside the Create
form, and lists each sangh's designations: how many active members hold it, whether only
former members ever did, who added it in the portal, and whether it already has a role
profile. RP Creators and RP Approvers can add to the sanghs they lead — but an LDP sangh
(SS/SS1) belongs only to its **RP Creators**: being an RP Approver for members there does
not give it, on this page, on the Create form, or on My Members (an SS/SS1 member is
listed only for their RP Creator). Beyond that, the
**PSP Approver** can add to any **PSP** sangh and the **LDP Admin** to the **LDP** sanghs —
Sanghrakshak Sangh and Seva Sangh (`EXCLUDED_SANGHS`, SS/SS1) belong to LDP, never PSP.
(`LDP_ADMIN_CODES` defaults to `ADMIN_CODES`, so one person holding both roles sees both.)
Members with nobody to lead do not see it.

Every sangh dropdown groups sanghs under "PSP sanghs" and "LDP — Sanghrakshak & Seva Sangh",
and role profiles carry a PSP or LDP tag next to their sangh in the list and on their page. Whatever
is added appears in that sangh's designation dropdown when creating a role profile.

Anything in an LDP sangh (`EXCLUDED_SANGHS`, i.e. SS/SS1) counts as an LDP profile, so a new
designation created there needs the LDP number of key outcomes.

Run `npm run migrate:designations` (`node scripts/migrate_designations.js`) once to create
`rp_designations`; it is safe to run again. `npm run check:db` reports it if missing.

## Zoho Recruit

`src/routes/api.js` is a small read-only API that Zoho Recruit's MRF Form calls to ask
whether a designation already has a role profile:

```
GET /api/role-profile?sangh=DVS&designation=Web%20Development%20Head
```

It answers `found` with a link straight to the profile, or `not_found` with a link to the
create form with the sangh and designation already chosen. It never returns assessment
data — scores belong to the member, not to a recruitment record.

Two settings switch it on, and it stays shut (503) until they are set:

```
API_TOKEN=<a long random string>
PUBLIC_URL=https://<the address Zoho can reach the portal on>
```

The token is checked in constant time and accepted as `X-API-Token` or `Bearer`.

`docs/zoho-recruit-mrf.md` has the fields to add on the MRF Form module, the Deluge
function to attach to its workflow rule, and what each answer means.

## Filling a profile in from Excel

The Create form accepts an `.xlsx` in the Pakka layout — designation, `Mission:`,
`Key Outcomes:`, then a `SN | Attribute | Technical Skills | Weightage | Sub-Weightage`
table with the attribute and its weight spanning that attribute's skills, ending in a
`Total` row. `src/lib/importer.js` reads it with ExcelJS.

Every sheet in the workbook is parsed and the tidiest result wins — fewest warnings, then
the most complete — because these files usually carry an older draft on another tab. The
summary names the sheet it used and offers to read a different one.

Uploading **saves nothing**. The parsed content comes back as a filled-in form, with any
problems listed (too many attributes or skills for the format, weights that do not add up),
for the creator to pick the designation and submit in the usual way.

The upload is multipart, which the body parser does not read, so `mw.csrf` lets multipart
requests through and the import route calls `mw.verifyToken(req)` itself once multer has
parsed the body.

## One profile per designation, and cloning

A designation can carry only **one** role profile in a sangh. Designations that already
have one still appear in the Create form's dropdown, greyed out, labelled with the status
and author — so it is clear the role is covered rather than missing. The same rule is
enforced in `validateSubmission()`, so a stale page cannot slip a second one through.

A **rejected** profile does not hold the designation; it was turned down, so the
designation is free again. Draft, in-approval and approved ones all hold it.

**Clone** starts a new profile from an existing one. It can be reached three ways: the
Clone button on the list, the one on a profile's own page, or the "start from an existing
role profile" picker at the top of the Create form. All three land on
`/role-profiles/:id/clone`, which copies mission,
key outcomes, attributes, skills and weights, leaves the designation blank, and saves
through the normal create path. The source is untouched — this is for
roles that are close in shape but need their own weights or a few different skills.

## Versions and the yearly review

A role profile is edited in place, but **every approval freezes an immutable copy** in
`rp_profile_versions` (with its own outcomes and skill rows). An assessment records which
copy it was written against, and its ratings point at that copy's rows — so reopening a
two-year-old assessment shows the wording that was in force then, not today's.

Each financial year the profile is reviewed:

* **No change** — one click records the year against the version already in force.
* **Update** — the author edits the approved profile, which sends it back through
  approval. The old version stays in force meanwhile, and approval cuts a new version
  that the year then points at.

Assessments for a year cannot be written until that year has been reviewed, so a score is
always tied to a settled version. A correction by the PSP Approver stays on the version
the assessment was originally written against.

`rp_profile_reviews` holds one row per (profile, financial year): which version applies,
whether the review left it unchanged or updated, who recorded it and when. The Versions
tab on a role profile lists every version with the years it covers, how many assessments
were made against it, and a read-only view plus PDF of each.

Run `node scripts/migrate_versions.js` once against a database that predates this — it
adds the tables, adds nullable columns, and backfills version 1 for every already-approved
profile, linking existing assessments to it. It is safe to run again.

## PDFs

Approved role profiles, frozen versions and completed assessments all download as PDFs
laid out like the master spreadsheet: mission, key outcomes, then SN / Attribute /
Technical Skills / Weightage / Sub-Weightage with the attribute cells spanning their
skills and a total row. An assessment PDF adds Rating, Score and Training Gap columns and
names the version it was scored against. Built with PDFKit in `src/lib/pdf.js`; the Pakka
logo is `public/img/pakka-logo.png`.

## Known quirk, carried over from the PHP app

On the member pages a Pracharak with no name in `tbl_employee` falls back to
`pakka_lms.emp_master`. The sangh summary does not do that fallback, so a sangh can
read "not set" for Pracharak while its members each show one. Both apps behave this
way; fixing it means changing `models/sangh.js` and `SanghModel.php` together.
