// lib/ingest.js
// Feed system for the WPS-Transformer Player: turn a JSON array or a plain
// TXT list of URLs / <iframe> embeds into permanent library entries.
//
// Each entry keeps the PERMANENT source URL (not the signed /t/ token) so the
// transformer resolves a fresh stream at playback time — expired CDN tokens
// self-heal and the list never needs rebuilding.
'use strict';

const fs = require('fs');
const path = require('path');
const transformer = require('./transformer');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VIDEOS_PATH = path.join(DATA_DIR, 'videos.json');

// ── payload parsing ─────────────────────────────────────────────────────────

// TXT list: one entry per line. "#" = comment. Supports "Title | https://url",
// a bare URL, or a full <iframe src="..."></iframe> embed line.
function parseText(text) {
  const entries = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    if (/<iframe/i.test(s)) {
      entries.push({ url: s });
      continue;
    }
    const pipe = s.split(/\s*\|\s*/);
    if (pipe.length >= 2 && /^https?:\/\//i.test(pipe[1].trim())) {
      entries.push({ url: pipe.slice(1).join('|').trim(), title: pipe[0].trim() });
    } else {
      entries.push({ url: s });
    }
  }
  return entries;
}

function parseJson(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (data && !Array.isArray(data) && typeof data === 'object' && (data.url || data.src || data.embed) && !Array.isArray(data.videos)) {
    return [data].map(mapEntry).filter(e => e.url);
  }
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.videos) ? data.videos : null);
  if (!arr) throw new Error('JSON must be an array of objects/strings or { videos: [...] }');
  return arr.map(mapEntry).filter(e => e.url);
}

function mapEntry(it, i) {
  if (typeof it === 'string') return { url: it, _idx: i };
  if (it && typeof it === 'object') {
    return {
      url: it.url || it.src || it.embed || '',
      title: it.title || '',
      category: it.category || '',
      tags: Array.isArray(it.tags) ? it.tags.map(String) : (typeof it.tags === 'string' ? it.tags.split(',').map(t => t.trim()).filter(Boolean) : []),
      referer: it.referer || '',
      thumbnail: it.thumbnail || '',
      duration: it.duration || '',
      _idx: i
    };
  }
  return { url: '', _idx: i };
}

// Accept a JSON payload or plain TXT; returns [{url,title,category,tags,referer,thumbnail,duration}]
function parsePayload(body) {
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'object' && body !== null) return parseJson(body);
  body = String(body || '').trim();
  if (!body) return [];
  const first = body[0];
  if (first === '[' || (first === '{' && /"videos"/.test(body.slice(0, 200)))) {
    return parseJson(body);
  }
  return parseText(body);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || ('video-' + Math.floor(Math.random() * 1e6));
}

function cleanTitle(t) {
  return String(t || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Normalized key for dedupe: host + path (ignore query/tracking params).
function urlKey(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname).toLowerCase().replace(/\/+$/, '');
  } catch (e) {
    return String(url).toLowerCase();
  }
}

function fallbackTitle(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    const name = seg.replace(/\.(mp4|m3u8|html|php)$/i, '').replace(/[-_]+/g, ' ').trim();
    const title = (name || host).replace(/\b\w/g, c => c.toUpperCase());
    return title ? title.slice(0, 100) : host;
  } catch (e) {
    return 'External Video';
  }
}

function makeDescription(title) {
  const safe = title.replace(/[<>&]/g, '');
  return `<h2>${safe}</h2>\n<p>Watch <strong>${safe}</strong> free in HD — streamed via the WPS Transformer Player.</p>`;
}

// ── library access ──────────────────────────────────────────────────────────

function loadLibrary() {
  if (!fs.existsSync(VIDEOS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(VIDEOS_PATH, 'utf8')); } catch (e) { return []; }
}

function saveLibrary(videos) {
  fs.writeFileSync(VIDEOS_PATH, JSON.stringify(videos, null, 2));
}

// ── per-URL resolution ──────────────────────────────────────────────────────

// Enrich an entry with page metadata when it's a real page (embed type).
// Direct mp4/m3u8 links are NOT fetched (would stream binary bytes).
async function enrich(entry, timeoutMs) {
  const source = transformer.parseSource(entry.url);
  if (!source) return { ...entry, error: 'Invalid URL/embed' };

  const base = { url: source.url, referer: entry.referer || '', type: source.type, ua: '' };
  const out = { ...entry, source: base };

  if (source.type === 'embed' && !out.title) {
    try {
      const html = await fetchPageTextSafe(source, timeoutMs);
      const meta = html ? transformer.extractPageMeta(html, source.url) : {};
      if (meta.title) out.title = meta.title;
      if (!out.thumbnail && meta.thumbnail) out.thumbnail = meta.thumbnail;
      if (!out.duration && meta.duration) out.duration = meta.duration;
      if (!out.tags.length && meta.tags) out.tags = meta.tags;
    } catch (e) {
      // keep going — fallback title below
    }
  }
  if (!out.title) out.title = fallbackTitle(source.url);
  return out;
}

function fetchPageTextSafe(source, timeoutMs) {
  return new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), timeoutMs || 12000);
    transformer.fetchPageText(source.url, source)
      .then(html => { clearTimeout(to); resolve(html); })
      .catch(() => { clearTimeout(to); resolve(null); });
  });
}

// ── main ingest ─────────────────────────────────────────────────────────────

async function ingest(entries, opts) {
  opts = opts || {};
  const concurrency = opts.concurrency || 4;
  const library = opts.library || loadLibrary();
  const byId = new Map(library.map(v => [v.id, v]));
  const byUrl = new Map(library.map(v => {
    const k = v.source ? urlKey(v.source.url) : urlKey(v.video || '');
    return [k, v];
  }));

  const report = { total: entries.length, added: 0, skipped: 0, failed: 0, errors: [], addedVideos: [] };

  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const idx = cursor++;
      const raw = entries[idx];
      try {
        const enriched = await enrich(raw, opts.timeoutMs);
        const source = enriched.source;
        if (!source) { report.failed++; report.errors.push({ idx, url: raw.url, error: enriched.error || 'parse failed' }); continue; }

        const key = urlKey(source.url);
        if (byUrl.has(key)) { report.skipped++; continue; } // dedupe

        const title = cleanTitle(enriched.title || fallbackTitle(source.url));
        let id = slugify(title);
        while (byId.has(id)) id = slugify(title) + '-' + Math.floor(Math.random() * 1000);

        const entry = {
          id,
          title,
          source,
          video: null,
          filePath: null,
          thumbnail: enriched.thumbnail || '',
          views: 0,
          duration: enriched.duration || '',
          uploaded: new Date().toISOString(),
          category: cleanTitle(enriched.category || 'General') || 'General',
          tags: (enriched.tags || []).map(String).slice(0, 8),
          description: makeDescription(title),
          featured: false
        };
        results.push(entry);
        byId.set(id, entry);
        byUrl.set(key, entry);
        report.added++;
        report.addedVideos.push(entry);
      } catch (e) {
        report.failed++;
        report.errors.push({ idx, url: raw.url, error: e.message });
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker());
  await Promise.all(workers);

  if (results.length) {
    const merged = results.concat(library); // newest first
    saveLibrary(merged);
  }
  return report;
}

// ── import files (data/imports/*.json|*.txt) ────────────────────────────────

function scanImportsFolder(folder) {
  if (!fs.existsSync(folder)) return { files: 0, report: null };
  const files = fs.readdirSync(folder).filter(f => /\.(json|txt)$/i.test(f));
  if (!files.length) return { files: 0, report: null };
  const doneDir = path.join(folder, 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  let report;
  for (const f of files) {
    const fp = path.join(folder, f);
    try {
      const body = fs.readFileSync(fp, 'utf8');
      const entries = parsePayload(body);
      report = report || { total: 0, added: 0, skipped: 0, failed: 0, errors: [], files: [] };
      report.total += entries.length;
      const r = ingestSync(entries);
      report.added += r.added; report.skipped += r.skipped; report.failed += r.failed;
      if (r.errors && r.errors.length) report.errors.push(...r.errors);
      report.files.push({ file: f, added: r.added, skipped: r.skipped, failed: r.failed });
      fs.renameSync(fp, path.join(doneDir, f));
    } catch (e) {
      report = report || { total: 0, added: 0, skipped: 0, failed: 0, errors: [], files: [] };
      report.failed++;
      report.errors.push({ file: f, error: e.message });
      fs.renameSync(fp, path.join(doneDir, 'error-' + f));
    }
  }
  return { files: files.length, report };
}

// sync variant used by the folder scanner (files are processed sequentially)
function ingestSync(entries) {
  const library = loadLibrary();
  const report = { total: entries.length, added: 0, skipped: 0, failed: 0, errors: [] };
  const byId = new Map(library.map(v => [v.id, v]));
  const byUrl = new Map(library.map(v => {
    const k = v.source ? urlKey(v.source.url) : urlKey(v.video || '');
    return [k, v];
  }));
  for (const raw of entries) {
    const source = transformer.parseSource(raw.url);
    if (!source) { report.failed++; report.errors.push({ url: raw.url, error: 'parse failed' }); continue; }
    const key = urlKey(source.url);
    if (byUrl.has(key)) { report.skipped++; continue; }
    let title = cleanTitle(raw.title || fallbackTitle(source.url));
    let id = slugify(title);
    while (byId.has(id)) id = slugify(title) + '-' + Math.floor(Math.random() * 1000);
    const entry = {
      id, title,
      source: { url: source.url, referer: raw.referer || '', type: source.type, ua: '' },
      video: null, filePath: null,
      thumbnail: raw.thumbnail || '',
      views: 0,
      duration: raw.duration || '',
      uploaded: new Date().toISOString(),
      category: cleanTitle(raw.category || 'General') || 'General',
      tags: (raw.tags || []).map(String).slice(0, 8),
      description: makeDescription(title),
      featured: false
    };
    byId.set(id, entry); byUrl.set(key, entry);
    library.unshift(entry);
    report.added++;
  }
  saveLibrary(library);
  return report;
}

module.exports = { parsePayload, parseText, parseJson, ingest, scanImportsFolder, loadLibrary, saveLibrary, urlKey, slugify };
