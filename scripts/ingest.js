// scripts/ingest.js — CLI wrapper for the feed system.
//   node scripts/ingest.js path/to/list.json
//   node scripts/ingest.js path/to/list.txt
//   type list.txt | node scripts/ingest.js
'use strict';

const fs = require('fs');
const path = require('path');
const ingest = require('../lib/ingest');

const arg = process.argv[2];

function main() {
  let payload;
  if (arg) {
    if (!fs.existsSync(arg)) { console.error('File not found: ' + arg); process.exit(1); }
    payload = fs.readFileSync(arg, 'utf8');
  } else {
    payload = fs.readFileSync(0, 'utf8'); // stdin
  }
  let entries;
  try {
    entries = ingest.parsePayload(payload);
  } catch (e) {
    console.error('Parse error: ' + e.message);
    process.exit(1);
  }
  if (!entries.length) { console.error('No URLs found.'); process.exit(1); }
  console.log(`Parsed ${entries.length} entries — ingesting...`);
  ingest.ingest(entries, { concurrency: 4, timeoutMs: 12000 }).then(report => {
    console.log(`  added: ${report.added}`);
    console.log(`  skipped (dupes): ${report.skipped}`);
    console.log(`  failed: ${report.failed}`);
    report.errors.forEach(e => console.log(`    x ${e.url || e.file || '?'} — ${e.error}`));
    process.exit(report.failed ? 1 : 0);
  }).catch(e => { console.error(e); process.exit(1); });
}

main();
