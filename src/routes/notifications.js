'use strict';
const express = require('express');
const notification = require('../models/notification');
const mw = require('../middleware');

const router = express.Router();
router.use(mw.loggedIn);

router.get('/', async (req, res) => {
  await res.page('notifications', {
    items: await notification.forUser(req.session.emp_code),
    title: 'Notifications — Pakka Role Profile',
    pageTitle: 'Notifications',
    activeNav: 'notifications',
  });
});

/** Open a notification: mark it read, then go where it points. */
router.get('/:id(\\d+)/open', async (req, res) => {
  const row = await notification.findFor(Number(req.params.id), req.session.emp_code);
  if (!row) return res.redirect('/notifications');
  await notification.markRead(Number(req.params.id), req.session.emp_code);
  res.redirect(row.link ? `/${String(row.link).replace(/^\//, '')}` : '/notifications');
});

router.post('/read-all', async (req, res) => {
  await notification.markAllRead(req.session.emp_code);
  req.session.flashSuccess = 'All notifications marked as read.';
  res.redirect('/notifications');
});

module.exports = router;
