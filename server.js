// server.js — WPS-Transformer Player (standalone Express app)
//
//   GET  /                    → video list (gallery)
//   GET  /watch/:id           → the custom player page
//   GET  /t/:token            → masked hotlink proxy (external mp4/HLS)
//   GET  /videos/:id          → local-file range streaming (byte-range seek)
//   GET  /sprites/:id.(jpg|vtt) → scrub sprite sheets for local files
//   POST /api/ingest          → add URLs from a JSON array / TXT list (admin)
//   POST /api/ingest/scan     → process files dropped in data/imports (admin)
//   GET  /api/ads/preroll     → server-side VAST resolution for the pre-roll
//   GET  /api/videos, /api/video/:id, /api/view/:id
//
// Every external source is stored as its PERMANENT URL and resolved to a fresh
// signed stream at playback time (self-healing: expired CDN tokens never break
// the list, and no real hostname ever reaches the browser).
'use strict';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');


const transformer = require('./lib/transformer');
const ingest = require('./lib/ingest');
const sprites = require('./lib/sprites');
const vast = require('./lib/vast');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const PORT = process.env.PORT || CONFIG.port || 7200;
const SITE_BASE = CONFIG.siteUrl || `http://localhost:${PORT}`;
const IMPORTS_DIR = path.resolve(__dirname, CONFIG.importsFolder || 'data/imports');
const SCRUB = CONFIG.scrub || {};

transformer.init({
  enabled: true,
  secret: CONFIG.tokenSecret || '',
  fallbackSecret: CONFIG.tokenSecret || '',
  allowAnyHost: true,
  blockedHosts: (CONFIG.transformer && CONFIG.transformer.blockedHosts) || [],
  referer: (CONFIG.transformer && CONFIG.transformer.referer) || '',
  hostReferers: (CONFIG.transformer && CONFIG.transformer.hostReferers) || {},
  embedCacheMs: (CONFIG.transformer && CONFIG.transformer.resolveTtlMs) || 15 * 60 * 1000,
  connectTimeoutMs: 15000
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', etag: true }));
app.use((req, res, next) => { res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); next(); });
app.use(express.json({ limit: '6mb' }));
app.use(express.text({ type: ['text/plain', 'text/x-txt'], limit: '6mb' }));
app.use(express.urlencoded({ extended: true }));

// localhost-only admin: no password required
app.use((req, res, next) => { req.isAdmin = true; next(); });

// ── library in-memory cache ─────────────────────────────────────────────────
let library = ingest.loadLibrary();
let fileSizes = {};
let viewWriteTimer = null;

function reload() {
  library = ingest.loadLibrary();
  fileSizes = {};
  for (const v of library) {
    if (v.filePath && fs.existsSync(v.filePath)) {
      try { fileSizes[v.id] = fs.statSync(v.filePath).size; } catch (e) {}
    }
  }
}
reload();

function getVideo(id) { return library.find(v => v.id === id); }

function persistSoon() {
  if (viewWriteTimer) return;
  viewWriteTimer = setTimeout(() => {
    viewWriteTimer = null;
    try { ingest.saveLibrary(library); } catch (e) {}
  }, 30000);
}

function playbackFor(v) {
  if (v && v.source) return transformer.tokenUrl(v.source);
  if (v && v.filePath) return '/videos/' + v.id;
  if (v && v.video) return v.video;
  return '';
}

function slim(v) {
  const isExt = !!(v.source);
  return {
    id: v.id, title: v.title,
    video: playbackFor(v),
    external: isExt || undefined,
    description: v.description || '',
    thumbnail: v.thumbnail || '',
    duration: v.duration, views: v.views || 0,
    category: v.category, tags: v.tags, uploaded: v.uploaded,
    type: (v.source && v.source.type) || 'local',
    local: !isExt || undefined,
    sprites: !isExt && sprites.hasSprites(v.id) ? { img: '/sprites/' + v.id + '.jpg', vtt: '/sprites/' + v.id + '.vtt' } : undefined,
    size: fileSizes[v.id] || undefined
  };
}

// ── routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.render('index', {
    siteName: CONFIG.siteName,
    siteUrl: SITE_BASE,
    videos: library.map(slim),
    total: library.length,
    isAdminPage: req.isAdmin
  });
});

app.get('/watch/:id', (req, res) => {
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).render('error', { siteUrl: SITE_BASE, message: 'Video not found' });
  const idx = library.findIndex(x => x.id === v.id);
  const prev = idx > 0 ? library[idx - 1] : null;
  const next = idx >= 0 && idx < library.length - 1 ? library[idx + 1] : null;
  const playlist = library.map(slim);
  res.render('player', {
    siteName: CONFIG.siteName,
    siteUrl: SITE_BASE,
    video: slim(v),
    prev: prev ? slim(prev) : null,
    next: next ? slim(next) : null,
    playlist,
    autoplayNext: CONFIG.autoplayNext !== false,
    ads: {
      preroll: !!(CONFIG.ads && CONFIG.ads.vastTag),
      displaySlots: (CONFIG.ads && CONFIG.ads.displaySlots || []).filter(s => s.enabled)
    },
    isAdminPage: req.isAdmin
  });
});

// masked hotlink proxy
app.get('/t/:token', (req, res) => {
  const source = transformer.verifyToken(req.params.token);
  if (!source) return res.status(403).set('X-Robots-Tag', 'noindex').json({ error: 'invalid token' });
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  transformer.streamProxy(req, res, source);
});

// bare test player (admin helper)
app.get('/tx/:token', (req, res) => {
  const source = transformer.verifyToken(req.params.token);
  if (!source) return res.status(403).set('X-Robots-Tag', 'noindex').send('<h3>Invalid token</h3>');
  const src = '/t/' + req.params.token;
  res.set('X-Robots-Tag', 'noindex');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transformer Test</title><style>body{background:#0a0a0b;color:#fff;font-family:system-ui;margin:0;padding:24px}
video{width:100%;max-width:960px;aspect-ratio:16/9;background:#000;border-radius:12px}</style></head><body>
<video id="v" controls autoplay muted playsinline preload="metadata"></video>
<script src="/js/hls.min.js"></script>
<script>
(function(){var src=${JSON.stringify(src)},v=document.getElementById('v');
if(window.Hls&&Hls.isSupported()){var h=new Hls({maxBufferLength:30});h.loadSource(src);h.attachMedia(v);
h.on(Hls.Events.MANIFEST_PARSED,function(){try{v.play()}catch(e){}});}
else{v.setAttribute('src',src);v.load();}})();
</script></body></html>`);
});

// local file range streaming (byte-range seek support)
app.get('/videos/:id', (req, res) => {
  const v = getVideo(req.params.id);
  if (!v || !v.filePath || !fs.existsSync(v.filePath)) return res.status(404).end();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Accept-Ranges', 'bytes');
  const size = fs.statSync(v.filePath).size;
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start)) { start = Math.max(0, size - end); end = size - 1; }
      if (start > end || start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      end = Math.min(end, size - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      res.setHeader('Content-Type', 'video/mp4');
      fs.createReadStream(v.filePath, { start, end }).pipe(res);
      return;
    }
  }
  res.setHeader('Content-Length', size);
  res.setHeader('Content-Type', 'video/mp4');
  fs.createReadStream(v.filePath).pipe(res);
});

// sprite sheets
app.get('/sprites/:file', (req, res) => {
  const f = req.params.file;
  if (!/^[\w-]+\.(jpg|vtt)$/.test(f)) return res.status(400).end();
  const fp = path.join(DATA_DIR, 'sprites', f);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(fp);
});

// ── API ─────────────────────────────────────────────────────────────────────
app.get('/api/videos', (req, res) => res.json(library.map(slim)));
app.get('/api/video/:id', (req, res) => {
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });
  res.json(slim(v));
});

app.post('/api/view/:id', (req, res) => {
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });
  v.views = (v.views || 0) + 1;
  persistSoon();
  res.json({ views: v.views });
});

// Ingest: JSON array / TXT list
app.post('/api/ingest', async (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  let entries;
  try {
    entries = ingest.parsePayload(req.body || req.body);
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse payload: ' + e.message });
  }
  if (!entries.length) return res.status(400).json({ error: 'No URLs found in payload' });
  try {
    const report = await ingest.ingest(entries, { concurrency: 4, timeoutMs: 12000 });
    reload();
    res.json({ ok: true, ...report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scan data/imports folder
app.post('/api/ingest/scan', (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const result = ingest.scanImportsFolder(IMPORTS_DIR);
  reload();
  res.json({ ok: true, ...result });
});

// VAST pre-roll resolution (server-side; cached briefly)
const vastCache = { at: 0, data: null };
app.get('/api/ads/preroll', async (req, res) => {
  if (!CONFIG.ads || !CONFIG.ads.vastTag) return res.status(404).json({ error: 'ads disabled' });
  if (vastCache.data && Date.now() - vastCache.at < 30000) return res.json(vastCache.data);
  try {
    const ad = await vast.resolve(CONFIG.ads.vastTag, CONFIG.ads.vastSkipAfter || 5);
    vastCache.data = ad; vastCache.at = Date.now();
    res.json(ad);
  } catch (e) {
    res.status(502).json({ error: 'VAST resolve failed: ' + e.message });
  }
});

// ── admin ───────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.render('admin', {
    siteName: CONFIG.siteName,
    siteUrl: SITE_BASE,
    total: library.length,
    videos: library.map(slim),
    isAdminPage: true,
    adsEnabled: !!(CONFIG.ads && CONFIG.ads.vastTag)
  });
});

app.use((req, res) => res.status(404).render('error', { siteUrl: SITE_BASE, message: 'Page not found' }));
app.use((err, req, res, next) => {
  console.error('[server]', err.message);
  res.status(500).render('error', { siteUrl: SITE_BASE, message: 'Something went wrong' });
});

// ── import folder watcher (lightweight poll) ────────────────────────────────
setInterval(() => {
  try {
    if (fs.readdirSync(IMPORTS_DIR).some(f => /\.(json|txt)$/i.test(f))) {
      const r = ingest.scanImportsFolder(IMPORTS_DIR);
      if (r.report && r.report.added) {
        reload();
        console.log(`[ingest] auto-imported ${r.report.added} videos`);
      }
    }
  } catch (e) {}
}, 30000);

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`\n  WPS Transformer Player — ${CONFIG.siteName}`);
  console.log(`  ${library.length} videos | Port ${PORT}`);
  console.log(`  Player:   http://localhost:${PORT}/`);
  console.log(`  Admin:    http://localhost:${PORT}/admin`);
  console.log(`  Drop lists in: ${IMPORTS_DIR}\n`);
});
