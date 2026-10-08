// worker/src/article-popunder.js
// ═══════════════════════════════════════════════════════════
// ✅ ARTICLE-ONLY POPUNDER SCRIPT
// শুধু news detail পেজে trigger হয়, 70% scroll-এ, daily once
// Header, menu, button, share, comment — সব blocked
// + Adsterra Frequency Cap (1/24h) — double safety
// ═══════════════════════════════════════════════════════════

export const POPUNDER_URL = "https://afders.org/1/cefd70fdb5260cccd9456ab45e1e7512";

export function getArticlePopunderScript() {
  return `<script>
(function() {
  'use strict';

  var POPUNDER_URL = "${POPUNDER_URL}";
  var COOLDOWN_KEY = 'popunder_article_last_fire';
  var COOLDOWN_MS = 24 * 60 * 60 * 1000; // ✅ 24 hours = daily once
  var SCROLL_TRIGGER = 70;
  var fired = false;
  var scriptLoaded = false;

  // ✅ Layer 1: JS Cooldown (24h)
  var last = parseInt(localStorage.getItem(COOLDOWN_KEY) || '0', 10);
  if ((Date.now() - last) < COOLDOWN_MS) {
    console.log('[Popunder] Cooldown active — skip');
    return;
  }

  // ✅ Same article-এ session-এ একবারই
  var pathId = (window.location.pathname || '').split('/').filter(Boolean).pop() || '';
  var FIRED_KEY = 'popunder_fired_' + pathId;
  if (sessionStorage.getItem(FIRED_KEY) === '1') {
    console.log('[Popunder] Already fired in this session');
    return;
  }

  // ✅ Click blocker — শুধু article body allow
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

  // ✅ 70% scroll check
  function checkScroll() {
    if (fired) return;
    var docHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (docHeight <= 0) return;
    var scrolled = (window.pageYOffset || document.documentElement.scrollTop) / docHeight * 100;

    if (scrolled >= SCROLL_TRIGGER) {
      fired = true;
      sessionStorage.setItem(FIRED_KEY, '1');
      localStorage.setItem(COOLDOWN_KEY, String(Date.now())); // ✅ 24h cooldown set
      console.log('[Popunder] 70% scrolled — loading script');
      loadPopunderScript();
      window.removeEventListener('scroll', onScroll);
    }
  }

  var timer = null;
  function onScroll() {
    if (timer) return;
    timer = setTimeout(function() { timer = null; checkScroll(); }, 250);
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  setTimeout(checkScroll, 800);
})();
<\/script>`;
}
