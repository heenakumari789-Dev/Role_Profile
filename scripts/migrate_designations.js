'use strict';
/**
 * Adds rp_designations: designations created in the portal for a sangh, for roles nobody has
 * held there yet. The shared `designations` master is not touched.
 *
 * Safe to run more than once.
 */
const db = require('../src/lib/db');

const say = (msg) => console.log('  ' + msg);

async function tableExists(name) {
  const row = await db.first(
    `SELECT COUNT(*) n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`, [name]);
  return Number(row.n) > 0;
}

async function main() {
  console.log(`Migrating ${(await db.first('SELECT DATABASE() d')).d}\n`);

  if (await tableExists('rp_designations')) {
    say('rp_designations — already there');
  } else {
    await db.run(`
      CREATE TABLE rp_designations (
        id INT(11) NOT NULL AUTO_INCREMENT,
        sangh_code VARCHAR(50) NOT NULL,
        designation_name VARCHAR(255) NOT NULL,
        created_by VARCHAR(50) NOT NULL DEFAULT '',
        created_by_name VARCHAR(255) NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_sangh_designation (sangh_code, designation_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    say('rp_designations — created');
  }

  console.log('\nDone.');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { tableExists, main };
