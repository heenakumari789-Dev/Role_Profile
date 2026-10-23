'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);

const config = require('./src/config');
const mw = require('./src/middleware');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));

app.use(
  session({
    name: 'rp_session',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: new FileStore({
      path: path.join(__dirname, 'writable', 'sessions'),
      retries: 1,
      logFn: () => {},
    }),
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
  })
);

/**
 * Flash messages are put in the session and read on the next page. The file-backed store
 * writes asynchronously, so a redirect can outrun the write and the next page then reads
 * the previous message. Saving before redirecting closes that gap.
 */
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

app.use(mw.csrf);
app.use(mw.viewLocals);
require('./src/lib/render').attach(app);

// Routes
// The Recruit-facing API sits outside the session-based pages: it carries its own token.
app.use('/api', require('./src/routes/api'));

app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/home'));
app.use('/my-members', require('./src/routes/myMembers'));
app.use('/notifications', require('./src/routes/notifications'));
app.use('/role-profiles/:id(\\d+)/assess', require('./src/routes/assess'));
app.use('/role-profiles', require('./src/routes/roleProfiles'));
app.use('/assessments', require('./src/routes/assessments'));
app.use('/designations', require('./src/routes/designations'));
app.use('/assign', require('./src/routes/assign'));
app.use('/ldp-assign', require('./src/routes/ldpAssign'));

app.use((req, res) => {
  res.status(404);
  res.page('error', {
    title: 'Not found — Pakka Role Profile',
    pageTitle: 'Not found',
    code: 404,
    message: 'That page does not exist.',
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500);
  // res.page pushes render failures back through here, so fall back to plain text.
  Promise.resolve(
    res.page('error', {
      title: 'Something went wrong — Pakka Role Profile',
      pageTitle: 'Error',
      code: 500,
      message: 'Something went wrong. The details are in the server log.',
    })
  ).catch(() => res.type('text').send('Something went wrong.'));
});

// Express 4 does not catch a rejection thrown inside an async route handler — it never
// reaches the error middleware above, and Node's default since v15 is to kill the whole
// process on an unhandled rejection. That turned one bad column name in a single route
// into "localhost refused to connect" for everyone. Logging it here is a safety net so a
// future bug like that leaves the one request hanging instead of taking the server down.
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION (a request likely failed silently):', err);
});

if (require.main === module) {
  app.listen(config.port, async () => {
    console.log(`Pakka Role Profile (Node) listening on http://localhost:${config.port}`);
    // Say straight away if the database has not caught up with the code.
    await require('./src/lib/schemaCheck').report();
  });
}

module.exports = app;
