// lib/sprites.js
// YouTube-style scrub previews for LOCAL-file entries: extract a grid of frames
// with ffmpeg, write <id>.jpg (the tiled sprite) + <id>.vtt (WebVTT mapping each
// time range to a sprite cell). External/embed sources have no local file and
// use the player's live-frame scrub instead.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SPRITES_DIR = path.join(__dirname, '..', 'data', 'sprites');

function spritePaths(id) {
  return { img: path.join(SPRITES_DIR, id + '.jpg'), vtt: path.join(SPRITES_DIR, id + '.vtt') };
}

function durationSeconds(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 15000 }, (err, stdout) => {
      const secs = parseFloat(String(stdout || '').trim());
      resolve(isNaN(secs) ? 0 : secs);
    });
  });
}

// Generate a sprite sheet + VTT for a local video file.
// options: { cellW, cellH, cols, rows, outDir }
function generate(filePath, id, options) {
  options = options || {};
  const cellW = options.cellW || 160;
  const cellH = options.cellH || 90;
  const cols = options.cols || 5;
  const rows = options.rows || 5;
  const outDir = options.outDir || SPRITES_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  return new Promise(async (resolve, reject) => {
    const dur = await durationSeconds(filePath);
    if (!dur || dur < 5) return reject(new Error('duration unavailable'));

    const frames = cols * rows;
    // sample evenly across the clip; fps=N/dur yields ~N frames
    const fps = frames / dur;
    const img = path.join(outDir, id + '.jpg');
    const vtt = path.join(outDir, id + '.vtt');

    const args = [
      '-loglevel', 'error', '-y', '-i', filePath,
      '-vf', `fps=${fps},scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2,${cols}x${rows}`,
      '-q:v', '5', img
    ];
    execFile('ffmpeg', args, { timeout: 120000 }, (err) => {
      if (err) return reject(err);
      if (!fs.existsSync(img)) return reject(new Error('no sprite output'));

      // Build VTT from the actual image dims
      const out = buildVtt(dur, cols, rows, img, cellW, cellH);
      fs.writeFileSync(vtt, out);
      resolve({ id, img, vtt, frames, duration: dur });
    });
  });
}

function buildVtt(duration, cols, rows, imgPath, cellW, cellH) {
  let lines = ['WEBVTT', ''];
  // Tile output may not be exactly cols*rows if fewer frames were captured —
  // detect grid from image dimensions.
  const { width, height } = imageSize(imgPath);
  const c = Math.min(cols, Math.max(1, Math.floor(width / cellW)));
  const r = Math.min(rows, Math.max(1, Math.floor(height / cellH)));
  const n = c * r;
  const step = duration / n;
  for (let i = 0; i < n; i++) {
    const start = (i * step).toFixed(3);
    const end = ((i + 1) * step).toFixed(3);
    const row = Math.floor(i / c);
    const col = i % c;
    lines.push(`\n${ts(start)} --> ${ts(end)}`);
    lines.push(`#xywh=${col * cellW},${row * cellH},${cellW},${cellH}`);
    lines.push('');
  }
  return lines.join('\n');
}

function ts(secs) {
  const s = parseFloat(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function imageSize(imgPath) {
  try {
    // read PNG/JPEG dims from header bytes without a decode dependency
    const b = fs.readFileSync(imgPath);
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = (b[i + 2] << 8) | b[i + 3];
        if (marker === 0xc0 || marker === 0xc2) {
          return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
        }
        i += 2 + len;
      }
    } else if (b[0] === 0x89 && b[1] === 0x50) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
  } catch (e) {}
  return { width: 0, height: 0 };
}

function hasSprites(id) {
  const p = spritePaths(id);
  return fs.existsSync(p.img) && fs.existsSync(p.vtt);
}

module.exports = { generate, hasSprites, spritePaths };
