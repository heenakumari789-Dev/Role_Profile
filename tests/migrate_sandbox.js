'use strict';
/** Run the migrations against the sandbox copy. */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';
// The versioning migration exits the process when it finishes, so it goes last.
require('../scripts/migrate_designations.js').main()
  .then(() => require('../scripts/migrate_versions.js'))
  .catch((err) => { console.error(err); process.exit(1); });
