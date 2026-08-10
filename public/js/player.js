/* WPS-Transformer Player — custom controls, YouTube-style scrubbing previews,
   HLS quality switching, VAST pre-roll, keyboard + touch gestures. No deps. */
(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var root = $('.wps-player');
  if (!root) return;

  var video = $('#wpsVideo', root);
  if (!video) return;

  // ── element refs ──────────────────────────────────────────────────────────
  var controlsEl = $('.wps-controls', root);
  var centerPlay = $('.wps-big-play', root);
  var loaderEl = $('.wps-loader', root);
  var posterEl = $('.wps-poster', root);
  var progressWrap = $('.wps-progress-wrap', root);
  var progressEl = $('.wps-progress', root);
  var bufferedEl = $('.wps-buffered', root);
  var playedEl = $('.wps-played', root);
  var thumbEl = $('.wps-thumb', root);
  var previewBubble = $('.wps-preview-bubble', root);
  var previewImg = $('.wps-preview-img', root);
  var previewTime = $('.wps-preview-time', root);
  var timeEl = $('.wps-time', root);
  var adEl = $('.wps-ad', root);
  var adBadge = $('.wps-ad-badge', root);
  var adSkipEl = $('.wps-ad-skip', root);
  var qualityBtn = $('[data-act="quality"]', root);
  var speedBtn = $('[data-act="speed"]', root);

  // ── config from data attrs ────────────────────────────────────────────────
  var SRC = root.getAttribute('data-src') || '';
  var POSTER = root.getAttribute('data-poster') || '';
  var SPRITES = null;
  try { SPRITES = JSON.parse(root.getAttribute('data-sprites') || 'null'); } catch (e) {}
  var AUTOPLAY_NEXT = root.getAttribute('data-autoplay-next') === '1';
  var PREROLL = root.getAttribute('data-preroll') === '1';
  var NEXT_URL = root.getAttribute('data-next') || '';
  var NEXT_TITLE = root.getAttribute('data-next-title') || '';

  var IS_HLS = /\.m3u8(\?|$|#)/i.test(SRC);
  var hls = null;
  var HLS_SUPPORTED = typeof Hls !== 'undefined' && Hls.isSupported();
  var NATIVE_HLS = video.canPlayType('application/vnd.apple.mpegurl') !== '';

  // ── state ─────────────────────────────────────────────────────────────────
  var state = {
    scrubbing: false,
    wasPaused: true,
    resumeAt: 0,
    controlsVisible: true,
    hideTimer: null,
    muted: false,
    volume: 1,
    adPlaying: false,
    adSkipAllowed: false,
    adResumeAt: 0,
    adTimers: [],
    lastHoverTime: -1,
    vtt: [],
    dragging: false
  };

  var SPRITE_CELLS = { cellW: 160, cellH: 90, cols: 5, rows: 5 };

  // ── helpers ───────────────────────────────────────────────────────────────
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    return (h > 0 ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function ratioFromEvent(e) {
    var r = progressEl.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  }

  function firePixel(url) {
    if (!url || typeof url !== 'string') return;
    try { new Image().src = url; } catch (e) {}
  }

  // ── HLS boot ──────────────────────────────────────────────────────────────
  function loadMedia(src, autoplay) {
    IS_HLS = /\.m3u8(\?|$|#)/i.test(src);
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    video.removeAttribute('src');
    video.load();
    if (IS_HLS && HLS_SUPPORTED) {
      hls = new Hls({ maxBufferLength: 30 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        buildQualityMenu();
        if (autoplay) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      });
      hls.on(Hls.Events.ERROR, function (e, d) {
        if (d && d.fatal) {
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR && hls && hls.startLoad) { hls.startLoad(); return; }
          try { hls.destroy(); } catch (e2) {}
          hls = null;
          video.setAttribute('src', src);
          video.load();
          if (autoplay) { var p2 = video.play(); if (p2 && p2.catch) p2.catch(function () {}); }
        }
      });
    } else if (IS_HLS && NATIVE_HLS) {
      video.setAttribute('src', src);
      video.load();
      if (autoplay) { var p3 = video.play(); if (p3 && p3.catch) p3.catch(function () {}); }
    } else {
      video.setAttribute('src', src);
      video.load();
      if (autoplay) { var p4 = video.play(); if (p4 && p4.catch) p4.catch(function () {}); }
    }
  }

  function buildQualityMenu() {
    if (!hls || !hls.levels || hls.levels.length < 2) { qualityBtn.style.display = 'none'; return; }
    qualityBtn.style.display = '';
    var menu = $('.wps-menu[data-menu="quality"]', root);
    if (!menu) return;
    menu.innerHTML = '';
    var levels = hls.levels;
    var seen = {};
    var items = [];
    items.push({ label: 'Auto', level: -1 });
    for (var i = levels.length - 1; i >= 0; i--) {
      var h = levels[i].height;
      if (seen[h]) continue;
      seen[h] = 1;
      items.push({ label: (h >= 1000 ? (h / 1000).toFixed(1) : h) + 'p', level: i });
    }
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.textContent = it.label;
      b.dataset.level = it.level;
      b.addEventListener('click', function () {
        try { hls.currentLevel = it.level; } catch (e) {}
        closeMenus();
      });
      menu.appendChild(b);
    });
  }

  // ── controls visibility ───────────────────────────────────────────────────
  function showControls() {
    state.controlsVisible = true;
    root.classList.add('wps-controls-on');
    scheduleHide();
  }
  function scheduleHide() {
    if (state.hideTimer) clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(function () {
      if (!video.paused && !state.scrubbing && !state.adPlaying) hideControls();
    }, 2600);
  }
  function hideControls() {
    state.controlsVisible = false;
    root.classList.remove('wps-controls-on');
    closeMenus();
  }
  function toggleControls() { if (state.controlsVisible && video.currentTime > 0 && !video.paused) hideControls(); else showControls(); }

  function closeMenus() { $$('.wps-menu', root).forEach(function (m) { m.classList.remove('open'); }); }

  // ── play / pause ──────────────────────────────────────────────────────────
  function togglePlay() {
    if (state.adPlaying) return;
    if (video.paused || video.ended) {
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    } else {
      video.pause();
    }
  }

  // ── progress / scrubbing ──────────────────────────────────────────────────
  function updateProgress() {
    var d = video.duration || 0;
    var c = video.currentTime || 0;
    if (d > 0) {
      playedEl.style.width = ((c / d) * 100) + '%';
      thumbEl.style.left = ((c / d) * 100) + '%';
    }
    if (timeEl) timeEl.textContent = fmt(c) + ' / ' + fmt(d);
    if (video.buffered && video.buffered.length) {
      var end = video.buffered.end(video.buffered.length - 1);
      bufferedEl.style.width = (d > 0 ? (end / d) * 100 : 0) + '%';
    }
  }

  // sprite VTT parsing
  function parseVtt(text) {
    var cells = [];
    var lines = text.split(/\r?\n/);
    var t = null, xywh = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      var m = line.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
      if (m) {
        var st = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
        var en = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
        t = { start: st, end: en };
      } else {
        var xy = line.match(/#xywh=(\d+),(\d+),(\d+),(\d+)/);
        if (xy && t) {
          xywh = { x: +xy[1], y: +xy[2], w: +xy[3], h: +xy[4] };
          cells.push({ start: t.start, end: t.end, x: xywh.x, y: xywh.y, w: xywh.w, h: xywh.h });
          t = null;
        }
      }
    }
    state.vtt = cells;
  }

  function loadSprites() {
    if (!SPRITES || !SPRITES.vtt || !SPRITES.img) return;
    fetch(SPRITES.vtt).then(function (r) { return r.ok ? r.text() : ''; }).then(function (t) {
      if (t) { parseVtt(t); previewImg.style.backgroundImage = 'url(' + SPRITES.img + ')'; }
    }).catch(function () {});
  }

  function showPreviewCell(ratio) {
    if (!state.vtt.length || !previewImg) return;
    var d = video.duration || 0;
    var t = ratio * d;
    var cell = null;
    for (var i = 0; i < state.vtt.length; i++) {
      if (t >= state.vtt[i].start && t < state.vtt[i].end) { cell = state.vtt[i]; break; }
    }
    if (!cell && state.vtt.length) cell = state.vtt[Math.min(state.vtt.length - 1, Math.floor(ratio * state.vtt.length))];
    if (!cell) return;
    previewImg.style.backgroundPosition = '-' + cell.x + 'px -' + cell.y + 'px';
    previewImg.style.backgroundSize = (SPRITE_CELLS.cellW * (SPRITES.cols || 5)) + 'px ' + (SPRITE_CELLS.cellH * (SPRITES.rows || 5)) + 'px';
  }

  function scrubTo(ratio) {
    var d = video.duration || 0;
    var t = ratio * d;
    video.currentTime = t;
    if (timeEl) timeEl.textContent = fmt(t) + ' / ' + fmt(d);
    showPreviewCell(ratio);
  }

  function startScrub() {
    if (state.adPlaying) return;
    state.scrubbing = true;
    state.wasPaused = video.paused;
    state.resumeAt = video.currentTime;
    state.dragging = true;
    video.pause();
    previewBubble.classList.add('show');
    root.classList.add('wps-scrubbing');
    hideMenus();
  }

  function endScrub() {
    state.scrubbing = false;
    state.dragging = false;
    previewBubble.classList.remove('show');
    root.classList.remove('wps-scrubbing');
    if (!state.wasPaused && !state.adPlaying) {
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    }
    showControls();
  }

  // hover (non-drag) preview — sprite cells only (no seek spam); live-frame
  // preview happens while dragging.
  function handleHover(e) {
    if (state.dragging) return;
    var ratio = ratioFromEvent(e);
    var now = Date.now();
    if (Math.abs(ratio - state.lastHoverTime) < 0.004 && now - (state._hoverTs || 0) < 120) return;
    state._hoverTs = now;
    state.lastHoverTime = ratio;
    var d = video.duration || 0;
    var t = ratio * d;
    previewTime.textContent = fmt(t);
    if (state.vtt.length) {
      previewBubble.classList.add('show');
      showPreviewCell(ratio);
    } else if (previewImg) {
      previewImg.style.backgroundImage = 'none';
    }
  }

  function handleHoverLeave() {
    if (!state.dragging) previewBubble.classList.remove('show');
  }

  // ── menus ─────────────────────────────────────────────────────────────────
  function hideMenus() { $$('.wps-menu', root).forEach(function (m) { m.classList.remove('open'); }); }

  // ── fullscreen ────────────────────────────────────────────────────────────
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (root.requestFullscreen) root.requestFullscreen();
  }
  function togglePip() {
    if (document.pictureInPictureElement) document.exitPictureInPicture();
    else if (video.requestPictureInPicture) video.requestPictureInPicture();
  }

  // ── speed ─────────────────────────────────────────────────────────────────
  function buildSpeedMenu() {
    var menu = $('.wps-menu[data-menu="speed"]', root);
    if (!menu) return;
    var rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    rates.forEach(function (r) {
      var b = document.createElement('button');
      b.textContent = r + 'x';
      b.addEventListener('click', function () {
        video.playbackRate = r;
        speedBtn.textContent = r + 'x';
        closeMenus();
      });
      menu.appendChild(b);
    });
  }

  // ── gestures (touch) ──────────────────────────────────────────────────────
  function finishAd(completed) {
    state.adPlaying = false;
    state.adSkipAllowed = false;
    root.classList.remove('wps-ad-on');
    adEl.classList.remove('show');
    state.adTimers.forEach(clearInterval);
    state.adTimers = [];
    var data = window._lastAd || {};
    if (completed && data.complete) data.complete.forEach(firePixel);
    loadMedia(SRC, false);
    video.currentTime = state.adResumeAt;
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
  }
  function skipAd() {
    if (!state.adSkipAllowed) return;
    var data = window._lastAd || {};
    if (data.skip) data.skip.forEach(firePixel);
    finishAd(false);
  }

  // ── gestures (touch) ──────────────────────────────────────────────────────
  var lastTap = 0;
  function handleTap(e) {
    var now = Date.now();
    if (now - lastTap < 320) { // double tap
      var r = root.getBoundingClientRect();
      var x = e.clientX - r.left;
      var dx = (x / r.width) * video.duration;
      if (x < r.width / 3) { seekRelative(-10, true); }
      else if (x > (r.width * 2) / 3) { seekRelative(10, true); }
      lastTap = 0;
      return;
    }
    lastTap = now;
    toggleControls();
  }

  function seekRelative(sec, showFlash) {
    if (state.adPlaying) return;
    video.currentTime = clamp(video.currentTime + sec, 0, video.duration || 0);
    if (showFlash) flashSeek(sec);
    showControls();
  }

  function flashSeek(sec) {
    var el = document.createElement('div');
    el.className = 'wps-seek-flash';
    el.textContent = (sec > 0 ? '+' : '') + sec + 's';
    root.appendChild(el);
    setTimeout(function () { el.remove(); }, 700);
  }

  // ── autoplay next ─────────────────────────────────────────────────────────
  function autoplayNext() {
    if (!AUTOPLAY_NEXT || !NEXT_URL) return;
    showControls();
    var overlay = document.createElement('div');
    overlay.className = 'wps-nextup';
    overlay.innerHTML = '<div class="wps-nextup-title">Up next</div><div class="wps-nextup-name">' +
      (NEXT_TITLE ? escapeHtml(NEXT_TITLE) : '') + '</div>' +
      '<div class="wps-nextup-count">3</div>';
    root.appendChild(overlay);
    var n = 3;
    var t = setInterval(function () {
      n--;
      if (n <= 0) { clearInterval(t); window.location.href = NEXT_URL; }
      else { var c = $('.wps-nextup-count', overlay); if (c) c.textContent = n; }
    }, 1000);
    overlay.addEventListener('click', function () { clearInterval(t); window.location.href = NEXT_URL; });
  }
  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ── events ────────────────────────────────────────────────────────────────
  video.addEventListener('timeupdate', updateProgress);
  video.addEventListener('progress', updateProgress);
  video.addEventListener('loadedmetadata', function () {
    updateProgress();
    buildQualityMenu();
  });
  video.addEventListener('durationchange', updateProgress);
  video.addEventListener('waiting', function () { if (!state.adPlaying) loaderEl.classList.add('show'); });
  video.addEventListener('canplay', function () { loaderEl.classList.remove('show'); });
  video.addEventListener('playing', function () { loaderEl.classList.remove('show'); root.classList.add('wps-has-played'); });
  video.addEventListener('play', function () {
    root.classList.add('wps-playing');
    posterEl && posterEl.classList.add('hide');
    scheduleHide();
  });
  video.addEventListener('pause', function () {
    root.classList.remove('wps-playing');
    showControls();
  });
  video.addEventListener('ended', function () {
    root.classList.remove('wps-playing');
    if (state.adPlaying) return;
    autoplayNext();
  });
  video.addEventListener('error', function () { loaderEl.classList.remove('show'); });

  // keyboard
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target && e.target.isContentEditable) return;
    if (state.adPlaying) {
      if (e.key === ' ') e.preventDefault();
      return;
    }
    switch (e.key) {
      case ' ': case 'k': case 'K': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': seekRelative(-5); break;
      case 'ArrowRight': seekRelative(5); break;
      case 'j': case 'J': seekRelative(-10); break;
      case 'l': case 'L': seekRelative(10); break;
      case 'ArrowUp': e.preventDefault(); adjustVolume(0.1); break;
      case 'ArrowDown': e.preventDefault(); adjustVolume(-0.1); break;
      case 'm': case 'M': toggleMute(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'Home': video.currentTime = 0; break;
      case 'End': video.currentTime = (video.duration || 0) - 0.5; break;
      default:
        if (e.key >= '0' && e.key <= '9' && video.duration) { video.currentTime = (+e.key / 10) * video.duration; }
    }
  });

  function adjustVolume(d) {
    state.volume = clamp(state.volume + d, 0, 1);
    video.volume = state.volume;
    video.muted = state.volume === 0;
    state.muted = video.muted;
    updateVolBtn();
  }
  function toggleMute() {
    state.muted = !state.muted;
    video.muted = state.muted;
    updateVolBtn();
  }
  function updateVolBtn() {
    var b = $('[data-act="mute"]', root);
    if (b) b.classList.toggle('muted', video.muted || video.volume === 0);
  }

  // button actions
  $$('[data-act]', root).forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var act = btn.getAttribute('data-act');
      if (state.adPlaying && act !== 'fs') return;
      switch (act) {
        case 'play': togglePlay(); break;
        case 'rewind': seekRelative(-10); break;
        case 'forward': seekRelative(10); break;
        case 'mute': toggleMute(); break;
        case 'pip': togglePip(); break;
        case 'fs': toggleFullscreen(); break;
        case 'speed': case 'quality':
          var menu = $('.wps-menu[data-menu="' + act + '"]', root);
          if (!menu) break;
          var open = menu.classList.contains('open');
          closeMenus();
          if (!open) menu.classList.add('open');
          break;
      }
    });
  });

  // volume slider
  var volInput = $('.wps-volume input', root);
  if (volInput) {
    volInput.addEventListener('input', function () {
      video.volume = +volInput.value;
      video.muted = video.volume === 0;
      state.volume = video.volume;
      updateVolBtn();
    });
  }

  // progress interactions (pointer — unifies mouse + touch)
  progressWrap.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    progressWrap.setPointerCapture(e.pointerId);
    startScrub();
    scrubTo(ratioFromEvent(e));
  });
  progressWrap.addEventListener('pointermove', function (e) {
    if (!state.scrubbing) { handleHover(e); return; }
    scrubTo(ratioFromEvent(e));
  });
  progressWrap.addEventListener('pointerup', function (e) {
    if (state.scrubbing) { scrubTo(ratioFromEvent(e)); endScrub(); }
  });
  progressWrap.addEventListener('pointercancel', function () { if (state.scrubbing) endScrub(); });
  progressWrap.addEventListener('mouseleave', function () { handleHoverLeave(); });

  // controls visibility
  centerPlay.addEventListener('click', function (e) { e.stopPropagation(); togglePlay(); });
  root.addEventListener('pointermove', showControls);
  root.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch') handleTap(e);
  });
  root.addEventListener('dblclick', function (e) {
    if (!state.adPlaying) toggleFullscreen();
  });

  // menus close on outside click
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.wps-menu') && !e.target.closest('[data-act]')) closeMenus();
  });

  // fullscreen API changes
  document.addEventListener('fullscreenchange', function () {
    root.classList.toggle('wps-fullscreen', !!document.fullscreenElement);
  });

  // ── init ──────────────────────────────────────────────────────────────────
  video.volume = state.volume;
  updateVolBtn();
  buildSpeedMenu();
  loadSprites();
  loadMedia(SRC, false);
  updateProgress();

  // start pre-roll once (content load is deferred until ad resolves)
  if (PREROLL) {
    fetch('/api/ads/preroll').then(function (r) { return r.json(); }).then(function (ad) {
      if (!ad || !ad.url) return;
      window._lastAd = ad;
      state.adPlaying = true;
      state.adSkipAllowed = false;
      state.adResumeAt = 0;
      (ad.impressions || []).forEach(firePixel);
      root.classList.add('wps-ad-on');
      adEl.classList.add('show');
      adBadge.textContent = 'Ad';
      showControls();
      var count = Math.max(3, Math.ceil(ad.skipAfter || 5));
      adSkipEl.innerHTML = '<button disabled>Skip in ' + count + 's</button>';
      var tick = setInterval(function () {
        count--;
        if (count <= 0) {
          clearInterval(tick);
          state.adSkipAllowed = true;
          adSkipEl.innerHTML = '<button class="wps-skip-btn">Skip Ad</button>';
          var sb = $('.wps-skip-btn', adSkipEl);
          if (sb) sb.addEventListener('click', function () { skipAd(); });
        } else {
          adSkipEl.innerHTML = '<button disabled>Skip in ' + count + 's</button>';
        }
      }, 1000);
      state.adTimers.push(tick);
      video.addEventListener('ended', function onAdEnded() {
        video.removeEventListener('ended', onAdEnded);
        finishAd(true);
      }, { once: true });
      loadMedia(ad.url, true);
    }).catch(function () {});
  }
})();
