'use strict';
const express = require('express');
const employee = require('../models/employee');
const leader = require('../models/leader');
const mw = require('../middleware');

const router = express.Router();

// The full directory is for the PSP Approver only.
router.get('/', mw.adminAuth, async (req, res) => {
  const members = await employee.getDirectory();

  await res.page('member_list', {
    members,
    roles: employee.ROLES,
    candidates: await leader.allCandidates(),
    sanghLeaders: await leader.sanghLeaderMap(),
    title: 'Member List — Pakka Role Profile',
    pageTitle: 'Member List',
    activeNav: 'members',
  });
});

module.exports = router;
