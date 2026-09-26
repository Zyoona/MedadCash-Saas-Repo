// _tools/splash-server.js — شاشة تحميل مؤقتة تُعرض أثناء تشغيل النظام.
// تُشغَّل من start.vbs: تظهر فوراً في المتصفح، تنتظر جاهزية API والويب،
// ثم تعيد التوجيه إلى التطبيق وتُغلق نفسها تلقائياً.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5199;
const HOST = '127.0.0.1';
const ROOT = path.resolve(__dirname, '..');
const LOGO = path.join(ROOT, 'apps', 'web', 'public', 'logo.png');
const APP_URL = 'http://127.0.0.1:5173/';
const WEB_URL = 'http://127.0.0.1:5173/';
const API_URL = 'http://127.0.0.1:3000/api/health';
const START = Date.now();
const MAX_MS = 10 * 60 * 1000;
// إذا جاهزة الويب وتأخر API وحده: نفتح التطبيق على أي حال بعد هذه المدة (بثوان)
const FORCE_OPEN_S = 180;

function reachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

let cache = { at: 0, val: null };
async function state() {
  const now = Date.now();
  if (cache.val && now - cache.at < 1000) return cache.val;
  const [web, api] = await Promise.all([reachable(WEB_URL), reachable(API_URL)]);
  const val = { web, api, ready: web && api, elapsed: Math.round((now - START) / 1000), app: APP_URL };
  cache = { at: now, val };
  return val;
}

const PAGE = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#f1f5f9">
<title>مداد — جارٍ التشغيل</title>
<style>
  :root {
    --bg: #f1f5f9; --panel: #ffffff; --surface: #f8fafc; --text: #0f172a;
    --muted: #64748b; --accent: #16a34a; --accent-2: #15803d; --warn: #d97706;
    --border: #e2e8f0; --radius: 10px;
    --font: "Segoe UI", Tahoma, Arial, sans-serif;
  }
  :root[data-theme="dark"] {
    --bg: #1d2534; --panel: #263043; --surface: #2e3a4f; --text: #e2e8f0;
    --muted: #9aa8bd; --accent: #22c55e; --accent-2: #4ade80; --warn: #fbbf24;
    --border: #3a4759;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: var(--font); background: var(--bg); color: var(--text); direction: rtl; }
  .brand-loader {
    position: fixed; inset: 0; z-index: 1000;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
    background:
      radial-gradient(ellipse 60% 45% at 50% 42%, rgba(34, 197, 94, 0.10), transparent 70%),
      radial-gradient(ellipse 45% 35% at 50% 60%, rgba(245, 158, 11, 0.08), transparent 70%),
      var(--bg);
    transition: opacity 550ms ease;
  }
  .brand-loader.leaving { opacity: 0; }
  .loader-stage { position: relative; width: 190px; height: 190px; display: grid; place-items: center; }
  .loader-halo {
    position: absolute; inset: -10px; border-radius: 50%;
    background: radial-gradient(circle, rgba(34, 197, 94, 0.20), transparent 65%);
    animation: halo-pulse 2.2s ease-in-out infinite;
  }
  @keyframes halo-pulse { 0%, 100% { transform: scale(0.85); opacity: 0.5; } 50% { transform: scale(1.12); opacity: 1; } }
  .loader-ring {
    position: absolute; inset: 6px; border-radius: 50%;
    border: 3px solid transparent; border-top-color: var(--accent);
    animation: ring-spin 2.2s linear infinite;
  }
  .loader-ring.ring-2 {
    inset: -6px; border-top-color: transparent; border-bottom-color: var(--warn);
    border-left-color: rgba(245, 158, 11, 0.35); border-style: dashed;
    animation: ring-spin-rev 3.4s linear infinite;
  }
  @keyframes ring-spin { to { transform: rotate(360deg); } }
  @keyframes ring-spin-rev { to { transform: rotate(-360deg); } }
  .loader-logo-wrap {
    position: relative; width: 132px; height: 132px; border-radius: 50%;
    overflow: hidden; background: var(--panel);
    box-shadow: 0 0 0 2px rgba(22, 163, 74, 0.35), 0 0 34px rgba(34, 197, 94, 0.30);
    animation: logo-breathe 2.2s ease-in-out infinite;
  }
  @keyframes logo-breathe {
    0%, 100% { transform: scale(1); box-shadow: 0 0 0 2px rgba(22,163,74,0.30), 0 0 22px rgba(34,197,94,0.22); }
    50% { transform: scale(1.055); box-shadow: 0 0 0 2px rgba(22,163,74,0.50), 0 0 44px rgba(34,197,94,0.38); }
  }
  .loader-logo { width: 100%; height: 100%; object-fit: cover; display: block; }
  .loader-shine {
    position: absolute; top: -20%; bottom: -20%; width: 45%;
    background: linear-gradient(105deg, transparent, rgba(255, 255, 255, 0.55), transparent);
    transform: translateX(-160%) rotate(8deg);
    animation: shine-sweep 2.4s ease-in-out infinite;
  }
  @keyframes shine-sweep { 0% { transform: translateX(-160%) rotate(8deg); } 55%, 100% { transform: translateX(320%) rotate(8deg); } }
  .loader-title {
    margin-top: 14px; font-size: 34px; font-weight: 800; letter-spacing: 1px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2), var(--warn));
    background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: title-shimmer 3s linear infinite;
  }
  @keyframes title-shimmer { to { background-position: -200% 0; } }
  .loader-sub { color: var(--muted); font-size: 14px; }
  .loader-bar {
    margin-top: 18px; width: 230px; height: 5px; border-radius: 999px;
    background: var(--surface); border: 1px solid var(--border); overflow: hidden;
  }
  .loader-bar-fill {
    height: 100%; width: 0%; border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), var(--warn));
    transition: width 350ms ease;
  }
  .loader-status { min-height: 20px; color: var(--muted); font-size: 13px; }
  .loader-error { margin-top: 8px; color: #dc2626; font-size: 13px; text-align: center; max-width: 320px; }
  .loader-error a { color: var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .brand-loader *, .brand-loader { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
    .loader-bar-fill { width: 100%; }
  }
</style>
</head>
<body>
<div class="brand-loader" id="loader" role="status" aria-busy="true">
  <div class="loader-stage">
    <div class="loader-ring"></div>
    <div class="loader-ring ring-2"></div>
    <div class="loader-halo"></div>
    <div class="loader-logo-wrap">
      <img src="/logo.png" alt="مداد" class="loader-logo">
      <div class="loader-shine"></div>
    </div>
  </div>
  <div class="loader-title">مداد</div>
  <div class="loader-sub">إدارة ومحاسبة المكتبة</div>
  <div class="loader-status" id="status">جارٍ تجهيز قاعدة البيانات...</div>
  <div class="loader-bar"><div class="loader-bar-fill" id="bar"></div></div>
  <div class="loader-error" id="error"></div>
</div>
<script>
(function () {
  try {
    if (localStorage.getItem('medad_theme') === 'dark') document.documentElement.dataset.theme = 'dark';
  } catch (e) {}
  var statusEl = document.getElementById('status');
  var barEl = document.getElementById('bar');
  var errEl = document.getElementById('error');
  var loaderEl = document.getElementById('loader');
  var start = Date.now();
  var target = '';
  // يتم تمرير FORCE_OPEN_S من الخادم، لكن نحتفظ به محلياً للمتانة
  var FORCE_OPEN_S = 180;
  function go() {
    loaderEl.className = 'brand-loader leaving';
    try { var d = new XMLHttpRequest(); d.open('POST', '/done', true); d.send(); } catch (e) {}
    setTimeout(function () { location.replace(target || 'http://127.0.0.1:5173/'); }, 550);
  }
  function render(s) {
    var secs = (Date.now() - start) / 1000;
    if (s.ready) {
      statusEl.textContent = 'اكتمل التجهيز — جارٍ فتح النظام...';
      barEl.style.width = '100%';
      go();
      return;
    }
    // fallback: الويب جاهز وتأخر API وحده — نفتح على أي حال بعد FORCE_OPEN_S ثانية
    if (s.web && s.elapsed >= FORCE_OPEN_S) {
      statusEl.textContent = 'خادم API لم يكتمل بعد — جارٍ فتح النظام على أي حال...';
      barEl.style.width = '90%';
      go();
      return;
    }
    if (secs < 3) {
      statusEl.textContent = 'جارٍ تجهيز قاعدة البيانات...';
      barEl.style.width = '15%';
    } else if (!s.web) {
      statusEl.textContent = 'جارٍ تشغيل واجهة الويب...';
      barEl.style.width = '45%';
    } else if (!s.api) {
      statusEl.textContent = 'جارٍ تشغيل خادم API...';
      barEl.style.width = '75%';
    } else {
      statusEl.textContent = 'جارٍ التجهيز...';
      barEl.style.width = '85%';
    }
    if (secs > 180) {
      errEl.innerHTML = 'تعذّر إكمال التشغيل خلال المدة المتوقعة. ' +
        '<a href="http://127.0.0.1:5173/">افتح النظام على أي حال</a>';
    }
  }
  function poll() {
    var x = new XMLHttpRequest();
    x.open('GET', '/status?_=' + Date.now(), true);
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      var s = { web: false, api: false, ready: false };
      if (x.status === 200) {
        try { s = JSON.parse(x.responseText); } catch (e) {}
      }
      if (s.app) target = s.app;
      render(s);
      if (!s.ready) setTimeout(poll, 700);
    };
    x.send();
  }
  poll();
})();
</script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/logo.png') {
    fs.readFile(LOGO, (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }
  if (url === '/status') {
    state().then((s) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(s));
    }).catch(() => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"web":false,"api":false,"ready":false}');
    });
    return;
  }
  if (url === '/done') {
    shutdown(1200);
    res.writeHead(204);
    res.end();
    return;
  }
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGE);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { process.exit(0); }
  console.error('[splash] server error:', e.message);
  process.exit(1);
});

let closing = false;
function shutdown(delayMs) {
  if (closing) return;
  closing = true;
  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }, delayMs);
}

server.listen(PORT, HOST, () => {
  console.log('[splash] loader ready at http://' + HOST + ':' + PORT + '/');
});

setTimeout(() => shutdown(0), MAX_MS);
