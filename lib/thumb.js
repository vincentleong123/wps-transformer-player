// lib/thumb.js
// Cached thumbnail store: download each origin image once (through the
// transformer's cookie/throttle layer), then serve from disk forever so the
// gallery never hits the origin while scrolling.
'use strict';

const fs = require('fs');
const path = require('path');
const transformer = require('./transformer');

const THUMB_EXT_RE = /\.(jpg|jpeg|png|webp|gif|avif)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

let dir = path.join(__dirname, '..', 'data', 'thumbs');
const exts = new Map(); // video id → cached file extension

function init(cfg) {
  dir = path.resolve(__dirname, '..', (cfg && cfg.thumbnailDir) || 'data/thumbs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  exts.clear();
  try {
    for (const f of fs.readdirSync(dir)) {
      const ext = path.extname(f).toLowerCase();
      if (THUMB_EXT_RE.test(ext)) exts.set(path.basename(f, ext), ext);
    }
  } catch (e) {}
}

function fileFor(id) {
  const ext = exts.get(id);
  return ext ? path.join(dir, id + ext) : null;
}

function getDir() {
  return dir;
}

function extFrom(ct) {
  const m = String(ct || '').toLowerCase().match(/image\/(jpeg|png|webp|gif|avif)/);
  return m ? ({ jpeg: '.jpg' }[m[1]] || '.' + m[1]) : null;
}

function extFromUrl(url) {
  try {
    const e = path.extname(new URL(url).pathname).toLowerCase();
    return THUMB_EXT_RE.test(e) ? e : null;
  } catch (e) { return null; }
}

// Serve the cached file, or download the origin image once and cache it.
async function serve(v, res) {
  const cached = fileFor(v.id);
  if (cached && fs.existsSync(cached)) return res.sendFile(cached);

  let up;
  try {
    up = await transformer.fetchImage({ url: v.thumbnail, referer: '', type: 'direct' });
  } catch (e) {
    return res.status(502).end();
  }
  if (up.statusCode < 200 || up.statusCode >= 300) { up.resume(); return res.status(502).end(); }

  const chunks = [];
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      up.on('data', c => { size += c.length; if (size > MAX_BYTES) up.destroy(); chunks.push(c); });
      up.on('end', resolve);
      up.on('error', reject);
    });
  } catch (e) {
    return res.status(502).end();
  }

  const buf = Buffer.concat(chunks);
  const ct = String(up.headers['content-type'] || '').split(';')[0];
  const ext = extFrom(ct) || extFromUrl(v.thumbnail) || '.jpg';
  const fp = path.join(dir, v.id + ext);
  try {
    fs.writeFileSync(fp, buf);
    exts.set(v.id, ext);
  } catch (e) {}

  res.set('Content-Type', ct || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.send(buf);
}

module.exports = { init, fileFor, getDir, serve };
