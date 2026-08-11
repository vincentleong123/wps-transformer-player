// lib/preview.js
// Hover-preview clips: cut ~8s from the middle of every video once and cache
// it to disk, so hover previews are pure static-file serving (zero origin
// hits, survives hundreds of concurrent hoverers).
//
//   local    → ffmpeg seeks into the file directly (fast, no download)
//   external → the resolved stream is downloaded once (throttled via the
//              transformer's politeness layer), the middle is cut out, and
//              the temporary download is discarded.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const transformer = require('./transformer');

const CLIP_SEC = 8;
const MAX_BYTES = 800 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 20 * 60 * 1000;

let dir = null;
let tmpDir = null;

function init(cfg) {
  dir = path.resolve(__dirname, '..', (cfg && cfg.previewDir) || 'data/previews');
  tmpDir = path.join(dir, '.tmp');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
  } catch (e) {}
}

function fileFor(id) {
  return path.join(dir, id + '.mp4');
}

function getDir() {
  return dir;
}

function hasPreview(id) {
  const f = fileFor(id);
  try { return fs.existsSync(f) && fs.statSync(f).size > 0; } catch (e) { return false; }
}

function durationSeconds(fp) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fp], { timeout: 20000 }, (err, stdout) => {
      const secs = parseFloat(String(stdout || '').trim());
      resolve(isNaN(secs) ? 0 : secs);
    });
  });
}

// Cut CLIP_SEC seconds from the middle of `src` into `out` (re-encode to a
// small, seek-friendly mp4 so every file produces a valid clip).
function extractMiddle(src, out) {
  return durationSeconds(src).then((dur) => {
    if (!dur || dur < CLIP_SEC) throw new Error('duration too short');
    const start = Math.max(0, dur / 2 - CLIP_SEC / 2);
    const args = [
      '-loglevel', 'error', '-y',
      '-ss', String(start), '-t', String(CLIP_SEC), '-i', src,
      '-vf', 'scale=-2:360', '-an', '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '26', '-movflags', '+faststart', '-f', 'mp4', out
    ];
    return new Promise((resolve, reject) => {
      execFile('ffmpeg', args, { timeout: 120000 }, (err) => err ? reject(err) : resolve());
    });
  });
}

// Local file: seek + cut directly (no download needed).
function buildLocal(filePath, id) {
  const out = fileFor(id);
  fs.mkdirSync(dir, { recursive: true });
  return extractMiddle(filePath, out).then(() => out);
}

// External source: download the resolved stream once, cut, discard the temp.
function buildExternal(v, id) {
  const out = fileFor(id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(tmpDir, id + '.download.mp4');
  return resolveSource(v.source)
    .then((src) => {
      if (!src || src.type === 'hls' || /\.m3u8/i.test(src.url)) throw new Error('unsupported source type');
      return downloadTo(src, tmp);
    })
    .then(() => extractMiddle(tmp, out))
    .then(() => out)
    .catch((err) => {
      try { fs.unlinkSync(tmp); } catch (e) {}
      throw err;
    });
}

async function resolveSource(source) {
  if (!source) return null;
  if (source.type === 'embed') return transformer.resolveEmbed(source);
  return source;
}

function downloadTo(src, fp) {
  return transformer.fetchStream(src).then((up) => {
    if (up.statusCode < 200 || up.statusCode >= 300) { up.resume(); throw new Error('upstream ' + up.statusCode); }
    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(fp);
      let size = 0;
      const to = setTimeout(() => { up.destroy(new Error('download timeout')); }, DOWNLOAD_TIMEOUT);
      up.on('data', (c) => { size += c.length; if (size > MAX_BYTES) up.destroy(new Error('download too large')); });
      up.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => { clearTimeout(to); resolve(); });
      up.pipe(ws);
    });
  });
}

module.exports = { init, fileFor, getDir, hasPreview, buildLocal, buildExternal };
