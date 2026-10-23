'use strict';
/**
 * A flash message set just before a redirect must be the one the next page shows.
 * Uses the real file-backed session store, because that is where the race lived.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};

function request(port, urlPath, cookie) {
  return new Promise((resolve) => {
    http.get({ port, path: urlPath, headers: cookie ? { cookie } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({
        status: res.statusCode,
        location: res.headers.location || '',
        cookie: (res.headers['set-cookie'] || [])[0] || cookie,
        body,
      }));
    });
  });
}

(async () => {
  const app = express();
  app.use(session({
    name: 'rp_test',
    secret: 'test',
    resave: false,
    saveUninitialized: false,
    store: new FileStore({
      path: path.join(__dirname, '..', 'writable', 'sessions-test'),
      retries: 1, logFn: () => {},
    }),
  }));

  // The same guard server.js installs.
  app.use((req, res, next) => {
    const redirect = res.redirect.bind(res);
    res.redirect = (...args) => {
      if (req.session && typeof req.session.save === 'function') {
        return req.session.save(() => redirect(...args));
      }
      return redirect(...args);
    };
    next();
  });

  app.get('/set/:msg', (req, res) => {
    req.session.flashSuccess = req.params.msg;
    res.redirect('/read');
  });
  app.get('/read', (req, res) => {
    const msg = req.session.flashSuccess || '(none)';
    delete req.session.flashSuccess;
    res.send(msg);
  });

  const server = app.listen(0);
  const port = server.address().port;

  // Warm up so a session cookie exists.
  let cookie = (await request(port, '/set/warmup')).cookie;
  await request(port, '/read', cookie);

  let wrong = 0;
  for (let i = 1; i <= 25; i++) {
    const message = `message-${i}`;
    const r = await request(port, `/set/${message}`, cookie);
    cookie = r.cookie || cookie;
    const read = await request(port, r.location, cookie);
    if (read.body !== message) { wrong++; console.log(`   round ${i}: got "${read.body}"`); }
  }
  check('25 redirects each showed their own message', wrong, 0);

  // And a message is shown once only.
  const first = await request(port, '/set/only-once', cookie);
  await request(port, '/read', cookie);
  const again = await request(port, '/read', cookie);
  check('a flash is not shown twice', again.body, '(none)');

  server.close();
  require('fs').rmSync(path.join(__dirname, '..', 'writable', 'sessions-test'), { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
