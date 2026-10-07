// public/adblock.js
// 🛡️ Adult Ad Blocker v4.0 — Popunder + Social Bar + Native Banner Safe

(function () {
  'use strict';

  var ADULT_DOMAINS = [
    'trafficjunky', 'exoclick', 'juicyads', 'plugrush', 'adnium',
    'ero-advertising', 'livejasmin', 'chaturbate', 'bongacams', 'stripchat',
    'hentai', 'onlyfans', 'camgirl', 'cam-girl', 'escort'
  ];

  var SAFE_DOMAINS = [
    'bicea.org', 'adsterra.com', 'profitableratecpm.com',
    'highperformanceformat.com', 'afders.org', 'ajkernews.in',
    'gstatic.com', 'googleapis.com', 'cloudflare.com',
    'firebase.com', 'google.com', 'googleusercontent.com'
  ];

  function getHost(u) {
    if (!u) return '';
    try { return new URL(u, location.origin).hostname.toLowerCase(); } catch (e) { return ''; }
  }

  function isSafe(u) {
    var h = getHost(u);
    if (!h) return false;
    for (var i = 0; i < SAFE_DOMAINS.length; i++) {
      if (h.indexOf(SAFE_DOMAINS[i]) !== -1) return true;
    }
    return false;
  }

  function isAdult(u) {
    var h = getHost(u);
    if (!h) return false;
    for (var i = 0; i < ADULT_DOMAINS.length; i++) {
      if (h.indexOf(ADULT_DOMAINS[i]) !== -1) return true;
    }
    return false;
  }

  function hideElement(el) {
    try {
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
      el.setAttribute('data-blocked', '1');
    } catch (e) { }
  }

  function shouldBlock(el) {
    if (!el || !el.tagName) return false;
    if (el.getAttribute && el.getAttribute('data-blocked') === '1') return false;

    var id = el.id || '';
    var PROTECTED = [
      'newNewsBanner', 'copyToast', 'searchModal', 'sidebar',
      'modal', 'notifPromptModal', 'overlay', 'newsContainer', 'loadMoreBtn'
    ];
    if (PROTECTED.indexOf(id) !== -1) return false;
    if (id && id.indexOf('container-') === 0) return false;

    var cls = el.className || '';
    if (typeof cls === 'string') {
      if (cls.indexOf('native-banner') !== -1) return false;
      if (cls.indexOf('news-card') !== -1) return false;
      if (cls.indexOf('news-image') !== -1) return false;
      if (cls.indexOf('action-btn') !== -1) return false;
      if (cls.indexOf('header') !== -1) return false;
      if (cls.indexOf('sidebar') !== -1) return false;
      if (cls.indexOf('modal') !== -1) return false;
      if (cls.indexOf('overlay') !== -1) return false;
      if (cls.indexOf('skeleton') !== -1) return false;
    }

    var tag = el.tagName.toLowerCase();

    if (tag === 'iframe') {
      var src = el.src || el.getAttribute('src') || el.getAttribute('data-src') || '';
      if (!src) return false;
      if (isSafe(src)) return false;
      return isAdult(src);
    }

    if (tag === 'img') {
      var isrc = el.src || el.getAttribute('src') || el.getAttribute('data-src') || '';
      if (!isrc) return false;
      if (isSafe(isrc)) return false;
      return isAdult(isrc);
    }

    if (tag === 'a') {
      var href = el.href || el.getAttribute('href') || '';
      if (!href) return false;
      if (isSafe(href)) return false;
      return isAdult(href);
    }

    return false;
  }

  function scan() {
    try {
      var els = document.querySelectorAll('iframe, img, a');
      for (var i = 0; i < els.length; i++) {
        if (shouldBlock(els[i])) hideElement(els[i]);
      }
    } catch (e) { }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }

  try {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var nodes = mutations[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j];
          if (n.nodeType === 1) {
            if (shouldBlock(n)) hideElement(n);
            try {
              var children = n.querySelectorAll ? n.querySelectorAll('iframe, img, a') : [];
              for (var k = 0; k < children.length; k++) {
                if (shouldBlock(children[k])) hideElement(children[k]);
              }
            } catch (e) { }
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { }

  var origOpen = window.open;
  window.open = function (u) {
    if (u && isAdult(u) && !isSafe(u)) {
      try { console.warn('[AdBlock] Blocked adult popup'); } catch (e) { }
      return null;
    }
    return origOpen.apply(this, arguments);
  };

  try { console.log('[AdBlock] Active v4.0 — Popunder + Social Bar + Native safe'); } catch (e) { }
})();
