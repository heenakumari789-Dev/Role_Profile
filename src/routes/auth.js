'use strict';
const { displayName } = require('../lib/displayName');
const express = require('express');
const employee = require('../models/employee');
const mw = require('../middleware');

const router = express.Router();

router.get('/login', async (req, res) => {
  if (req.session.logged_in) return res.redirect(await mw.landingUrl(req));
  await res.page('login', { title: 'Sign In — Pakka Role Profile', pageTitle: 'Sign In', activeNav: 'login' });
});

router.post('/login', async (req, res) => {
  const empCode = String(req.body.emp_code || '').trim();
  const password = String(req.body.password || '');

  if (!empCode || !password) {
    req.session.flashError = 'Enter both your member code and password.';
    return res.redirect('/login');
  }

  const member = await employee.authenticate(empCode, password);
  if (!member) {
    req.session.flashError = 'Those credentials were not recognised.';
    return res.redirect('/login');
  }

  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.logged_in = true;
    req.session.emp_code = member.emp_code;
    req.session.emp_name = displayName(member.emp_code, member.name);
    req.session.is_admin = mw.isAdmin(member.emp_code);
    req.session.is_ldp_admin = mw.isLdpAdmin(member.emp_code);

    req.session.save(async () => {
      const target = req.session.redirect_after_login;
      delete req.session.redirect_after_login;
      res.redirect(target || (await mw.landingUrl(req)));
    });
  });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
