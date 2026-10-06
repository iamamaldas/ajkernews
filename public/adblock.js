// public/adblock.js
// 🛡️ Adult Ad Blocker — বাইরের ফাইলে রাখা হয়েছে CPU Time কমাতে

(function(){
  'use strict';
  var KEY = ['porn','xxx','adult','nude','naked','erotic','cam-girl','camgirl','escort','livejasmin','chaturbate','bongacams','stripchat','trafficjunky','exoclick','juicyads','plugrush','adnium','ero-advertising','hentai','onlyfans','milf','hardcore','softcore','fuck','cock','pussy','dick','boobs','tits'];
  var SAFE = ['bicea.org','adsterra.com','profitableratecpm.com','highperformanceformat.com','afders.org','ajkernews.in','gstatic.com','googleapis.com','cloudflare.com','firebase.com','google.com'];
  function isSafe(u){ if(!u) return false; try { var h = new URL(u, location.origin).hostname.toLowerCase(); return SAFE.some(function(s){ return h.indexOf(s) !== -1; }); } catch(e){ return false; } }
  function isAdult(s){ if(!s) return false; var l = String(s).toLowerCase(); return KEY.some(function(k){ return l.indexOf(k) !== -1; }); }
  function block(el){ try { el.style.cssText = 'display:none!important;visibility:hidden!important;width:0!important;height:0!important;position:absolute!important;left:-99999px!important;pointer-events:none!important;'; el.setAttribute('data-blocked','1'); if(el.parentNode) setTimeout(function(){ try { el.parentNode.removeChild(el); } catch(e){} }, 100); } catch(e){} }
  function should(el){
    if(!el || !el.tagName) return false;
    if(el.id === 'newNewsBanner' || el.id === 'copyToast' || el.id === 'searchModal' || el.id === 'sidebar' || el.id === 'modal' || el.id === 'notifPromptModal' || el.id === 'overlay' || el.id === 'newsContainer' || el.id === 'loadMoreBtn') return false;
    if(el.id && el.id.indexOf('container-') === 0) return false;
    if(el.classList && (el.classList.contains('native-banner-block') || el.classList.contains('news-card') || el.classList.contains('inline-native-ad'))) return false;
    var t = el.tagName.toLowerCase();
    if(t === 'iframe'){ var s = el.src || el.getAttribute('src') || el.getAttribute('data-src') || ''; if(isSafe(s)) return false; if(isAdult(s)) return true; var w = parseInt(el.width||0,10), h = parseInt(el.height||0,10); if((w > 400 || h > 300) && s && !isSafe(s)) return true; }
    if(t === 'img'){ var s = el.src || el.getAttribute('src') || el.getAttribute('data-src') || ''; if(isSafe(s)) return false; if(isAdult(s)) return true; }
    if(t === 'a'){ var h = el.href || el.getAttribute('href') || ''; if(isSafe(h)) return false; if(isAdult(h)) return true; }
    var idc = (el.id||'') + ' ' + (el.className||''); if(isAdult(idc)) return true;
    var st = el.getAttribute && el.getAttribute('style') || '';
    if(st && (st.indexOf('position: fixed') !== -1 || st.indexOf('position:fixed') !== -1)){ if(/z-index:\s*\d{5,}/i.test(st)) return true; }
    return false;
  }
  function scan(){ try { document.querySelectorAll('iframe,img,a,div[style*="position"],ins,embed,object').forEach(function(el){ if(el.getAttribute('data-blocked') === '1') return; if(should(el)) block(el); }); } catch(e){} }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
  try { new MutationObserver(function(ms){ ms.forEach(function(m){ m.addedNodes.forEach(function(n){ if(n.nodeType === 1){ if(should(n)) block(n); else { try { n.querySelectorAll && n.querySelectorAll('iframe,img,a,ins,embed,object').forEach(function(c){ if(should(c)) block(c); }); } catch(e){} } } }); }); }).observe(document.documentElement, { childList: true, subtree: true }); } catch(e){}
  setInterval(scan, 3000);
  var orig = window.open;
  window.open = function(u){ if(u && isAdult(u) && !isSafe(u)) { try { console.warn('[AdBlock] Blocked adult popup'); } catch(e){} return null; } return orig.apply(this, arguments); };
  try { console.log('[AdBlock] Adult content blocker active'); } catch(e){}
})();
