// lib/stats.js
// Rolling operational stats for the admin panel: request volume by route,
// status mix, bandwidth, live viewers, cache/library coverage, disk usage,
// and per-host origin health. Request counters live in a fixed-size minute
// window, so nothing grows unbounded.
'use strict';

const fs = require('fs');
const path = require('path');
const transformer = require('./transformer');
const preview = require('./preview');
const thumb = require('./thumb');

const WINDOW_MIN = 60;
const buckets = []; // minute slot → { req, bytes, statuses, routes }
let inFlight = 0;
let peakInFlight = 0;

function minuteIdx() { return Math.floor(Date.now() / 60000) % WINDOW_MIN; }

function currentBucket() {
  const idx = minuteIdx();
  if (!buckets[idx]) buckets[idx] = { req: 0, bytes: 0, statuses: { 2: 0, 3: 0, 4: 0, 5: 0 }, routes: {} };
  return buckets[idx];
}

function routeFor(p) {
  if (p === '/' || p === '') return '/';
  const seg = String(p).split('/')[1] || '';
  return /^[\w.-]+$/.test(seg) ? '/' + seg : '/static';
}

// Express middleware: count each request once, when the response completes.
function middleware(req, res, next) {
  inFlight++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
  let counted = false;
  const onDone = () => {
    if (counted) return;
    counted = true;
    inFlight--;
    const b = currentBucket();
    b.req++;
    const route = routeFor(req.path || req.url);
    b.routes[route] = (b.routes[route] || 0) + 1;
    const cls = Math.floor((res.statusCode || 0) / 100);
    b.statuses[cls] = (b.statuses[cls] || 0) + 1;
    const cl = Number(res.get('Content-Length') || 0);
    if (isFinite(cl) && cl > 0) b.bytes += cl;
  };
  res.on('finish', onDone);
  res.on('close', onDone);
  next();
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      let st;
      try { st = fs.statSync(fp); } catch (e) { continue; }
      if (st.isDirectory()) total += dirSize(fp);
      else total += st.size;
    }
  } catch (e) {}
  return total;
}

// One-time aggregation of the rolling window.
function windowSummary() {
  const w = { req: 0, bytes: 0, statuses: { 2: 0, 3: 0, 4: 0, 5: 0 }, routes: {} };
  for (let i = 0; i < WINDOW_MIN; i++) {
    const b = buckets[(minuteIdx() - i + WINDOW_MIN * 2) % WINDOW_MIN];
    if (!b) continue;
    w.req += b.req;
    w.bytes += b.bytes;
    for (const k of Object.keys(b.statuses)) w.statuses[k] += b.statuses[k];
    for (const r of Object.keys(b.routes)) w.routes[r] = (w.routes[r] || 0) + b.routes[r];
  }
  return w;
}

// Full snapshot for /api/stats. `failedMap` is the server's preview-build
// failure map (id → reason) used to flag broken external sources.
function snapshot(library, failedMap, dataDir) {
  const lib = { total: library.length, external: 0, local: 0, hls: 0, thumbed: 0, thumbCached: 0, previewCached: 0, broken: 0 };
  for (const v of library) {
    if (v.source) {
      lib.external++;
      if (v.source.type === 'hls') lib.hls++;
    } else if (v.filePath) {
      lib.local++;
    }
    if (v.thumbnail) {
      lib.thumbed++;
      if (thumb.fileFor(v.id)) lib.thumbCached++;
    }
    if (preview.hasPreview(v.id)) lib.previewCached++;
    const reason = failedMap && failedMap.get(v.id);
    if (v.source && reason && !/unsupported/i.test(reason)) lib.broken++;
  }

  const w = windowSummary();
  return {
    at: Date.now(),
    live: { inFlight, peakInFlight },
    window: {
      req: w.req,
      reqPerMin: w.req / WINDOW_MIN,
      bytes: w.bytes,
      statuses: w.statuses,
      routes: w.routes
    },
    library: Object.assign(lib, {
      thumbPct: lib.thumbed ? Math.round(100 * lib.thumbCached / lib.thumbed) : 0,
      previewPct: lib.total ? Math.round(100 * lib.previewCached / lib.total) : 0
    }),
    disk: {
      thumbs: dirSize(thumb.getDir()),
      previews: dirSize(preview.getDir()),
      sprites: dirSize(path.join(dataDir, 'sprites'))
    },
    origin: transformer.hostHealth()
  };
}

module.exports = { middleware, snapshot };
