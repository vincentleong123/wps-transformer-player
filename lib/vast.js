// lib/vast.js
// Server-side VAST resolver: fetches the configured VAST tag (magsrv etc.),
// follows <VASTAdTagURI> wrapper chains, and returns the first linear
// mp4/m3u8 media file plus tracking pixels. Running this on the server avoids
// browser CORS problems and keeps the real ad CDN URL masked (optionally
// routed through the /t/ transformer).
'use strict';

const http = require('http');
const https = require('https');
const transformer = require('./transformer');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const MAX_HOPS = 3;
const MAX_BYTES = 1024 * 1024;

function fetchXml(url) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad vast url')); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity' },
      timeout: 15000
    }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error('vast status ' + res.statusCode)); }
      const chunks = [];
      let size = 0;
      res.on('data', c => { size += c.length; if (size <= MAX_BYTES) chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('vast timeout')));
    req.on('error', reject);
    req.end();
  });
}

function tag(t) { return t ? t.trim() : ''; }

// Walk one VAST document. Returns { media, impressions, ... } or null if a
// wrapper (redirect) should be followed.
function parseVast(xml, baseUrl) {
  const doc = { media: [], impressions: [], error: [], creatives: [] };
  // media files
  const mediaRe = /<MediaFile[^>]*>([\s\S]*?)<\/MediaFile>/g;
  let m;
  while ((m = mediaRe.exec(xml))) {
    const inner = tag(m[1]);
    if (/^data:/i.test(inner) || !inner) continue;
    const type = (m[0].match(/type=["']([^"']+)["']/) || [])[1] || '';
    const isHls = type.indexOf('mpegurl') >= 0 || /\.m3u8/i.test(inner);
    doc.media.push({ url: inner, type, hls: isHls });
  }
  const imp = xml.match(/<Impression[^>]*>([\s\S]*?)<\/Impression>/gi) || [];
  doc.impressions = imp.map(i => tag((i.match(/>([^<]+)<\/Impression>/i) || [])[1])).filter(Boolean);
  const err = xml.match(/<Error[^>]*>([\s\S]*?)<\/Error>/i);
  if (err) doc.error = [tag(err[1])];

  const wrapper = xml.match(/<Wrapper>([\s\S]*?)<\/Wrapper>/i);
  if (wrapper) {
    const uri = (wrapper[1].match(/<VASTAdTagURI[^>]*>([\s\S]*?)<\/VASTAdTagURI>/i) || [])[1];
    if (uri) return { follow: tag(uri) };
  }
  return doc;
}

function resolveUrl(raw, base) {
  try { return new URL(raw, base).href; } catch (e) { return raw; }
}

// Resolve the ad from the configured tag.
// returns { url, hls, duration, skipAfter, impressions, error, complete, skip }
async function resolve(tagUrl, skipAfter) {
  let url = tagUrl;
  let base = tagUrl;
  const impressions = [];
  const errors = [];
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const xml = await fetchXml(url);
    const doc = parseVast(xml, base);
    if (doc.impressions) impressions.push(...doc.impressions);
    if (doc.error && doc.error.length) errors.push(...doc.error);
    if (doc.follow) { url = resolveUrl(doc.follow, base); base = url; continue; }
    if (!doc.media.length) break;

    const pick = doc.media.find(x => x.hls) || doc.media[0];
    // If media URL is on an external CDN, mask it through /t/ so the origin is hidden.
    let masked = pick.url;
    if (/^https?:\/\//i.test(pick.url)) {
      const src = transformer.parseSource(pick.url);
      const tok = transformer.signSource(src);
      if (tok) masked = '/t/' + tok;
    }
    let duration = (xml.match(/<Duration>([\s\S]*?)<\/Duration>/i) || [])[1];
    duration = parseDuration(duration);
    // skipoffset attribute (e.g. "00:00:05" or "5")
    let skipOffset = null;
    const sk = xml.match(/<Linear[^>]*skipoffset=["']([^"']+)["']/i);
    if (sk) skipOffset = parseDuration(sk[1]);
    if (skipOffset == null || isNaN(skipOffset)) skipOffset = skipAfter;
    // tracking events
    const events = {};
    const evRe = /<Tracking[^>]*event=["']([^"']+)["'][^>]*>([\s\S]*?)<\/Tracking>/gi;
    let em;
    while ((em = evRe.exec(xml))) {
      const name = em[1].toLowerCase();
      if (name === 'complete' || name === 'skip') events[name] = events[name] || [];
      events[name].push(tag(em[2]));
    }
    return {
      url: masked,
      hls: !!pick.hls,
      duration,
      skipAfter: skipOffset,
      impressions: [...new Set(impressions)],
      error: [...new Set(errors)],
      complete: events.complete || [],
      skip: events.skip || []
    };
  }
  throw new Error('no playable VAST media');
}

function parseDuration(s) {
  s = String(s || '').trim();
  if (!s) return NaN;
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseFloat(s);
}

module.exports = { resolve, fetchXml };
