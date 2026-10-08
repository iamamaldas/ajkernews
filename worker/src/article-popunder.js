// worker/src/article-popunder.js
// ═══════════════════════════════════════════════════════════
// ✅ ARTICLE-ONLY POPUNDER SCRIPT
// 60 seconds time-based trigger only (high quality impression)
// Daily once per user | Header, menu, button, share, comment — blocked
// ═══════════════════════════════════════════════════════════

export const POPUNDER_URL = "https://afders.org/1/cefd70fdb5260cccd9456ab45e1e7512";

export function getArticlePopunderScript() {
  return `<script>
(function() {
  'use strict';

  var POPUNDER_URL = "${POPUNDER_URL}";
  var COOLDOWN_KEY = 'popunder_article_last_fire';
  var COOLDOWN_MS = 24 * 60 * 60 * 1000;      // ✅ 24 hours = daily once
  var TIME_TRIGGER_MS = 60 * 1000;             // ✅ 60 seconds = 1 minute
  var fired = false;
  var scriptLoaded = false;
  var timeTimer = null;
  var pageStartTime = Date.now();              // ✅ উপরে define
  var hiddenAt = null;

  // ✅ Layer 1: 24h cooldown check
  var last = parseInt(localStorage.getItem(COOLDOWN_KEY) || '0', 10);
  if ((Date.now() - last) < COOLDOWN_MS) {
    console.log('[Popunder] Cooldown active — skip (last fired:', new Date(last).toLocaleString(), ')');
    return;
  }

  // ✅ Same article-এ session-এ একবারই
  var pathId = (window.location.pathname || '').split('/').filter(Boolean).pop() || '';
  var FIRED_KEY = 'popunder_fired_' + pathId;
  if (sessionStorage.getItem(FIRED_KEY) === '1') {
    console.log('[Popunder] Already fired in this session');
    return;
  }

  // ✅ Click blocker — শুধু article body allow, বাকি সব block
  (function installBlocker() {
    var ALLOW_SELECTORS = '.article-body, #articleBody, .article-h1, .article-img';
    ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'pointerdown', 'pointerup'].forEach(function(eventType) {
      document.addEventListener(eventType, function(e) {
        if (!e.target || typeof e.target.closest !== 'function') {
          e.stopImmediatePropagation();
          e.stopPropagation();
          return;
        }
        if (e.target.closest(ALLOW_SELECTORS)) return;
        e.stopImmediatePropagation();
        e.stopPropagation();
      }, true);
    });
  })();

  // ✅ Adsterra script load
  function loadPopunderScript() {
    if (scriptLoaded) return;
    if (document.querySelector('script[data-ajker-popunder]')) {
      scriptLoaded = true;
      return;
    }
    console.log('[Popunder] Loading Adsterra script...');
    var s = document.createElement('script');
    s.async = true;
    s.src = POPUNDER_URL;
    s.setAttribute('data-cfasync', 'false');
    s.setAttribute('data-ajker-popunder', '1');
    s.onload = function() {
      scriptLoaded = true;
      console.log('[Popunder] Script loaded ✅');
    };
    s.onerror = function() {
      console.warn('[Popunder] Script load failed ❌');
    };
    document.body.appendChild(s);
  }

  // ✅ Fire popunder — one time only
  function firePopunder(source) {
    if (fired) return;
    fired = true;
    sessionStorage.setItem(FIRED_KEY, '1');
    localStorage.setItem(COOLDOWN_KEY, String(Date.now()));
    console.log('[Popunder] Triggered by:', source);
    loadPopunderScript();
  }

  // ✅ 60 seconds time-based trigger
  timeTimer = setTimeout(function() {
    firePopunder('60 seconds on page');
  }, TIME_TRIGGER_MS);

  // ✅ Tab hidden → timer pause; Tab visible → resume
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      // Tab hidden — timer pause
      if (timeTimer && !fired) {
        clearTimeout(timeTimer);
        timeTimer = null;
        hiddenAt = Date.now();
        console.log('[Popunder] Timer paused (tab hidden)');
      }
    } else {
      // Tab visible — বাকি সময় গণনা করে আবার timer চালু
      if (!fired && !timeTimer && hiddenAt) {
        // কত সময় visible ছিল (hidden হওয়ার আগে)
        var visibleBefore = hiddenAt - pageStartTime;
        var remaining = Math.max(1000, TIME_TRIGGER_MS - visibleBefore);
        console.log('[Popunder] Timer resumed — remaining:', Math.round(remaining / 1000), 's');
        timeTimer = setTimeout(function() {
          firePopunder('60 seconds on page (after resume)');
        }, remaining);
      }
    }
  });

  // ✅ Initial check — user already 60s পার করেছে কিনা (edge case)
  if (Date.now() - pageStartTime >= TIME_TRIGGER_MS) {
    firePopunder('already past 60 seconds');
  }
})();
<\/script>`;
}
