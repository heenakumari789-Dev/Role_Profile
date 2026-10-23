'use strict';
const { build, signIn, get } = require('./smoke');

const USERS = {
  MM008:  { code: 'MM008',  name: 'LMS',           isAdmin: true  },  // PSP Approver
  M00151: { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false }, // RP Creator, 11 members
  M01078: { code: 'M01078', name: 'Heena Kumari',  isAdmin: false },  // assigned member
  M00934: { code: 'M00934', name: 'Amit Kumar',    isAdmin: false },  // assigned member
  GUEST:  null,
};

// [path, expectation per user] — "ok" = 200, "->/x" = redirect, "404" etc.
const PAGES = [
  '/', '/login', '/my-members', '/notifications', '/assessments', '/designations',
  '/role-profiles', '/role-profiles/create', '/role-profiles/1', '/role-profiles/1/edit',
  '/role-profiles/1/assess/M01078', '/role-profiles/1/assess/M00934',
  '/role-profiles/1/versions/1', '/role-profiles/1/versions/999',
  '/assign', '/assign/sangh', '/assign/sangh/MSS',
  '/role-profiles/999', '/nope',
];

(async () => {
  const app = build();
  const server = app.listen(0);
  const port = server.address().port;
  for (const u of Object.values(USERS)) if (u) signIn(u);

  const width = Math.max(...PAGES.map(p => p.length)) + 2;
  const names = Object.keys(USERS);
  console.log('PATH'.padEnd(width) + names.map(n => n.padEnd(16)).join(''));
  console.log('-'.repeat(width + names.length * 16));

  let failures = 0;
  for (const p of PAGES) {
    const cells = [];
    for (const n of names) {
      const r = await get(port, p, n === 'GUEST' ? '' : n);
      let cell;
      if (r.status === 200) {
        const err = /ERROR:/.test(r.body.slice(0, 200));
        cell = err ? 'BROKEN' : `ok ${Math.round(r.body.length / 1024)}k`;
      } else if (r.status === 302) {
        cell = '-> ' + r.location.replace(/^https?:\/\/[^/]+/, '');
      } else if (r.status === 500) {
        cell = 'ERR500'; failures++;
        console.error('\n  ' + p + ' [' + n + ']: ' + r.body.slice(0, 400) + '\n');
      } else {
        cell = String(r.status);
      }
      cells.push(cell.padEnd(16));
    }
    console.log(p.padEnd(width) + cells.join(''));
  }

  server.close();
  console.log(failures ? `\n${failures} route(s) errored.` : '\nNo 500s.');
  process.exit(0);
})();
