// scripts/generate-sprites.js — generate YouTube-style scrub sprite sheets for
// LOCAL-file entries (data/videos.json entries with a filePath).
//   node scripts/generate-sprites.js            # all local entries
//   node scripts/generate-sprites.js <videoId>  # just one
'use strict';

const path = require('path');
const fs = require('fs');
const sprites = require('../lib/sprites');
const ingest = require('../lib/ingest');

const SCRUB = (() => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
  return cfg.scrub || {};
})();

const only = process.argv[2];
const library = ingest.loadLibrary();
const targets = library.filter(v => v.filePath && fs.existsSync(v.filePath) && (!only || v.id === only));

(async () => {
  let ok = 0, skip = 0, fail = 0;
  for (const v of targets) {
    if (sprites.hasSprites(v.id)) { skip++; console.log(`SKIP ${v.id}`); continue; }
    try {
      const r = await sprites.generate(v.filePath, v.id, SCRUB);
      ok++;
      console.log(`OK   ${v.id} (${r.frames} frames)`);
    } catch (e) {
      fail++;
      console.log(`FAIL ${v.id} — ${e.message}`);
    }
  }
  console.log(`\ndone: ${ok} generated, ${skip} skipped, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
