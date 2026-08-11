// utils/transformer.js
// WPS-style Transformer for Super X Hentai — turns external tube-site video
// URLs / iframe embeds into masked, own-domain playback endpoints.
//
// Flow for a "source" (external URL):
//   1. Admin feeds the raw source (mp4 link or <iframe> embed) → parseSource()
//   2. The source is signed into an opaque token → /t/<token>
//   3. The browser never sees the real host. /t/<token> resolves the source,
//      follows redirects, spoofs headers, and relays the byte stream with
//      Range passthrough (seek works) and proper media headers.
//
// Why proxy instead of just redirect? Sources like 1porn.tv return an
// IP-bound, expiring signed CDN URL (fpvcdn). Relaying through the server
// keeps the visitor IP out of it and the origin fully masked.
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

let CONFIG = {
  enabled: true,
  secret: null,            // falls back to config.tokenSecret
  allowAnyHost: true,      // any http(s) host allowed (tokens are signed)
  blockedHosts: [],        // always-blocked host suffixes (e.g. 'somesite.com')
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  referer: '',             // default Referer sent to sources
  hostReferers: {},        // per-host Referer overrides: { '1porn.tv': 'https://www.1porn.tv/' }
  embedCacheMs: 15 * 60 * 1000,  // how long a resolved embed → stream mapping is cached
  connectTimeoutMs: 15000,
  maxRedirects: 5
};

// In-memory cache for embed resolution (embed page URL → resolved stream).
// Keeps us from re-fetching heavy SPA embed pages on every segment request.
const embedCache = new Map();
function cacheGet(key) { const e = embedCache.get(key); if (!e) return null; if (Date.now() - e.at > CONFIG.embedCacheMs) { embedCache.delete(key); return null; } return e.val; }
function cacheSet(key, val) { embedCache.set(key, { at: Date.now(), val }); }

// ── anti-bot / politeness layer ────────────────────────────────────────────
// Kernel Team backends (KTube: xmateur.com, etc.) sit behind Cloudflare and
// issue PHPSESSID + kt_qparams cookies. To avoid being flagged/rate-limited:
//   • persist every Set-Cookie per host and replay it on later requests
//   • carry a browser-like header set (Referer, Sec-Fetch-*, Accept-Language)
//   • keep a per-host minimum gap between requests + a global concurrency cap
//   • resolve the real stream from the inline JS config (flashvars), never
//     iframes, and cache it so we don't re-fetch pages on every play
const cookieJar = new Map();                 // host → Map(name → value)
const lastHit = new Map();                   // host → last request timestamp
const hostStats = new Map();                 // host → { requests, errors, blocked, lastStatus, lastAt }
const GAP = { page: 1600, preflight: 900, media: 140, image: 400 };   // ms per host
const MAX_CONCURRENT = 6;
let active = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function recordHost(host, ok, status) {
  const s = hostStats.get(host) || { requests: 0, errors: 0, blocked: 0, lastStatus: 0, lastAt: 0 };
  s.requests++;
  s.lastStatus = status || 0;
  s.lastAt = Date.now();
  if (!ok) {
    s.errors++;
    if (status === 403 || status === 429 || status === 503) s.blocked++;
  }
  hostStats.set(host, s);
}

// Per-host origin health for the admin panel (sorted by error count).
function hostHealth() {
  return Array.from(hostStats.entries())
    .map(([host, s]) => Object.assign({ host }, s))
    .sort((a, b) => b.errors - a.errors);
}

function storeCookies(host, setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return;
  const jar = cookieJar.get(host) || new Map();
  for (const sc of setCookieHeaders) {
    const pair = String(sc).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  cookieJar.set(host, jar);
}

function cookieHeaderFor(host) {
  const jar = cookieJar.get(host);
  if (!jar || !jar.size) return '';
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function throttle(host, kind) {
  const gap = GAP[kind] || 0;
  for (;;) {
    const now = Date.now();
    const prev = lastHit.get(host) || 0;
    const wait = Math.max(0, gap - (now - prev));
    if (active < MAX_CONCURRENT && wait === 0) break;
    await sleep(Math.max(wait, 25));
  }
  active++;
  lastHit.set(host, Date.now());
  return () => { active--; };
}

function init(cfg) {
  CONFIG = Object.assign({}, CONFIG, cfg || {});
}

// ── URL safety (no SSRF: http/https only, no private/loopback targets) ──
const PRIVATE_HOST = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1$|fe80:)/;

function isSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost') return false;
  if (PRIVATE_HOST.test(host)) return false;
  return true;
}

function hostAllowed(raw) {
  if (!isSafeUrl(raw)) return false;
  let host;
  try { host = new URL(raw).hostname.toLowerCase(); } catch (e) { return false; }
  if (CONFIG.blockedHosts.some(b => host === b || host.endsWith('.' + b.replace(/^\./, '')))) return false;
  if (CONFIG.allowAnyHost) return true;
  return true;
}

// ── Input parsing: URL | <iframe> embed code | {url,referer,type} ──
function parseSource(input) {
  if (!input) return null;
  if (typeof input === 'object' && !Array.isArray(input)) {
    const url = input.url || input.src || '';
    if (!isSafeUrl(url)) return null;
    return {
      url: url.trim(),
      referer: input.referer || input.ref || '',
      type: input.type || 'direct',
      ua: input.ua || ''
    };
  }
  let s = String(input).trim();
  if (!s) return null;
  // iframe embed code → pull the src attribute (handle single/double quotes)
  if (/<iframe/i.test(s)) {
    const m = s.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!m) return null;
    s = m[1];
  }
  if (!isSafeUrl(s)) return null;
  const type = /\.m3u8(\?|$|#)/i.test(s) ? 'hls' : (/\.mp4(\?|$|#|\/)/i.test(s) ? 'direct' : 'embed');
  return { url: s, referer: '', type, ua: '' };
}

// ── Signing: AES-256-GCM so the real source never appears in page HTML ──
function _secret() {
  return CONFIG.secret || CONFIG.fallbackSecret || '';
}

function _encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(_secret()).digest();
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function _decrypt(token) {
  const buf = Buffer.from(String(token || ''), 'base64url');
  if (buf.length < 28) return null;
  const key = crypto.createHash('sha256').update(_secret()).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  try {
    return d.update(buf.subarray(28), null, 'utf8') + d.final('utf8');
  } catch (e) { return null; }
}

function signSource(source) {
  const s = parseSource(source) || source;
  if (!s || !isSafeUrl(s.url) || !_secret()) return null;
  const payload = JSON.stringify({ u: s.url, r: s.referer || '', t: s.type || '', a: s.ua || '' });
  return _encrypt(payload);
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const plain = _decrypt(token);
  if (!plain) return null;
  let obj;
  try { obj = JSON.parse(plain); } catch (e) { return null; }
  if (!obj || !isSafeUrl(obj.u)) return null;
  return { url: obj.u, referer: obj.r || '', type: obj.t || 'direct', ua: obj.a || '' };
}

function tokenUrl(source) {
  const tok = signSource(source);
  return tok ? '/t/' + tok : null;
}

// ── Embed resolution: page URL / <iframe> src → real stream URL ──
// Many sites (xhamster, etc.) hide the actual m3u8/mp4 behind a Vue/React SPA
// embed page, or expose it only on the canonical video page. We fetch the page,
// scrape candidate stream URLs, and if none, follow the canonical/share link.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function extractStreamUrls(html) {
  const out = { m3u8: [], mp4: [] };
  const push = (bucket, url) => { if (!out[bucket].includes(url)) out[bucket].push(url); };

  // ── Kernel Team (KTube) flashvars quality ladder ─────────────────────────
  // Sites running KTube (xmateur.com, etc.) declare the playable sources in
  // an inline JS block: video_url (base), video_alt_url (720p), ...2 (1080p),
  // ...3 (4K). Prefer the highest quality; the URL includes the /?v-acctoken=
  // signed param that must be preserved verbatim (it gates the CDN redirect).
  let ladderFound = false;
  const flashvarsBlock = (html.match(/var\s+flashvars\s*=\s*\{[\s\S]{0,20000}?\}/i) || [null])[0];
  if (flashvarsBlock) {
    const urlVar = (name) => {
      const m = flashvarsBlock.match(new RegExp('\\b' + name + '\\s*:\\s*[\'"](' + 'https?://[^\'"]+' + ')', 'i'));
      return m ? decodeEntities(m[1]).trim() : null;
    };
    const ladder = [
      urlVar('video_alt_url3'), // 4K
      urlVar('video_alt_url2'), // 1080p
      urlVar('video_alt_url'),  // 720p
      urlVar('video_url')       // base
    ].filter(Boolean);
    for (const u of ladder) {
      ladderFound = true;
      if (/\.m3u8(\/?[\?#]|$)/i.test(u)) push('m3u8', u);
      else if (/\.mp4(\/?[\?#]|$)/i.test(u)) push('mp4', u);
    }
  }

  // ── Generic fallback: full URL scan (only when KTube ladder is absent) ───
  let m;
  if (!ladderFound) {
    const m3u8Re = /https?:\/\/[^\s"'<>()]+?\.m3u8(?:[^\s"'<>()]*)?/gi;
    while ((m = m3u8Re.exec(html))) {
      const url = decodeEntities(m[0]).trim();
      if (!url || isImageAsset(url)) continue;
      if (url.includes('static-') && !url.includes('video-')) continue;
      push('m3u8', url);
    }
    const mp4Re = /https?:\/\/[^\s"'<>()]+?\.mp4(?:[^\s"'<>()]*)?/gi;
    while ((m = mp4Re.exec(html))) {
      const url = decodeEntities(m[0]).trim();
      if (!url || isImageAsset(url)) continue;
      if (url.includes('static-') && !url.includes('video-')) continue;
      if (/\/videos_screenshots\//i.test(url) || /preview(_preview)?\.mp4(\/|$|\?)/i.test(url)) continue;
      push('mp4', url);
    }
    // Rank get_file / CDN-hosted streams above ad/tracking sample URLs.
    const prefer = (a, b) => score(a) - score(b);
    out.mp4.sort(prefer);
    out.m3u8.sort(prefer);
  }
  return out;
}

function isImageAsset(url) {
  return /\.(jpg|jpeg|png|webp|gif|avif)(\?|#|$)/i.test(url);
}

// Lower is better: real video endpoints beat ambiguous/deco sites.
function score(url) {
  let s = 0;
  if (/\/(get_file|getvideo|dl|download|files|video|media|stream)\//i.test(url)) s -= 10;
  if (/\.(mp4|m3u8)(\?|$)/i.test(url)) s -= 3;
  if (/[?&]v-acctoken=/i.test(url)) s -= 2;
  if (/ads|track|beacon|analytics|screenshot|preview/i.test(url)) s += 20;
  if (/\.php\?/i.test(url) && !/remote_control/i.test(url)) s += 5;
  return s;
}

// Extract page metadata for ingest: og:title/<title>, og:image, duration,
// og:video tags/keywords. Returns {} when nothing is found.
function extractPageMeta(html, baseUrl) {
  const meta = (prop, attr) => {
    const m = html.match(new RegExp('<meta\\s+property=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)["\']', 'i'));
    return m && m[1] ? decodeEntities(m[1]).trim() : null;
  };
  const name = (n) => {
    const m = html.match(new RegExp('<meta\\s+name=["\']' + n + '["\'][^>]*content=["\']([^"\']+)["\']', 'i'));
    return m && m[1] ? decodeEntities(m[1]).trim() : null;
  };
  let title = meta('og:title') || name('twitter:title');
  if (!title) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t && t[1]) title = decodeEntities(t[1].replace(/\s+/g, ' ').trim());
  }
  if (title) title = title.replace(/\s*[|–—-].*$/i, '').trim().slice(0, 120);
  const thumb = meta('og:image') || meta('twitter:image') || meta('og:image:secure_url');
  let duration = meta('og:video:duration') || name('duration');
  if (duration) {
    const ds = String(duration).toLowerCase();
    const secs = ds.indexOf('t') >= 0
      ? parseInt((ds.match(/t(\d+)/) || [])[1], 10)
      : /^\d+$/.test(ds) ? parseInt(ds, 10) : NaN;
    if (!isNaN(secs) && secs > 0) {
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60);
      duration = `${m}:${String(s).padStart(2, '0')}`;
    } else {
      duration = null;
    }
  }
  const tags = [];
  const tagRe = /<meta\s+property=["']og:video:tag["'][^>]*content=["']([^"']+)["']/gi;
  let tagM;
  while ((tagM = tagRe.exec(html))) tags.push(decodeEntities(tagM[1]).trim());
  const out = {};
  if (title) out.title = title;
  if (thumb) { try { out.thumbnail = new URL(thumb, baseUrl).href; } catch (e) {} }
  if (duration) out.duration = duration;
  if (tags.length) out.tags = tags.slice(0, 8);
  return out;
}

function extractFollowUrl(html, baseUrl) {
  // canonical link / og:url / xhamster-style shareLink inside window.initials
  const patterns = [
    /<link\s+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
    /<meta\s+property=["']og:url["'][^>]*content=["']([^"']+)["']/i,
    /"shareLink"\s*:\s*"([^"]+)"/i
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) {
      try {
        const u = new URL(decodeEntities(m[1]), baseUrl).href;
        if (u !== baseUrl) return u;
      } catch (e) {}
    }
  }
  return null;
}

async function fetchPageText(url, source) {
  const headers = _buildHeaders(source, { 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' });
  const res = await fetchRedirects(source, 'GET', headers, 'page');
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error('embed page status ' + res.statusCode);
  }
  const chunks = [];
  let size = 0;
  return new Promise((resolve, reject) => {
    res.on('data', c => {
      size += c.length;
      if (size > 3 * 1024 * 1024) { res.destroy(); reject(new Error('embed page too large')); return; }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

// ── Image fetch (thumbnails/posters) through the same politeness layer ──
// Downloads the origin image once (cookie-aware, throttled, Referer-spoofed)
// so the CDN never sees a browser IP for thumbnails.
function fetchImage(source) {
  const headers = _buildHeaders(source, { 'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' });
  return fetchRedirects(source, 'GET', headers, 'image');
}

// ── Media fetch (full stream, for preview-clip extraction) ──────────────
// Returns the throttled, cookie-aware upstream response so the caller can
// download the body once (buffered or piped) through the same politeness
// layer that protects the /t/ proxy.
function fetchStream(source) {
  const headers = _buildHeaders(source, { 'Accept': 'video/mp4,video/webm,video/*;q=0.9,*/*;q=0.8' });
  return fetchRedirects(source, 'GET', headers, 'media');
}

// Resolve an "embed"-type source (page/iframe URL) into a direct stream source.
// Follows at most `maxHops` canonical links (SPA embeds → real video page).
async function resolveEmbed(source, maxHops = 3) {
  let current = source;
  const seen = new Set();
  for (let hop = 0; hop < maxHops; hop++) {
    if (seen.has(current.url)) return null;
    seen.add(current.url);
    const cached = cacheGet(current.url);
    if (cached) return cached;
    let html;
    try {
      html = await fetchPageText(current, { url: current.url, referer: current.referer, ua: current.ua });
    } catch (e) {
      return null;
    }
    const urls = extractStreamUrls(html);
    let picked = null;
    if (urls.m3u8.length) picked = urls.m3u8[0];
    else if (urls.mp4.length) picked = urls.mp4[0];
    if (picked) {
      const resolved = {
        url: picked,
        referer: current.referer || new URL(current.url).origin + '/',
        type: picked.endsWith('.m3u8') ? 'hls' : 'direct',
        ua: current.ua,
        from: current.url
      };
      cacheSet(current.url, resolved);
      return resolved;
    }
    const next = extractFollowUrl(html, current.url);
    if (!next) return null;
    current = { url: next, referer: current.referer || new URL(next).origin + '/', type: 'embed', ua: current.ua };
  }
  return null;
}

// ── HLS playlist rewriting: every variant/segment goes through /t/ tokens ──
function tokenizeUri(absUrl, referer, ua, isHls) {
  const tok = signSource({ url: absUrl, referer, type: isHls ? 'hls' : 'direct', ua });
  return tok ? '/t/' + tok : absUrl;
}

function rewritePlaylist(text, baseUrl, source) {
  const lines = text.split(/\r?\n/);
  const ref = source.referer;
  const ua = source.ua;
  return lines.map(line => {
    if (/^#/.test(line.trim())) {
      // Rewrite URI="..." attributes (EXT-X-KEY, EXT-X-MAP, EXT-X-SESSION-KEY...)
      const attrMatch = line.match(/URI=["']([^"']+)["']/i);
      if (attrMatch && attrMatch[1]) {
        let abs;
        try { abs = new URL(attrMatch[1], baseUrl).href; } catch (e) { return line; }
        const isHls = /\.m3u8/i.test(abs);
        return line.replace(attrMatch[0], 'URI="' + tokenizeUri(abs, ref, ua, isHls) + '"');
      }
      return line;
    }
    const t = line.trim();
    if (!t) return line;
    let abs;
    try { abs = new URL(t, baseUrl).href; } catch (e) { return line; }
    const isHls = /\.m3u8/i.test(abs);
    return tokenizeUri(abs, ref, ua, isHls);
  }).join('\n');
}

async function streamHls(req, res, source) {
  const headers = _buildHeaders(source, { 'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,*/*;q=0.9' });
  try {
    const up = await fetchRedirects(source, 'GET', headers, 'media');
    if (up.statusCode < 200 || up.statusCode >= 300) {
      up.resume();
      return res.status(up.statusCode).set('X-Robots-Tag', 'noindex').end('upstream ' + up.statusCode);
    }
    const chunks = [];
    let size = 0;
    up.on('data', c => { size += c.length; if (size > 4 * 1024 * 1024) up.destroy(); chunks.push(c); });
    const done = new Promise((resolve, reject) => {
      up.on('end', resolve);
      up.on('error', reject);
    });
    await done;
    const body = Buffer.concat(chunks).toString('utf8');
    const rewritten = rewritePlaylist(body, up._upstreamUrl || source.url, source);
    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    });
    res.send(rewritten);
  } catch (e) {
    console.error('[transformer] hls error:', e.message);
    if (!res.headersSent) return res.status(502).set('X-Robots-Tag', 'noindex').json({ error: 'hls source unreachable' });
    res.destroy();
  }
}

// ── Low-level HTTP with manual redirect following ──
async function _requestOnce(u, method, headers, kind) {
  const release = await throttle(u.hostname, kind);
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers, timeout: CONFIG.connectTimeoutMs }, res => {
      res._upstreamUrl = u.href;
      storeCookies(u.hostname, res.headers['set-cookie']);
      recordHost(u.hostname, res.statusCode >= 200 && res.statusCode < 400, res.statusCode);
      release();
      resolve(res);
    });
    req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
    req.on('error', err => { recordHost(u.hostname, false, 0); release(); reject(err); });
    req.end();
  });
}

function _buildHeaders(source, extra) {
  const u = new URL(source.url);
  const ref = source.referer || CONFIG.hostReferers[u.hostname] || CONFIG.referer || '';
  const base = extra || {};
  const isPage = /text\/html|application\/xhtml/i.test(base['Accept'] || '');
  const headers = Object.assign({}, base, {
    'User-Agent': source.ua || CONFIG.userAgent,
    'Accept': base['Accept'] || (isPage ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
                                     : 'video/mp4,video/*;q=0.9,*/*;q=0.8'),
    'Accept-Language': 'en-US,en;q=0.9,ms;q=0.8',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Site': isPage ? 'same-origin' : 'cross-site',
    'Sec-Fetch-Mode': isPage ? 'navigate' : 'no-cors',
    'Sec-Fetch-Dest': isPage ? 'document' : 'video',
    'Sec-Fetch-User': isPage ? '?1' : undefined
  });
  if (headers['Sec-Fetch-User'] === undefined) delete headers['Sec-Fetch-User'];
  const ck = cookieHeaderFor(u.hostname);
  if (ck) headers['Cookie'] = ck;
  if (ref) headers['Referer'] = ref;
  return headers;
}

async function fetchRedirects(source, method, headers, kind) {
  let u = new URL(source.url);
  let res = await _requestOnce(u, method, headers, kind);
  let hops = 0;
  while (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    if (hops++ >= CONFIG.maxRedirects) { res.destroy(); throw new Error('too many redirects'); }
    res.resume(); // drain (avoid leaking the socket)
    res.on('end', () => {});
    u = new URL(res.headers.location, u);
    res = await _requestOnce(u, method, headers, kind);
  }
  return res;
}

// ── Preflight: HEAD-ish probe to learn type/size for the admin panel ──
async function preflight(source, timeoutMs) {
  const probe = async (src) => {
    return new Promise(resolve => {
      const to = setTimeout(() => resolve({ ok: false, error: 'preflight timeout' }), timeoutMs || 20000);
      const headers = _buildHeaders(src, { 'Range': 'bytes=0-0' });
      fetchRedirects(src, 'GET', headers, 'preflight')
        .then(up => {
          const ct = String(up.headers['content-type'] || '').toLowerCase();
          const cr = up.headers['content-range'] || '';
          const m = cr.match(/\/\s*(\d+)/);
          const result = {
            ok: up.statusCode >= 200 && up.statusCode < 300,
            status: up.statusCode,
            type: ct.split(';')[0],
            contentType: ct,
            length: m ? Number(m[1]) : (up.headers['content-length'] ? Number(up.headers['content-length']) : undefined),
            finalUrl: up._upstreamUrl,
            range: up.statusCode === 206
          };
          up.resume();
          up.on('end', () => { clearTimeout(to); resolve(result); });
          up.on('error', () => { clearTimeout(to); resolve(result); });
        })
        .catch(err => { clearTimeout(to); resolve({ ok: false, error: err.message }); });
    });
  };
  let src = source;
  if (src.type === 'embed') {
    const resolved = await resolveEmbed(src);
    if (!resolved) return { ok: false, error: 'could not resolve embed source', source: null };
    const info = await probe(resolved);
    return Object.assign(info, { source: resolved });
  }
  if (src.type === 'hls') {
    return { ok: true, status: 200, type: 'application/vnd.apple.mpegurl', contentType: 'application/vnd.apple.mpegurl', hls: true, source };
  }
  return probe(src);
}

// ── Streaming proxy: the heart of the Transformer ──
async function streamProxy(req, res, source) {
  let src = source;
  if (src.type === 'embed') {
    const resolved = await resolveEmbed(src);
    if (!resolved) return res.status(502).set('X-Robots-Tag', 'noindex').json({ error: 'could not resolve embed source' });
    src = resolved;
  }
  if (src.type === 'hls' || /\.m3u8/i.test(src.url)) {
    return streamHls(req, res, src);
  }
  const range = req.headers.range || '';
  const headers = _buildHeaders(src, range ? { 'Range': range } : {});
  fetchRedirects(src, 'GET', headers, 'media')
    .then(up => {
      if (up.statusCode === 301 || up.statusCode === 302 || up.statusCode === 303 ||
          up.statusCode === 307 || up.statusCode === 308) {
        up.resume();
        return res.status(502).end('bad upstream redirect');
      }
      const out = {
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      };
      ['content-type', 'content-length', 'content-range', 'content-disposition',
       'etag', 'last-modified', 'content-md5'].forEach(h => {
        if (up.headers[h]) out[h] = up.headers[h];
      });
      res.writeHead(up.statusCode, out);
      up.on('error', () => { if (!res.writableEnded) res.destroy(); });
      req.on('close', () => { up.destroy(); });
      up.pipe(res);
    })
    .catch(err => {
      console.error('[transformer] proxy error:', err.message);
      if (!res.headersSent) return res.status(502).json({ error: 'source unreachable' });
      res.destroy();
    });
}

module.exports = { init, isSafeUrl, hostAllowed, parseSource, signSource, verifyToken, tokenUrl, preflight, streamProxy, resolveEmbed, rewritePlaylist, tokenizeUri, extractPageMeta, fetchPageText, fetchImage, fetchStream, hostHealth };
