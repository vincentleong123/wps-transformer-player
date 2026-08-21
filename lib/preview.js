// lib/preview.js
// Hover-preview clips: cut ~8s from the MIDDLE of every video once and cache
// it to disk, so hover previews are pure static-file serving (zero origin
// hits, survives hundreds of concurrent hoverers).
//
//   local    → ffmpeg seeks into the file directly (fast, no download)
//   external → the resolved stream is downloaded ONCE, slowly (throttled),
//              the middle is cut out, and the temporary download is discarded.
//
// A background queue builds missing previews ONE AT A TIME with a delay
// between jobs, so gallery browsing is never disturbed by preview building.
// Clips never start at 0:00 (black lead-in frames) — the start point is
// randomized inside the 30%–70% band of the duration.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Transform } = require('stream');
const transformer = require('./transformer');

const MAX_BYTES = 800 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 20 * 60 * 1000;
const MAX_ATTEMPTS = 2;

let dir = null;
let tmpDir = null;
let cfg = {
  enabled: true,
  clipSec: 8,
  kbps: 1024,      // download throttle for external sources (KB/s)
  delayMs: 5000    // pause between queue jobs
};

// ── known-preview memo (avoids statSync per card on every page render) ──────
let known = null;

function scanKnown() {
  known = new Set();
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^([\w-]+)\.mp4$/);
      if (m) known.add(m[1]);
    }
  } catch (e) {}
}

function init(c) {
  dir = path.resolve(__dirname, '..', (c && c.previewDir) || 'data/previews');
  tmpDir = path.join(dir, '.tmp');
  const p = (c && c.preview) || {};
  cfg = {
    enabled: p.enabled !== false,
    clipSec: Math.max(3, Math.min(30, parseInt(p.clipSec, 10) || 8)),
    kbps: Math.max(64, parseInt(p.kbps, 10) || 1024),
    delayMs: Math.max(500, parseInt(p.delayMs, 10) || 5000)
  };
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
  } catch (e) {}
  scanKnown();
}

function fileFor(id) {
  return path.join(dir, id + '.mp4');
}

function getDir() {
  return dir;
}

function hasPreview(id) {
  if (!known) scanKnown();
  if (known.has(String(id))) return true;
  let ok = false;
  try { ok = fs.existsSync(fileFor(id)) && fs.statSync(fileFor(id)).size > 0; } catch (e) {}
  if (ok) known.add(String(id));
  return ok;
}

function status() {
  return {
    enabled: cfg.enabled,
    queued: queue.length,
    running: running !== null,
    current: running ? running.id : null,
    built: known ? known.size : 0,
    failed: Object.keys(attempts).length
  };
}

// ── ffmpeg helpers ──────────────────────────────────────────────────────────

function durationSeconds(fp) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fp], { timeout: 20000 }, (err, stdout) => {
      const secs = parseFloat(String(stdout || '').trim());
      resolve(isNaN(secs) ? 0 : secs);
    });
  });
}

// Pick a start point inside the 30%–70% band so clips never open on the
// black/fade-in frames at 0:00 and successive rebuilds vary a little.
function pickStart(dur) {
  const clip = cfg.clipSec;
  const lo = dur * 0.30;
  const hi = Math.max(lo, dur * 0.70 - clip);
  const s = lo + Math.random() * Math.max(0, hi - lo);
  return Math.max(0, Math.min(s, Math.max(0, dur - clip)));
}

// Cut clipSec seconds starting at `start` from `src` into `out` (re-encode to
// a small, seek-friendly mp4 so every file produces a valid clip).
function extractClip(src, out, start) {
  const args = [
    '-loglevel', 'error', '-y',
    '-ss', String(start), '-t', String(cfg.clipSec), '-i', src,
    '-vf', 'scale=-2:360', '-an', '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '26', '-movflags', '+faststart', '-f', 'mp4', out
  ];
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 120000 }, (err) => err ? reject(err) : resolve());
  });
}

// ── throttled download (polite: caps bandwidth so browsing stays smooth) ───

function throttleStream(rateBps) {
  let bytes = 0;
  const t0 = Date.now();
  return new Transform({
    transform(chunk, enc, cb) {
      bytes += chunk.length;
      const target = t0 + (bytes / rateBps) * 1000;
      const wait = target - Date.now();
      if (wait > 2) setTimeout(() => cb(null, chunk), Math.min(wait, 30000));
      else cb(null, chunk);
    }
  });
}

// Local file: seek + cut directly (no download needed).
function buildLocal(filePath, id) {
  const out = fileFor(id);
  fs.mkdirSync(dir, { recursive: true });
  return durationSeconds(filePath).then((dur) => {
    if (!dur || dur < cfg.clipSec) throw new Error('duration too short');
    return extractClip(filePath, out, pickStart(dur)).then(() => out);
  });
}

// External source: download the resolved stream once (throttled), cut, discard.
function buildExternal(v, id) {
  const out = fileFor(id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(tmpDir, id + '.download.mp4');
  return resolveSource(v.source)
    .then((src) => {
      if (!src || src.type === 'hls' || /\.m3u8/i.test(src.url)) throw new Error('unsupported source type');
      return downloadTo(src, tmp);
    })
    .then(() => durationSeconds(tmp))
    .then((dur) => {
      if (!dur || dur < cfg.clipSec) throw new Error('duration too short');
      return extractClip(tmp, out, pickStart(dur));
    })
    .then(() => out)
    .catch((err) => {
      try { fs.unlinkSync(tmp); } catch (e) {}
      throw err;
    })
    .then((o) => { try { fs.unlinkSync(tmp); } catch (e) {} return o; });
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
      up.pipe(throttleStream(cfg.kbps * 1024)).pipe(ws);
    });
  });
}

// ── background build queue (one job at a time, polite delay between jobs) ──

const queue = [];
let running = null;          // currently-building job or null
const attempts = {};         // id → failure count
let timer = null;

function buildable(v) {
  if (!cfg.enabled || !v) return false;
  if (hasPreview(v.id)) return false;
  if ((attempts[v.id] || 0) >= MAX_ATTEMPTS) return false;
  if (v.source && (v.source.type === 'hls' || /\.m3u8/i.test(v.source.url || ''))) return false;
  if (!v.source && !(v.filePath && fs.existsSync(v.filePath))) return false;
  return true;
}

function enqueue(videos) {
  if (!cfg.enabled || !Array.isArray(videos)) return 0;
  let added = 0;
  for (const v of videos) {
    if (!buildable(v)) continue;
    if (queue.some((j) => j.id === v.id) || (running && running.id === v.id)) continue;
    queue.push({ id: v.id, v });
    added++;
  }
  pump();
  return added;
}

function pump() {
  if (running || timer) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
  console.log(`[preview] building ${job.id} (${queue.length} left in queue)`);
  const p = job.v.filePath ? buildLocal(job.v.filePath, job.id) : buildExternal(job.v, job.id);
  p.then(() => {
    known.add(job.id);
    delete attempts[job.id];
    console.log(`[preview] built ${job.id}`);
  }).catch((err) => {
    attempts[job.id] = (attempts[job.id] || 0) + 1;
    console.log(`[preview] FAILED ${job.id}: ${err.message} (attempt ${attempts[job.id]}/${MAX_ATTEMPTS})`);
  }).then(() => {
    running = null;
    timer = setTimeout(() => { timer = null; pump(); }, cfg.delayMs);
  });
}

module.exports = { init, fileFor, getDir, hasPreview, status, enqueue, buildLocal, buildExternal };
