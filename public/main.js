/* ReviewCash main.js (full)
 * Works with backend routes from your main.py:
 *  - POST /api/sync
 *  - POST /api/task/create
 *  - POST /api/task/submit
 *  - POST /api/withdraw/create
 *  - POST /api/withdraw/list
 *  - POST /api/tbank/claim
 *  - POST /api/pay/stars/link
 *  - POST /api/ops/list
 *  - Admin:
 *    POST /api/admin/summary
 *    POST /api/admin/proof/list
 *    POST /api/admin/proof/decision
 *    POST /api/admin/withdraw/list
 *    POST /api/admin/withdraw/decision
 *    POST /api/admin/tbank/list
 *    POST /api/admin/tbank/decision
 *
 * IMPORTANT: to send proof images, you must add backend route:
 *  - POST /api/proof/upload  (multipart form-data) => { ok:true, url:"..." }
 */

(function () {
  "use strict";

  const RC_BUILD = "rc_20260322_lowend_compat";
  try { console.log("[ReviewCash] build", RC_BUILD); } catch(e) {}


  // --------------------
  // DOM helpers
  // --------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel, root = document) => (root || document).querySelector(sel);
  const qsa = (sel, root = document) => Array.from((root || document).querySelectorAll(sel));

  // --------------------
  // Telegram WebApp
  // --------------------
  const tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;

// --------------------
// External links helpers
// --------------------
const TBANK_REF_URL = "https://tbank.ru/baf/56p8AlptMz5";

function openExternalLink(url, opts = {}) {
  const link = String(url || "").trim();
  if (!link) return;

  // Always copy link as a fallback (some Telegram clients block opening bank links)
  const copy = () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).catch(() => {});
        return;
      }
    } catch (e) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = link;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) {}
  };

  try { copy(); } catch (e) {}

  // 1) Telegram WebApp API (best)
  try {
    const wtg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
    if (wtg && typeof wtg.openLink === "function") {
      wtg.openLink(link, { try_instant_view: false });
      try { if (opts.toast !== false) showToast("info", "Если ссылка не открылась — она скопирована в буфер.", "Ссылка"); } catch (e) {}
      return;
    }
  } catch (e) {}

  // 2) Anchor click (works better than window.open in some WebViews)
  try {
    const a = document.createElement("a");
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    try { if (opts.toast !== false) showToast("info", "Если ссылка не открылась — она скопирована в буфер.", "Ссылка"); } catch (e) {}
    return;
  } catch (e) {}

  // 3) Last resort
  try { window.open(link, "_blank"); } catch (e) { window.location.href = link; }
  try { if (opts.toast !== false) showToast("info", "Ссылка скопирована в буфер.", "Ссылка"); } catch (e) {}
}

// For T-Bank: referral link to issue a card
window.openTbankReferrals = function () {
  openExternalLink(TBANK_REF_URL);
};
// Backward-compat: some UI binds openTbankReferral (singular)
window.openTbankReferral = function () {
  openExternalLink(TBANK_REF_URL);
};

  
function showConnectHint() {
  const existing = document.getElementById("connect-hint");
  if (existing) return;
  const wrap = document.createElement("div");
  wrap.id = "connect-hint";
  wrap.style.cssText = "position:fixed;left:12px;right:12px;top:12px;z-index:99999;padding:12px 12px;border-radius:14px;background:rgba(255,60,60,.12);border:1px solid rgba(255,60,60,.35);backdrop-filter:blur(8px);";
  wrap.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px">Нет initData (Telegram)</div>
    <div style="opacity:.9;font-size:13px;line-height:1.25;margin-bottom:10px">
      Открой MiniApp кнопкой <b>/app</b> внутри чата с ботом или через кнопку меню — тогда Telegram пришлёт initData и профиль загрузится.
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button id="btn-open-bot-app" style="padding:8px 12px;border-radius:12px;border:0;background:#2ea6ff;color:#001018;font-weight:700">Открыть через бота</button>
      <button id="btn-hide-hint" style="padding:8px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:transparent;color:#fff;font-weight:600">Скрыть</button>
    </div>
  `;
  document.body.appendChild(wrap);
  document.getElementById("btn-hide-hint").onclick = () => wrap.remove();
  document.getElementById("btn-open-bot-app").onclick = () => {
    try {
      if ((window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openTelegramLink)) {
        // IMPORTANT: replace "app" with your BotFather WebApp short name if it's different
        window.Telegram.WebApp.openTelegramLink("https://t.me/ReviewCashOrg_Bot/app");
      } else {
        window.location.href = "https://t.me/ReviewCashOrg_Bot/app";
      }
    } catch (e) {
      window.location.href = "https://t.me/ReviewCashOrg_Bot/app";
    }
  };
}

function tgAlert(msg, kind = "info", title = "") {
    // Pretty in-app toast (preferred). Falls back to Telegram alert only if toast UI missing.
    const text = String((msg == null) ? "" : msg);
    const clean = prettifyErrText(text);
    const k = (kind === "error" || /^\s*\d{3}[:\s]/.test(text) || /ошиб/i.test(text) || /лимит/i.test(text)) ? "error" : kind;
    showToast(k, clean, title || (k === "error" ? "Ошибка" : "Сообщение"));
  }

  function tgHaptic(type = "impact", style = "light") {
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (type === "impact") tg.HapticFeedback.impactOccurred(style);
      if (type === "success") tg.HapticFeedback.notificationOccurred("success");
      if (type === "error") tg.HapticFeedback.notificationOccurred("error");
    } catch (e) {}
  }


  // --------------------
  // Nice toasts (instead of ugly alerts)
  // --------------------
  function prettifyErrText(s) {
    let t = String(s || "");
    // strip "(POST /api/...)" tail
    t = t.replace(/\s*\(POST\s+[^\)]+\)\s*$/i, "");
    // strip status prefix "400: "
    t = t.replace(/^\s*\d{3}\s*:\s*/g, "");
    if (/server got itself in trouble|internal server error/i.test(t)) {
      return "Сервер временно ответил с ошибкой. Попробуй ещё раз через пару секунд.";
    }
    return t.trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function isRetryableBootError(err) {
    const status = Number(err && err.status || 0);
    const raw = String((err && (err.raw || err.message)) || "");
    if (status === 0 || status === 408 || status === 425 || status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return /server got itself in trouble|internal server error|timeout|temporar/i.test(raw);
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (c) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }


  // --------------------
  // Fast avatar (placeholder + optional cache)
  // --------------------
  function initialsFromName(name) {
    const n = String(name || "").trim();
    if (!n) return "U";
    const parts = n.split(/\s+/).filter(Boolean);
    const a = parts[0] ? parts[0][0] : "U";
    const b = parts.length > 1 ? parts[1][0] : (parts[0] && parts[0].length > 1 ? parts[0][1] : "");
    return (a + (b || "")).toUpperCase();
  }

  function svgInitialAvatarDataUrl(initials) {
    const txt = encodeURIComponent(String(initials || "U").slice(0, 2));
    // Small SVG = instant render (no network)
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#00EAFF" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#FFD54A" stop-opacity="0.18"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="64" fill="#10131c"/>
  <rect width="128" height="128" rx="64" fill="url(#g)"/>
  <text x="64" y="72" text-anchor="middle" font-family="Inter, system-ui, -apple-system, Segoe UI, Arial" font-size="44" font-weight="800" fill="#EAF9FF">${decodeURIComponent(txt)}</text>
</svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ""));
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  async function tryCacheAvatar(url) {
    try {
      const prevUrl = localStorage.getItem("rc_avatar_url") || "";
      const prevData = localStorage.getItem("rc_avatar_data") || "";
      if (prevUrl === url && prevData.startsWith("data:image")) return prevData;

      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) return null;
      const blob = await res.blob();
      // don't cache huge files
      if (!blob || blob.size > 160000) return null;
      const data = await blobToDataURL(blob);
      if (data && data.startsWith("data:image")) {
        localStorage.setItem("rc_avatar_url", url);
        localStorage.setItem("rc_avatar_data", data);
        return data;
      }
    } catch (e) {}
    return null;
  }

  function loadAvatarFast(imgEl, url, displayName) {
    if (!imgEl) return;
    const initials = initialsFromName(displayName);
    const placeholder = svgInitialAvatarDataUrl(initials);
    const isLowPerf = state && state.perfMode === "low";

    // Make sure we always show something instantly
    try {
      imgEl.decoding = "async";
      imgEl.loading = isLowPerf ? "lazy" : "eager";
      imgEl.referrerPolicy = "no-referrer";
    } catch (e) {}

    imgEl.style.opacity = "0.96";
    imgEl.style.transition = isLowPerf ? "none" : "opacity .22s ease";
    imgEl.src = placeholder;

    if (!url) return;

    if (isLowPerf) {
      imgEl.src = url;
      imgEl.style.opacity = "1";
      imgEl.onerror = function () {
        imgEl.onerror = null;
        imgEl.src = placeholder;
      };
      return;
    }

    // If we have cached data-url (when CORS allows), use it immediately
    tryCacheAvatar(url).then((data) => {
      if (!data) return;
      imgEl.src = data;
      imgEl.style.opacity = "1";
    });

    // Load real image in background and swap when ready
    const pre = new Image();
    pre.decoding = "async";
    pre.src = url;
    pre.onload = () => {
      imgEl.src = url;
      imgEl.style.opacity = "1";
    };
    pre.onerror = () => {
      // keep placeholder
    };
  }
  function showToast(kind, message, title = "") {
    const stack = $("toast-stack");
    if (!stack) {
      try { if (tg && tg.showAlert) return tg.showAlert(String(message)); } catch (e) {}
      alert(String(message));
      return;
    }
    stack.style.display = "flex";
    const el = document.createElement("div");
    const k = (kind === "success") ? "rc-success" : (kind === "error") ? "rc-error" : "rc-info";
    el.className = "rc-toast " + k;
    const ico = (kind === "success") ? "✓" : (kind === "error") ? "!" : "i";
    el.innerHTML = `
      <div class="rc-ico">${ico}</div>
      <div class="rc-msg"><b style="display:block; margin-bottom:2px;">${escapeHtml(title || (kind === "error" ? "Ошибка" : kind === "success" ? "Готово" : "Сообщение"))}</b>${escapeHtml(String(message || ""))}</div>
      <button class="rc-x" aria-label="Close">×</button>
    `;
    const btn = el.querySelector(".rc-x");
    if (btn) btn.addEventListener("click", () => removeToast(el));
    stack.prepend(el);
    requestAnimationFrame(() => el.classList.add("rc-in"));
    const timeout = (kind === "error") ? 5500 : 3200;
    const tid = window.setTimeout(() => removeToast(el), timeout);
    el.dataset.tid = String(tid);
  }

  function removeToast(el) {
    if (!el) return;
    try {
      const tid = Number(el.dataset.tid || 0);
      if (tid) window.clearTimeout(tid);
    } catch (e) {}
    el.classList.remove("rc-in");
    window.setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
      const stack = $("toast-stack");
      if (stack && stack.children.length === 0) stack.style.display = "none";
    }, 180);
  }

  function hideLoader() {
    const l = $("loader");
    if (!l) return;
    l.classList.add("rc-hide");
    window.setTimeout(() => { l.style.display = "none"; }, 380);
  }

  // --------------------
  // Config: payouts (executor reward)
  // --------------------
  // NOTE: keep only active Telegram task subtypes that are supported by the current UI flow.
  const TG_TASK_TYPES = [
  { id: "sub_channel", title: "Подписка на канал", reward: 5, cost: 6, desc: "2 дня обязательного удержания. Бот проверяет, что исполнитель не вышел из канала." },
  { id: "join_group", title: "Вступление в группу", reward: 5, cost: 6, desc: "2 дня обязательного удержания. Бот проверяет, что исполнитель не вышел из группы." },
  { id: "sub_24h", title: "Тг подписка +24ч", reward: 6, cost: 7, desc: "2 дня обязательного удержания + ещё 1 день. Бот проверит участие по итогу срока." },
  { id: "sub_48h", title: "Тг подписка +48ч", reward: 7, cost: 8, desc: "2 дня обязательного удержания + ещё 2 дня. Бот проверит участие по итогу срока." },
  { id: "sub_72h", title: "Тг подписка +72ч", reward: 8, cost: 9, desc: "2 дня обязательного удержания + ещё 3 дня. Бот проверит участие по итогу срока." },
  { id: "join_group_24h", title: "Вступление в группу +24ч", reward: 6, cost: 7, desc: "2 дня обязательного удержания + ещё 1 день. Бот проверит участие по итогу срока." },
  { id: "join_group_48h", title: "Вступление в группу +48ч", reward: 7, cost: 8, desc: "2 дня обязательного удержания + ещё 2 дня. Бот проверит участие по итогу срока." },
  { id: "join_group_72h", title: "Вступление в группу +72ч", reward: 8, cost: 9, desc: "2 дня обязательного удержания + ещё 3 дня. Бот проверит участие по итогу срока." },
  ];
  const TG_BASE_RETENTION_DAYS = 2;
  const TG_EXTRA_RETENTION_REWARD_PER_DAY = 1;
  const TG_EXTRA_RETENTION_COST_PER_DAY = 3;

  // Reviews payouts you asked for
  // Reviews payouts (Updated for total cost 100/70)
  const YA = { costPer: 100, reward: 84, title: "Яндекс Карты — отзыв" };
  const GM = { costPer: 70, reward: 59, title: "Google Maps — отзыв" };
  const DG = { costPer: 15, reward: 10, title: "2GIS — отзыв" }; // User didn't specify DG, keeping original proportions

  // --------------------
  // State
  // --------------------
  const state = {
    api: "",
    initData: "",
    sessionToken: "",
    startParam: "",
    deviceHash: "",
    user: null,
    balance: { rub_balance: 0, stars_balance: 0, xp: 0, level: 1 },
    config: { stars_rub_rate: 1, stars_payments_enabled: true },
    tasks: [],
    reports: [],
    filter: "all",
    platformFilter: (localStorage.getItem("rc_platform_filter") || "all"),
    opsFilter: (localStorage.getItem("rc_ops_filter") || "all"),
    currentTask: null,
    isAdmin: false,
    isMainAdmin: false,
    adminCounts: { proofs: 0, withdrawals: 0, tbank: 0 },
    tbankCode: "",
    tbankPhoneCode: "",
    currentSection: "tasks",
    _tasksSig: "",
    _tasksRefreshTimer: null,
    perfMode: "normal",
    _syncTasksInFlight: false,
    _syncAllInFlight: false,
    _adminProofSeq: 0,
  };

  // --------------------
  // Performance mode (low / normal)
  // --------------------
  const PERF_KEY = "rc_perf_mode_v1"; // "low" | "normal" (if missing => auto-detect)

  function detectPerfMode() {
    try {
      var score = 0;

      // Respect OS/user preference first
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "low";

      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
      var effectiveType = conn && conn.effectiveType ? String(conn.effectiveType) : "";
      if (conn && conn.saveData) score += 3;
      if (/2g|3g/i.test(effectiveType)) score += 2;

      // Heuristics (best-effort; not always available in Telegram WebView)
      var mem = Number(navigator.deviceMemory || 0);
      if (mem && mem <= 2) score += 3;
      else if (mem && mem <= 4) score += 2;

      var cores = Number(navigator.hardwareConcurrency || 0);
      if (cores && cores <= 4) score += 2;
      else if (cores && cores <= 6) score += 1;

      var sw = Math.min(Number((window.screen && window.screen.width) || 0), Number(window.innerWidth || 0)) || Number((window.screen && window.screen.width) || 0) || Number(window.innerWidth || 0) || 0;
      if (sw && sw <= 430) score += 1;

      var ua = String(navigator.userAgent || "");
      var isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
      if (isMobile && (!cores || cores <= 8)) score += 2; // Aggressively force low perf on phones to prevent lag

      return score >= 2 ? "low" : "normal";
    } catch (e) {}
    return "normal";
  }

  function getInitialPerfMode() {
    const saved = (localStorage.getItem(PERF_KEY) || "").trim();
    if (saved === "low" || saved === "normal") return saved;
    return detectPerfMode();
  }

  function updatePerfModeLabel() {
    const isLow = state.perfMode === "low";
    const labelEl = $("perf-mode-label");
    const hintEl = $("perf-mode-hint");
    const chipEl = $("perf-mode-chip");
    const cardEl = document.getElementById("perf-mode-card");
    if (labelEl) labelEl.textContent = isLow ? "Экономный" : "Нормальный";
    if (hintEl) hintEl.textContent = isLow ? "меньше эффектов и анимаций" : "для плавной и красивой работы";
    if (chipEl) {
      chipEl.textContent = isLow ? "Включить плавный" : "Включить экономный";
      chipEl.setAttribute("aria-label", chipEl.textContent);
    }
    if (cardEl) {
      cardEl.classList.toggle("is-low", isLow);
      cardEl.classList.toggle("is-normal", !isLow);
    }
  }

  function applyPerfMode(mode) {
    state.perfMode = (mode === "low") ? "low" : "normal";
    try { localStorage.setItem(PERF_KEY, state.perfMode); } catch (e) {}

    // CSS hooks
    try {
      document.documentElement.classList.toggle("perf-low", state.perfMode === "low");
    } catch (e) {}

    updatePerfModeLabel();

    // Reconfigure auto-refresh with new interval
    try { startTasksAutoRefresh(); } catch (e) {}
  }

  function togglePerfMode() {
    const next = (state.perfMode === "low") ? "normal" : "low";
    applyPerfMode(next);
    tgHaptic("impact");
    tgAlert(
      "Режим: " + (state.perfMode === "low" ? "Экономный" : "Нормальный") + "\n" +
      (state.perfMode === "low" ? "Меньше анимаций и нагрузка ниже." : "Максимально плавный интерфейс."),
      "info",
      "Настройки"
    );
  }
  window.togglePerfMode = togglePerfMode;

    // --------------------
  // Theme (dark/light)
  // --------------------
  const THEME_KEY = "rc_theme_v1"; // "dark" | "light"

  function applyTheme(t) {
    const v = (t === "light") ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, v); } catch (e) {}
    document.documentElement.classList.toggle("theme-light", v === "light");
    const btn = document.getElementById("theme-toggle");
    if (btn) {
      const isLight = (v === "light");
      const iconEl = btn.querySelector(".theme-toggle-icon") || btn;
      iconEl.textContent = isLight ? "☀️" : "🌙";
      btn.classList.toggle("is-sun", isLight);
      btn.classList.toggle("is-moon", !isLight);
      btn.setAttribute("aria-label", isLight ? "Светлая тема" : "Тёмная тема");
      btn.setAttribute("aria-pressed", String(isLight));
    }
  }

  function toggleTheme() {
    const isLight = document.documentElement.classList.contains("theme-light");
    applyTheme(isLight ? "dark" : "light");
    const btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.classList.remove("theme-toggle-pop");
      void btn.offsetWidth;
      btn.classList.add("theme-toggle-pop");
      setTimeout(() => btn.classList.remove("theme-toggle-pop"), 450);
    }
    tgHaptic("impact");
  }
  window.toggleTheme = toggleTheme;



  function tasksRefreshIntervalMs() {
    // Low mode: refresh less often to save battery + CPU
    return (state.perfMode === "low") ? 60000 : 20000;
  }

  function setTasksRefreshSpinning(on) {
    const b = $("tasks-refresh-btn");
    if (!b) return;
    b.classList.toggle("spin", !!on);
  }

  async function refreshTasksBtn() {
    tgHaptic("impact");
    await syncTasksOnly(true);
  }
  window.refreshTasksBtn = refreshTasksBtn;

  // --------------------
  // API base + headers
  // --------------------
  function getApiBase() {
    const meta = document.querySelector('meta[name="api-base"]');
    let base = (meta && meta.content ? String(meta.content).trim() : "");
    if (!base) base = window.location.origin;

    // If someone accidentally set /app as base — strip it, because API routes are on root
    base = base.replace(/\/+$/, "");
    base = base.replace(/\/app$/, "");
    return base;
  }

  function apiHeaders(json = true) {
    const h = {};
    if (json) h["Content-Type"] = "application/json";
    if (state.initData) h["X-Tg-InitData"] = state.initData;
    if (state.sessionToken) h["X-Session-Token"] = state.sessionToken;
    return h;
  }

  async function apiPost(path, body) {
  const url = state.api + path;
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: apiHeaders(true),
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    const err = new Error(e && e.name === "AbortError" ? "Сервер долго отвечает. Попробуй ещё раз." : "Нет соединения с сервером");
    err.status = 0; err.path = path; throw err;
  } finally {
    window.clearTimeout(t);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) ? (data.error || data.message) : (text || (res.status + " " + res.statusText));
    const err = new Error(String(msg || "Ошибка"));
    err.status = res.status; err.path = path; err.raw = `${res.status}: ${msg} (POST ${path})`;
    throw err;
  }
  return data;
}

  async function apiPostForm(path, formData) {
  const url = state.api + path;
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), 40000);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: apiHeaders(false),
      body: formData,
      signal: ctrl.signal,
    });
  } catch (e) {
    const err = new Error(e && e.name === "AbortError" ? "Загрузка заняла слишком много времени. Попробуй ещё раз." : "Нет соединения с сервером");
    err.status = 0; err.path = path; throw err;
  } finally {
    window.clearTimeout(t);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) ? (data.error || data.message) : (text || (res.status + " " + res.statusText));
    const err = new Error(String(msg || "Ошибка"));
    err.status = res.status; err.path = path; err.raw = `${res.status}: ${msg} (POST ${path})`;
    throw err;
  }
  return data;
}
  // --------------------
  // Utils
  // --------------------
  function fmtRub(v) {
    const n = Number(v || 0);
    return (Math.round(n * 100) / 100).toLocaleString("ru-RU") + " ₽";
  }
  function fmtStars(v) {
    const n = Number(v || 0);
    return n.toLocaleString("ru-RU") + " ⭐";
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function starsRate() {
    const r = Number(state.config && state.config.stars_rub_rate);
    return r > 0 ? r : 1;
  }
  function rubToStars(amountRub) {
    const amount = Number(amountRub || 0);
    if (amount <= 0) return 0;
    return Math.max(1, Math.round(amount / starsRate()));
  }

  function starsPaymentsEnabled() {
    return !state.config || state.config.stars_payments_enabled !== false;
  }

  function renderAdminStarsToggle() {
    const modal = $("m-admin");
    if (!modal) return;
    const root = qs(".modal", modal);
    if (!root) return;

    let box = $("admin-stars-toggle");
    if (!state.isMainAdmin) {
      if (box) box.style.display = "none";
      return;
    }

    if (!box) {
      box = document.createElement("div");
      box.id = "admin-stars-toggle";
      box.className = "card";
      box.style.margin = "0 0 12px";
      box.style.padding = "12px";
      const tabs = qs(".admin-tabs", root);
      if (tabs) root.insertBefore(box, tabs);
      else root.appendChild(box);
    }

    box.style.display = "block";
    const enabled = starsPaymentsEnabled();
    box.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:900;">Оплата Stars</div>
          <div style="font-size:12px; color:var(--text-dim);">Сейчас: ${enabled ? "🟢 включена" : "🔴 выключена"}</div>
        </div>
        <button class="btn ${enabled ? "btn-danger" : "btn-main"}" type="button" onclick="adminToggleStarsPayments(${enabled ? "false" : "true"})">${enabled ? "Выключить" : "Включить"}</button>
      </div>
    `;
  }

  function applyStarsUiState() {
    const enabled = starsPaymentsEnabled();
    const starOpt = qs('#t-cur option[value="star"]');
    if (starOpt) {
      starOpt.disabled = !enabled;
      starOpt.hidden = !enabled;
    }

    const curSel = $("t-cur");
    if (curSel && !enabled && String(curSel.value || "rub").toLowerCase() === "star") {
      curSel.value = "rub";
    }

    const payStarsCard = qsa('.pay-opt').find(el => String(el.getAttribute('onclick') || '').includes("pay_stars"));
    if (payStarsCard) payStarsCard.style.display = enabled ? "" : "none";

    renderAdminStarsToggle();
    try { recalc(); } catch (e) {}
  }

  function safeText(s) {
    return String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  }

  function setActiveTab(tabId) {
    qsa(".nav-item", qs(".nav-bar")).forEach(el => el.classList.remove("active"));
    const el = $("tab-" + tabId);
    if (el) el.classList.add("active");
  }

  function showSection(id) {
    state.currentSection = id;
    // Smooth entry animation (no more "black blink")
    qsa(".app-container > section").forEach(sec => {
      sec.classList.add("hidden");
      sec.classList.remove("rc-active");
    });

    const el = $("view-" + id);
    if (el) {
      el.classList.remove("hidden");
      if (state.perfMode === "low") {
        el.classList.add("rc-active");
      } else {
        // allow CSS transition to run
        requestAnimationFrame(() => el.classList.add("rc-active"));
      }
    }
    try { setActiveTab(id); } catch (e) {}
    try { toggleFab(id === "tasks"); } catch (e) {}
  }

    function toggleFab(show) {
    const fab = document.getElementById("fab-wrap") || document.querySelector(".fab-wrap");
    if (!fab) return;
    fab.style.display = show ? "flex" : "none";
  }
  window.toggleFab = toggleFab;

  function openOverlay(id) {
    const el = $(id);
    if (!el) return;
    el.style.display = "flex";
    document.body.style.overflow = "hidden";

    // small UX hooks
    try {
      if (id === "m-create") {
        updateTopUi();
        recalc();
        scheduleTgCheck();
      }
      if (id === "m-admin") {
        // refresh current tab when opening
        switchAdminTab(state.adminTab || "proofs");
      }
    } catch (e) {}
    try { requestAnimationFrame(refreshFilterSliders); } catch (e) {}
  }

  function closeAllOverlays() {
    qsa(".overlay").forEach(el => { el.style.display = "none"; });
    document.body.style.overflow = "";
  }




  function ensureModalCloseButtons() {
    qsa('.overlay .modal').forEach(modal => {
      const hasClose = modal.querySelector('.modal-close-btn, [data-close-modal], [onclick*="closeModal()"], [onclick*="closeModal("]');
      if (hasClose) {
        modal.classList.add('modal-has-close');
        return;
      }
      modal.classList.add('modal-has-close');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-close-btn';
      btn.setAttribute('aria-label', 'Закрыть');
      btn.innerHTML = '&times;';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAllOverlays();
      });
      modal.appendChild(btn);
    });
  }

  function ensureFilterSliders() {
    try {
      const seg = qs('.tasks-seg-switch');
      if (seg && !(seg.nextElementSibling && seg.nextElementSibling.classList && seg.nextElementSibling.classList.contains('filter-slider-wrap'))) {
        const wrap = document.createElement('div');
        wrap.className = 'filter-slider-wrap is-hidden';
        wrap.setAttribute('data-kind', 'seg');
        wrap.innerHTML = '<div class="filter-slider-thumb"></div>';
        seg.insertAdjacentElement('afterend', wrap);
      }
      const pf = qs('.pf-bar');
      if (pf && !(pf.nextElementSibling && pf.nextElementSibling.classList && pf.nextElementSibling.classList.contains('filter-slider-wrap'))) {
        const wrap = document.createElement('div');
        wrap.className = 'filter-slider-wrap';
        wrap.setAttribute('data-kind', 'scroll');
        wrap.innerHTML = '<div class="filter-slider-thumb"></div>';
        pf.insertAdjacentElement('afterend', wrap);
      }
    } catch (e) {}
  }

  function updateSegmentSlider() {
    try {
      const seg = qs('.tasks-seg-switch');
      const wrap = seg ? seg.nextElementSibling : null;
      if (wrap) wrap.classList.add('is-hidden');
    } catch (e) {}
  }

  function updatePlatformSlider() {
    try {
      const bar = qs('.pf-bar');
      const wrap = bar ? bar.nextElementSibling : null;
      const thumb = wrap ? qs('.filter-slider-thumb', wrap) : null;
      if (!bar || !wrap || !thumb) return;
      const scrollable = bar.scrollWidth - bar.clientWidth;
      if (bar.classList.contains('hidden') || scrollable <= 2) {
        wrap.classList.add('is-hidden');
        return;
      }
      wrap.classList.remove('is-hidden');
      const track = wrap.clientWidth || bar.clientWidth;
      const ratio = bar.clientWidth / bar.scrollWidth;
      const thumbWidth = Math.max(32, Math.round(track * ratio));
      const maxX = Math.max(0, track - thumbWidth);
      const x = scrollable > 0 ? Math.round((bar.scrollLeft / scrollable) * maxX) : 0;
      thumb.style.width = thumbWidth + 'px';
      thumb.style.transform = 'translateX(' + x + 'px)';
    } catch (e) {}
  }

  function refreshFilterSliders() {
    updateSegmentSlider();
    updatePlatformSlider();
  }
  window.refreshFilterSliders = refreshFilterSliders;

  let _filterSliderRaf = 0;
  function scheduleRefreshFilterSliders() {
    if (_filterSliderRaf) return;
    _filterSliderRaf = requestAnimationFrame(function () {
      _filterSliderRaf = 0;
      refreshFilterSliders();
    });
  }

  function initPlatformSliderDrag() {
    try {
      const bar = qs('.pf-bar');
      const wrap = bar ? bar.nextElementSibling : null;
      const thumb = wrap ? qs('.filter-slider-thumb', wrap) : null;
      if (!bar || !wrap || !thumb || wrap.dataset.dragReady === '1') return;
      wrap.dataset.dragReady = '1';

      let dragging = false;
      let startX = 0;
      let startLeft = 0;

      const getMetrics = () => {
        const track = wrap.clientWidth || 1;
        const thumbWidth = thumb.offsetWidth || 1;
        const maxThumbX = Math.max(0, track - thumbWidth);
        const maxScroll = Math.max(0, bar.scrollWidth - bar.clientWidth);
        return { track, thumbWidth, maxThumbX, maxScroll };
      };

      const setFromClientX = (clientX) => {
        const rect = wrap.getBoundingClientRect();
        const { maxThumbX, maxScroll } = getMetrics();
        if (maxThumbX <= 0 || maxScroll <= 0) return;
        let x = clientX - rect.left - thumb.offsetWidth / 2;
        x = Math.max(0, Math.min(maxThumbX, x));
        bar.scrollLeft = (x / maxThumbX) * maxScroll;
        scheduleRefreshFilterSliders();
      };

      wrap.addEventListener('click', (e) => {
        if (dragging) return;
        if (e.target === thumb) return;
        setFromClientX(e.clientX);
      });

      thumb.addEventListener('pointerdown', (e) => {
        dragging = true;
        startX = e.clientX;
        const matrix = new DOMMatrixReadOnly(getComputedStyle(thumb).transform);
        startLeft = matrix.m41 || 0;
        wrap.classList.add('dragging');
        if (thumb.setPointerCapture) thumb.setPointerCapture(e.pointerId);
        e.preventDefault();
      });

      thumb.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const { maxThumbX, maxScroll } = getMetrics();
        if (maxThumbX <= 0 || maxScroll <= 0) return;
        let next = startLeft + (e.clientX - startX);
        next = Math.max(0, Math.min(maxThumbX, next));
        bar.scrollLeft = (next / maxThumbX) * maxScroll;
        scheduleRefreshFilterSliders();
      });

      const stopDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        wrap.classList.remove('dragging');
        try { if (thumb.releasePointerCapture) thumb.releasePointerCapture(e.pointerId); } catch (_) {}
      };
      thumb.addEventListener('pointerup', stopDrag);
      thumb.addEventListener('pointercancel', stopDrag);
      thumb.addEventListener('lostpointercapture', () => {
        dragging = false;
        wrap.classList.remove('dragging');
      });
    } catch (e) {}
  }
  function forceInitialView() {
    // Defensive: never let the app become an empty black screen
    try {
      const app = qs(".app-container");
      if (app) { app.style.display = "block"; app.style.visibility = "visible"; app.style.opacity = "1"; }
      const vt = $("view-tasks");
      if (vt) vt.classList.remove("hidden");
      try { toggleFab(true); } catch (e) {}
    } catch (e) {}
  }

  // Make closeModal global (HTML uses it)
  window.closeModal = closeAllOverlays;
  window.openModal = openOverlay;

  // close when tap outside modal
  function bindOverlayClose() {
    qsa(".overlay").forEach(ov => {
      ov.addEventListener("click", (e) => {
        if (e.target === ov) closeAllOverlays();
      });
    });
  }

  // --------------------
  // Device hash
  // --------------------
  function initDeviceHash() {
    const k = "rc_device_hash_v1";
    let v = localStorage.getItem(k);
    if (!v) {
      v = "dev_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
      localStorage.setItem(k, v);
    }
    state.deviceHash = v;
  }

  async function setUserGender(gender) {
    const g = String(gender || "").toLowerCase();
    if (g !== "male" && g !== "female") return false;
    const res = await apiPost("/api/user/gender", { gender: g });
    if (!res || !res.ok) throw new Error((res && res.error) || "Не удалось сохранить пол");
    state.user = state.user || {};
    state.user.gender = g;
    return true;
  }

  function maybeAskGender() {
    const g = String((state.user && state.user.gender) || "").toLowerCase();
    const ov = $("m-gender-onboard");
    if (!ov) return;
    if (g === "male" || g === "female") return;
    openOverlay("m-gender-onboard");
  }

  async function pickGender(gender) {
    try {
      await setUserGender(gender);
      closeAllOverlays();
      tgAlert("Пол сохранён", "success", "Готово");
    } catch (e) {
      tgAlert(String(e.message || e), "error", "Ошибка");
    }
  }
  window.pickGender = pickGender;

  // --------------------
  // Sync + render
  // --------------------
  
  // --------------------
  // Tasks auto-refresh (so new tasks appear without reopening the app)
  // --------------------
  function balanceSignature(b) {
    const x = b || {};
    return [Number(x.rub_balance||0), Number(x.stars_balance||0), Number(x.xp||0), Number(x.level||1)].join("|");
  }

  function tasksSignature(tasks) {
    try {
      const parts = (Array.isArray(tasks) ? tasks : []).map(t => {
        const id = String(t && t.id || "");
        const left = String(t && t.qty_left != null ? t.qty_left : "");
        const total = String(t && t.qty_total != null ? t.qty_total : "");
        const st = String(t && t.status != null ? t.status : "");
        return id + ":" + left + "/" + total + ":" + st;
      }).sort();
      return parts.join("|");
    } catch (e) {
      return "";
    }
  }

  async function syncTasksOnly(forceRender = false) {
    if (state._syncTasksInFlight) return;
    state._syncTasksInFlight = true;
    setTasksRefreshSpinning(true);
    try {
      const payload = { device_hash: state.deviceHash, device_id: state.deviceHash };
      const ref = state.startParam && /^\d+$/.test(state.startParam) ? Number(state.startParam) : null;
      if (ref) payload.referrer_id = ref;

      const data = await apiPost("/api/sync", payload);
      if (!data || !data.ok) return;
      if (data.auth === false) {
        state.user = null;
        state.balance = null;
        state.tasks = [];
        renderAll();
        return;
      }

      // keep user/balance fresh too
      const prevBalSig = balanceSignature(state.balance);
      state.user = data.user || state.user;
      state.balance = data.balance || state.balance;
      state.config = data.config || state.config;
    applyStarsUiState();
      applyStarsUiState();
      const newBalSig = balanceSignature(state.balance);
      const balanceChanged = prevBalSig !== newBalSig;
      const newTasks = Array.isArray(data.tasks) ? data.tasks : [];

      migrateCompletedAnonToUser();
      if (Array.isArray(data.reopen_task_ids)) {
        data.reopen_task_ids.forEach(id => unmarkTaskCompleted(id));
      }

      const newSig = tasksSignature(newTasks);
      const changed = newSig !== state._tasksSig;

      if (changed) {
        state.tasks = newTasks;
        ensureVisiblePlatformFilter(state.tasks);
        state._tasksSig = tasksSignature(state.tasks);
      }

      // render when tasks changed (Tasks tab) OR when balance/level changed (any tab)
      if (forceRender || balanceChanged || (changed && state.currentSection === "tasks")) {
        renderHeader();
        if (balanceChanged || state.currentSection === "profile") renderProfile();
        if (forceRender || state.currentSection === "tasks") renderTasks();
      }
    } catch (e) {
      // silent
    } finally {
      state._syncTasksInFlight = false;
      setTasksRefreshSpinning(false);
    }
  }

  function startTasksAutoRefresh() {
    try {
      if (state._tasksRefreshTimer) clearInterval(state._tasksRefreshTimer);
    } catch (e) {}

    // Low devices: refresh less often; also refresh only when Tasks tab is opened
    const ms = tasksRefreshIntervalMs();
    state._tasksRefreshTimer = setInterval(() => {
      if (document.hidden) return;
      if (state.currentSection !== "tasks") return;
      syncTasksOnly(false);
    }, ms);

    // Also refresh when user returns to the app (bind once)
    if (!state._tasksVisBound) {
      state._tasksVisBound = true;
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && state.currentSection === "tasks") syncTasksOnly(true);
      });
      window.addEventListener("pageshow", () => {
        if (state.currentSection === "tasks") syncTasksOnly(true);
      });
      window.addEventListener("focus", () => {
        if (state.currentSection === "tasks") syncTasksOnly(false);
      });
    }
  }

async function syncAll() {
    const payload = {
      device_hash: state.deviceHash,
      device_id: state.deviceHash,
    };

    // start_param referral (from Telegram)
    try {
      const ref = state.startParam && /^\d+$/.test(state.startParam) ? Number(state.startParam) : null;
      if (ref) payload.referrer_id = ref;
    } catch (e) {}

    const data = await apiPost("/api/sync", payload);
    if (!data || !data.ok) throw new Error("Bad /api/sync response");

    state.user = data.user;
    state.balance = data.balance || state.balance;
    state.config = data.config || state.config;
    state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    ensureVisiblePlatformFilter(state.tasks);

    // If some tasks were completed before user_id was known, migrate from anon bucket
    migrateCompletedAnonToUser();
    if (Array.isArray(data.reopen_task_ids)) {
      data.reopen_task_ids.forEach(id => unmarkTaskCompleted(id));
    }
    state._tasksSig = tasksSignature(state.tasks);

    renderHeader();
    renderProfile();
    renderInvite();
    renderTasks();
    maybeAskGender();
    await refreshWithdrawals();
    await refreshOpsSilent();
    await refreshReports();
    await refreshReferrals();
    
  await checkAdmin();
  }

  async function syncAllWithRetry() {
    const delays = [0, 700, 1600];
    let lastErr = null;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await sleep(delays[i]);
      try {
        await syncAll();
        return;
      } catch (e) {
        lastErr = e;
        if (!isRetryableBootError(e) || i === delays.length - 1) throw e;
      }
    }
    throw lastErr || new Error("Ошибка подключения");
  }

  function renderHeader() {
    const u = state.user || {};
    const name = (u.first_name || u.username || "Пользователь");
    const pic = u.photo_url || "";
    const ha = $("header-avatar");
    const hn = $("header-name");
    if (hn) hn.textContent = name;
    if (ha) {
      loadAvatarFast(ha, pic, name);
    }
  }

  function xpNeededForLevel(lvl) {
    const base = 100;
    const multiplier = 2;
    const level = Math.max(1, Number(lvl || 1));
    return Math.round(base * Math.pow(multiplier, Math.max(0, level - 1)));
  }
  function levelFromXp(xp) {
    const x = Math.max(0, Number(xp || 0));
    let lvl = 1;
    let spent = 0;
    let next = xpNeededForLevel(lvl);
    while (x >= spent + next) {
      spent += next;
      lvl += 1;
      next = xpNeededForLevel(lvl);
    }
    const cur = x - spent;
    const remaining = Math.max(0, next - cur);
    return { lvl, cur, next, remaining, totalNext: spent + next };
  }

  function renderProfile() {
    const u = state.user || {};
    const b = state.balance || {};
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "Пользователь";

    const pic = u.photo_url || "";
    const upic = $("u-pic");
    if (upic) {
      loadAvatarFast(upic, pic, name);
    }

    if ($("u-name")) $("u-name").textContent = name;
    if ($("u-bal-rub")) $("u-bal-rub").textContent = fmtRub(b.rub_balance || 0);
    if ($("u-bal-star")) $("u-bal-star").textContent = fmtStars(b.stars_balance || 0);

    const xpInfo = levelFromXp(b.xp || 0);
    const currentLevel = Number(b.level || xpInfo.lvl || 1);
    const remainingXp = Number(b.xp_remaining != null ? b.xp_remaining : xpInfo.remaining || 0);
    const nextNeedXp = Number(b.xp_next_level != null ? b.xp_next_level : xpInfo.next || 0);
    const currentProgressXp = Number(b.xp_current_level != null ? b.xp_current_level : xpInfo.cur || 0);
    if ($("u-lvl-badge")) $("u-lvl-badge").textContent = "LVL " + currentLevel;
    if ($("u-xp-cur")) $("u-xp-cur").textContent = `До LVL ${currentLevel + 1}: ${remainingXp} XP`;
    if ($("u-xp-next")) $("u-xp-next").textContent = `Нужно на уровень: ${nextNeedXp} XP`;
    const fill = $("u-xp-fill");
    if (fill) fill.style.width = clamp((currentProgressXp / Math.max(1, nextNeedXp)) * 100, 0, 100) + "%";
  }
  function renderInvite() {
    // Simple link with your bot username (can be replaced if you want)
    const botUsername = "@ReviewCashOrg_Bot";
    const myId = state.user ? state.user.user_id : "";
    const link = `https://t.me/${botUsername.replace("@", "")}?start=${myId}`;
    const el = $("invite-link");
    if (el) el.textContent = link.replace("https://", "");
    state._inviteLink = link;
  }

  
  // --------------------
  // Referrals (Friends view)
  // --------------------
  async function refreshReferrals() {
    try {
      const res = await apiPost("/api/referrals", {});
      if (res && res.ok) {
        const count = Number(res.count || 0);
        const earned = Number(res.earned_rub || 0);
        const elC = $("ref-count");
        const elE = $("ref-earn");
        if (elC) elC.textContent = String(count);
        if (elE) elE.textContent = fmtRub(earned).replace(" ₽", " ₽");
      }
    } catch (e) {
      // ignore
    }
  }
// --------------------
  // Tasks
  // --------------------

  // Completed tasks (per user) live in localStorage so they disappear after you finish them.
  // Keyed by Telegram user_id to avoid mixing different accounts on the same device.
  function completedKey() {
    const uid = state.user ? state.user.user_id : null;
    return "rc_completed_tasks_" + String(uid || "anon");
  }

  function migrateCompletedAnonToUser() {
    try {
      const uid = state.user ? state.user.user_id : null;
      if (!uid) return;
      const anonKey = "rc_completed_tasks_anon";
      const userKey = "rc_completed_tasks_" + String(uid);
      const rawAnon = localStorage.getItem(anonKey);
      if (!rawAnon) return;
      const anonArr = JSON.parse(rawAnon);
      if (!Array.isArray(anonArr) || !anonArr.length) { localStorage.removeItem(anonKey); return; }
      const rawUser = localStorage.getItem(userKey);
      const userArr = rawUser ? JSON.parse(rawUser) : [];
      const merged = new Set([...(Array.isArray(userArr) ? userArr : []).map(String), ...anonArr.map(String)]);
      localStorage.setItem(userKey, JSON.stringify(Array.from(merged)));
      localStorage.removeItem(anonKey);
    } catch (e) {}
  }

  function loadCompletedIds() {
    try {
      const raw = localStorage.getItem(completedKey());
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch (e) {
      return new Set();
    }
  }

  function saveCompletedIds(set) {
    try {
      localStorage.setItem(completedKey(), JSON.stringify(Array.from(set)));
    } catch (e) {}
  }

  function markTaskCompleted(taskId) {
    const id = String(taskId || "");
    if (!id) return;
    const set = loadCompletedIds();
    set.add(id);
    saveCompletedIds(set);
  }

  function unmarkTaskCompleted(taskId) {
    const id = String(taskId || "");
    if (!id) return;
    const set = loadCompletedIds();
    if (set.has(id)) {
      set.delete(id);
      saveCompletedIds(set);
    }
  }

  function isTaskCompleted(taskId) {
    const id = String(taskId || "");
    if (!id) return false;
    return loadCompletedIds().has(id);
  }
  function setFilter(f) {
    const mode = (f === "my" || f === "reports") ? f : "all";
    state.filter = mode;
    const fa = $("f-all"), fm = $("f-my"), fr = $("f-reports");
    if (fa) fa.classList.toggle("active", mode === "all");
    if (fm) fm.classList.toggle("active", mode === "my");
    if (fr) fr.classList.toggle("active", mode === "reports");

    const pfBar = qs(".pf-bar");
    if (pfBar) pfBar.classList.toggle("hidden", mode === "reports");

    renderTasks();
    requestAnimationFrame(refreshFilterSliders);
  }
  window.setFilter = setFilter;


  // --------------------
  // Platform filter (All / Ya / Google / TG)
  // --------------------
  function setPlatformFilter(p) {
    const v = (p === "ya" || p === "gm" || p === "dg" || p === "tg") ? p : "all";
    state.platformFilter = v;
    try { localStorage.setItem("rc_platform_filter", v); } catch (e) {}

    const ids = ["pf-all", "pf-ya", "pf-gm", "pf-dg", "pf-tg"];
    ids.forEach(id => {
      const el = $(id);
      if (!el) return;
      const want = (v === "all") ? (id === "pf-all") : (id === ("pf-" + v));
      el.classList.toggle("active", want);
    });

    renderTasks();
    requestAnimationFrame(refreshFilterSliders);
  }

  function ensureVisiblePlatformFilter(tasks) {
    try {
      const allTasks = Array.isArray(tasks) ? tasks : [];
      if (!allTasks.length) return;
      const current = String(state.platformFilter || "all");
      if (current === "all") return;
      const hasVisibleForCurrent = allTasks.some(t => String((t && (t.type || t.platform) || "")).toLowerCase() === current && Number((t && t.qty_left) || 0) > 0);
      if (hasVisibleForCurrent) return;
      setPlatformFilter("all");
    } catch (e) {}
  }
  window.setPlatformFilter = setPlatformFilter;

    function setOpsFilter(k) {
    const v = (k === "topup" || k === "earning" || k === "withdrawal") ? k : "all";
    state.opsFilter = v;
    try { localStorage.setItem("rc_ops_filter", v); } catch (e) {}

    const ids = ["ops-all", "ops-topup", "ops-earning", "ops-withdrawal"];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const want = (v === "all") ? (id === "ops-all") : (id === ("ops-" + v));
      el.classList.toggle("active", want);
    });

    try { renderOps(state._opsCache || []); } catch (e) {}
  }
  window.setOpsFilter = setOpsFilter;



  // --------------------
  // --------------------
  // Brand icons (tiny inline SVG = fast, no network)
  // --------------------
  
  // --------------------
  // Brand icons (original logos, embedded as tiny WEBP = instant, no network)
  // --------------------
  const BRAND_ICON_SVG = {
    ya: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="yaCard" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#202536"/>
            <stop offset="100%" stop-color="#0e1220"/>
          </linearGradient>
          <linearGradient id="yaGloss" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(255,255,255,.20)"/>
            <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
          </linearGradient>
          <filter id="yaShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000" flood-opacity=".28"/>
          </filter>
        </defs>

        <rect x="1.5" y="1.5" width="61" height="61" rx="17" fill="url(#yaCard)" stroke="rgba(255,255,255,.10)" stroke-width="1.5"/>
        <rect x="4.5" y="4.5" width="55" height="24" rx="12" fill="url(#yaGloss)" opacity=".55"/>

        <circle cx="32" cy="32" r="20" fill="#ff2a1c" filter="url(#yaShadow)"/>
        <circle cx="32" cy="32" r="19" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="1"/>

        <path d="M36.7 18.8h-4.1c-4.7 0-8.2 2.9-8.2 7.5 0 3.4 1.8 5.9 4.7 7.7l-6.7 10h5.7l7.5-11.5-2.1-1.5c-2.3-1.6-4.1-2.8-4.1-5 0-2.1 1.4-3.4 3.7-3.4h3v21.4h5.1V18.8h-4.5z" fill="#fff"/>
      </svg>
    `,

    gm: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="gmCard" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#202536"/>
            <stop offset="100%" stop-color="#0e1220"/>
          </linearGradient>
          <linearGradient id="gmGloss" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(255,255,255,.18)"/>
            <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
          </linearGradient>
          <filter id="gmShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000" flood-opacity=".24"/>
          </filter>
        </defs>

        <rect x="1.5" y="1.5" width="61" height="61" rx="17" fill="url(#gmCard)" stroke="rgba(255,255,255,.10)" stroke-width="1.5"/>
        <rect x="4.5" y="4.5" width="55" height="24" rx="12" fill="url(#gmGloss)" opacity=".5"/>

        <circle cx="32" cy="32" r="20.5" fill="#fff" filter="url(#gmShadow)"/>
        <circle cx="32" cy="32" r="19.5" fill="none" stroke="rgba(0,0,0,.05)" stroke-width="1"/>

        <path fill="#EA4335" d="M32 20.1c3 0 5.7 1 7.8 3l4.3-4.3C41 15.9 36.8 14 32 14c-7.5 0-14 4.3-17.2 10.6l5.3 4.1c1.3-5 5.8-8.6 11.9-8.6z"/>
        <path fill="#FBBC05" d="M20.1 28.7 14.8 24.6A18.4 18.4 0 0 0 13.3 32c0 2.6.5 5 1.5 7.3l5.3-4.1a11.7 11.7 0 0 1 0-6.5z"/>
        <path fill="#34A853" d="M32 50c4.7 0 8.7-1.6 11.6-4.4l-5.4-4.2c-1.6 1.1-3.7 1.8-6.2 1.8-5.9 0-10.8-4-12.3-9.5l-5.4 4.1C17.5 45.6 24.2 50 32 50z"/>
        <path fill="#4285F4" d="M50.1 32.8c0-1.2-.1-2.1-.3-3.1H32v7.5h10.2c-.4 2.1-1.7 3.9-4 5.1l5.4 4.2c3.2-2.9 5-7.3 5-13.7z"/>
      </svg>
    `,

    tg: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="64" height="64" rx="18" fill="#27A7E7"/><path d="M49.8 17.6 14.7 31.1c-2.4 1-2.3 2.4-.4 3l9 2.8 3.4 10.6c.4 1.2.2 1.7 1.4 1.7.9 0 1.3-.4 1.8-.9l4.4-4.3 9.1 6.7c1.7.9 2.9.4 3.3-1.6l6-28.2c.6-2.4-.9-3.5-2.9-2.6zM25.8 36.2l20.8-13.1c1-.6 1.8-.3 1.1.4L30.6 39.1l-.7 7.6-4.1-10.5z" fill="#fff"/></svg>`,
  };

function brandIconHtml(taskOrType, sizePx = 38) {
    const tRaw = (typeof taskOrType === "string") ? taskOrType : (taskOrType && (taskOrType.type || taskOrType.platform));
    const t = String(tRaw || "").toLowerCase();
    const key = (t === "ya" || t === "yandex") ? "ya" : (t === "gm" || t === "google") ? "gm" : (t === "dg" || t === "2gis" || t === "gis") ? "dg" : "tg";
    const s = Number(sizePx) || 38;
    const svg = BRAND_ICON_SVG[key] || BRAND_ICON_SVG.tg;
    const alt = (key === "ya") ? "Яндекс" : (key === "gm") ? "Google" : (key === "dg") ? "2GIS" : "Telegram";
    return `<span class="brand-svg" role="img" aria-label="${alt}" style="width:${s}px;height:${s}px;">${svg}</span>`;
  }

  function initPlatformFilterIcons() {
    const nodes = document.querySelectorAll("[data-pf-ico]");
    nodes.forEach(n => {
      const k = String(n.getAttribute("data-pf-ico") || "").toLowerCase();
      if (k === "ya" || k === "gm" || k === "dg" || k === "tg") n.innerHTML = brandIconHtml(k, 20);
    });
  }


  function taskIcon(t) {
    const type = String(t.type || "");
    if (type === "tg") return "✈️";
    if (type === "ya") return "📍";
    if (type === "gm") return "🌍";
    if (type === "dg") return "🗺️";
    return "✅";
  }

  function taskTypeLabel(t) {
    const type = String(t.type || "");
    if (type === "tg") return "Telegram";
    if (type === "ya") return "Яндекс";
    if (type === "gm") return "Google";
    if (type === "dg") return "2GIS";
    return type.toUpperCase();
  }

  function renderTasks() {
    const box = $("tasks-list");
    if (!box) return;

    const uid = state.user ? state.user.user_id : null;
    const isReports = state.filter === "reports";
    const isMy = state.filter === "my" && uid;
    let list = state.tasks.slice();

    if (isReports) {
      renderReports(box);
      return;
    }

    if (!isMy) {
      list = list.filter(t => !isTaskCompleted(t && t.id));
      list = list.filter(t => Number(t.qty_left || 0) > 0);
    } else {
      list = list.filter(t => Number(t.owner_id) === Number(uid));
    }

    if (state.platformFilter && state.platformFilter !== "all") {
      list = list.filter(t => String((t.type || t.platform || "")).toLowerCase() === state.platformFilter);
    }

    if (!list.length) {
      const hasAnyTasks = state.tasks.some(t => {
        if (isMy) return Number(t.owner_id) === Number(uid);
        return !isTaskCompleted(t && t.id) && Number(t.qty_left || 0) > 0;
      });
      if (!isMy && state.platformFilter !== "all" && hasAnyTasks) {
        box.innerHTML = `<div class="card" style="text-align:center; padding:30px 20px;">
          <div style="font-size:40px; margin-bottom:12px;">🔍</div>
          <div style="font-weight:800; font-size:16px; margin-bottom:8px;">Нет заданий по фильтру</div>
          <div style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Попробуй другую платформу или посмотри все</div>
          <button class="btn btn-main" style="margin:0 auto;" onclick="setPlatformFilter('all')">Показать все задания</button>
        </div>`;
      } else {
        box.innerHTML = `<div class="card" style="text-align:center; padding:30px 20px;">
          <div style="font-size:48px; margin-bottom:12px;">${isMy ? '📦' : '⏳'}</div>
          <div style="font-weight:800; font-size:16px; margin-bottom:8px;">${isMy ? 'Нет созданных заданий' : 'Пока нет активных заданий'}</div>
          <div style="color:var(--text-dim); font-size:13px; line-height:1.5;">${isMy ? 'Нажми ✨ «Создать» чтобы разместить первое задание' : 'Новые задания появляются регулярно.\nПопробуй обновить чуть позже ↻'}</div>
        </div>`;
      }
      return;
    }

    box.innerHTML = "";
    const frag = document.createDocumentFragment();

    list.forEach(t => {
      const left = Math.max(0, Number(t.qty_left || 0));
      const total = Math.max(left, Number(t.qty_total || 0));
      const done = Math.max(0, total - left);
      const prog = total > 0 ? Math.round((done / total) * 100) : 0;
      const reward = Number(t.reward_rub || 0);
      const budget = Number(t.cost_rub || (reward * total * 2) || 0);
      const subtypeText = tgSubtypeLabel(t) || taskTypeLabel(t);
      const topActive = isTaskTopActive(t);
      const finished = left <= 0 || String(t.status || "") !== "active";
      const isVipTask = t.vip_only || String(t.instructions || "").match(/VIP_ONLY\s*:\s*(1|true)/i);

      let badgesHtml = '';
      if (topActive) badgesHtml += `<span style="font-size:11px;font-weight:800;padding:4px 8px;border-radius:999px;background:rgba(255,180,0,.14);color:#ffd36b;margin-left:4px;">🔥 Топ</span>`;
      if (isVipTask) badgesHtml += `<span style="font-size:11px;font-weight:800;padding:4px 8px;border-radius:999px;background:rgba(168,85,247,.14);color:#c084fc;margin-left:4px;">👑 VIP Задание</span>`;

      const card = document.createElement("div");
      card.className = "card";
      card.style.padding = "14px";
      card.style.borderRadius = "18px";
      card.style.background = isMy ? "linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.02))" : "";
      card.style.cursor = isMy ? "default" : "pointer";

      if (isMy) {
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
            <div style="display:flex;gap:10px;align-items:flex-start;min-width:0;flex:1;">
              <div class="brand-box" style="width:44px;height:44px;flex:none;">${brandIconHtml(t, 40)}</div>
              <div style="min-width:0;flex:1;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <div style="font-weight:900;font-size:15px;line-height:1.2;">${safeText(t.title || "Задание")}</div>
                  ${badgesHtml}
                  <span style="font-size:11px;font-weight:800;padding:4px 8px;border-radius:999px;background:${finished ? 'rgba(255,99,132,.14);color:#ff9bb0' : 'rgba(0,234,255,.12);color:var(--accent-cyan)'};">${finished ? "Завершено" : "Активно"}</span>
                </div>
                <div style="margin-top:4px;font-size:12px;color:var(--text-dim);">${safeText(subtypeText)}</div>
              </div>
            </div>
            <div style="text-align:right;flex:none;">
              <div style="font-size:12px;color:var(--text-dim);">Бюджет</div>
              <div style="font-weight:900;font-size:16px;color:var(--accent-cyan);">${fmtRub(budget)}</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:14px;">
            ${metricChip("Выполнено", done, "#86efac")}
            ${metricChip("Осталось", left, "#93c5fd")}
            ${metricChip("Всего", total, "#fcd34d")}
            ${metricChip("Награда", fmtRub(reward), "#f9a8d4")}
          </div>
          <div style="margin-top:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <span style="font-size:12px;color:var(--text-dim);">Прогресс</span>
              <span style="font-size:12px;font-weight:800;color:var(--text);">${prog}%</span>
            </div>
            <div class="xp-track" style="height:10px;border-radius:999px;overflow:hidden;"><div class="xp-fill" style="width:${clamp(prog,0,100)}%"></div></div>
          </div>
        `;
      } else {
        card.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
            <div style="flex:1;min-width:0;">
              <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                <div class="brand-box" style="width:38px; height:38px; font-size:18px;">${brandIconHtml(t, 38)}</div>
                <div style="min-width:0;">
                  <div style="font-weight:900; font-size:14px; line-height:1.2; display:flex; align-items:center; flex-wrap:wrap;">
                    ${safeText(t.title || "Задание")}
                    ${badgesHtml}
                  </div>
                  <div style="font-size:12px; color:var(--text-dim);">${safeText(subtypeText)}</div>
                </div>
              </div>
            </div>
            <div style="font-weight:900; color:var(--accent-green); white-space:nowrap;">+${fmtRub(reward)}</div>
          </div>`;
        card.addEventListener("click", () => {
          if (isVipTask && !(state.user && state.user.is_vip)) {
            tgAlert("Это задание могут выполнять только VIP-пользователи. Перейдите в Профиль, чтобы купить статус.", "error", "Только для VIP");
            return;
          }
          openTaskDetails(t);
        });
      }

      frag.appendChild(card);
    });

    box.appendChild(frag);
  }


  function reportStatusMeta(statusRaw) {
    const status = String(statusRaw || "").toLowerCase();
    const map = {
      pending: { label: "Отправлен", badge: "st-pending", tone: "rgba(255, 204, 0, 0.16)", color: "#facc15", desc: "Отчёт отправлен и ожидает проверки модератором." },
      pending_hold: { label: "Проверяется", badge: "st-pending", tone: "rgba(0, 234, 255, 0.12)", color: "var(--accent-cyan)", desc: "Задание на удержании: бот перепроверит выполнение позже." },
      checking: { label: "Проверяется", badge: "st-pending", tone: "rgba(0, 234, 255, 0.12)", color: "var(--accent-cyan)", desc: "Отчёт сейчас на проверке." },
      paid: { label: "Прошёл", badge: "st-paid", tone: "rgba(0, 255, 136, 0.12)", color: "var(--accent-green)", desc: "Отчёт принят, награда начислена." },
      approved: { label: "Прошёл", badge: "st-paid", tone: "rgba(0, 255, 136, 0.12)", color: "var(--accent-green)", desc: "Отчёт одобрен." },
      rejected: { label: "Отказан", badge: "st-rejected", tone: "rgba(255, 75, 75, 0.12)", color: "var(--accent-red)", desc: "Отчёт отклонён модератором." },
      fake: { label: "Отказан", badge: "st-rejected", tone: "rgba(255, 75, 75, 0.12)", color: "var(--accent-red)", desc: "Отчёт отклонён: выполнение не подтверждено." },
      rework: { label: "На доработку", badge: "st-pending", tone: "rgba(255, 166, 0, 0.14)", color: "#fb923c", desc: "Нужно исправить отчёт и отправить заново." },
      rework_expired: { label: "Отказан", badge: "st-rejected", tone: "rgba(255, 75, 75, 0.12)", color: "var(--accent-red)", desc: "Срок на доработку истёк." },
    };
    return map[status] || { label: statusRaw || "Неизвестно", badge: "st-pending", tone: "rgba(148, 163, 184, 0.16)", color: "var(--text-dim)", desc: "Статус отчёта обновится позже." };
  }

  function formatReportDate(value) {
    if (!value) return "—";
    try {
      const d = new Date(value);
      if (!Number.isFinite(d.getTime())) return String(value);
      return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return String(value);
    }
  }

  async function refreshReports() {
    try {
      const res = await apiPost("/api/report/list", {});
      state.reports = Array.isArray(res && res.reports) ? res.reports : [];
      if (state.filter === "reports") renderTasks();
    } catch (e) {
      state.reports = [];
      if (state.filter === "reports") {
        const box = $("tasks-list");
        if (box) box.innerHTML = `<div class="card" style="text-align:center;color:var(--text-dim);">Не удалось загрузить отчёты.</div>`;
      }
    }
  }

  async function clearReportsHistory() {
    const reports = Array.isArray(state.reports) ? state.reports : [];
    if (!reports.length) {
      tgAlert("История отчётов уже пустая.");
      return;
    }
    const ok = await tgConfirm("Очистить историю отчётов? Это действие нельзя отменить.");
    if (!ok) return;
    try {
      const btn = document.querySelector("[data-action='clear-reports']");
      if (btn) btn.disabled = true;
      await apiPost("/api/report/clear", {});
      state.reports = [];
      renderTasks();
      tgHaptic("success");
      tgAlert("История отчётов очищена ✅");
    } catch (e) {
      tgHaptic("error");
      tgAlert(e && e.message ? e.message : "Не удалось очистить историю отчётов.", "error", "Ошибка");
    } finally {
      const btn = document.querySelector("[data-action='clear-reports']");
      if (btn) btn.disabled = false;
    }
  }

  window.clearReportsHistory = clearReportsHistory;

  function renderReports(box) {
    const reports = Array.isArray(state.reports) ? state.reports.slice() : [];
    if (!reports.length) {
      box.innerHTML = `<div class="card" style="text-align:center; color:var(--text-dim);">У вас пока нет отправленных отчётов.</div>`;
      return;
    }

    box.innerHTML = `
      <div class="report-card__toolbar">
        <button class="report-clear-btn" type="button" data-action="clear-reports" onclick="clearReportsHistory()">🗑️ Очистить историю</button>
      </div>
      ${reports.map((r) => {
      const meta = reportStatusMeta(r.status);
      const reward = Number(r.reward_rub || 0);
      const createdAt = formatReportDate(r.created_at);
      const updatedAt = formatReportDate(r.updated_at || r.moderated_at || r.created_at);
      const proofName = String(r.proof_text || "").trim();
      const moderatorComment = String(r.moderator_comment || "").trim();
      return `
        <div class="card report-card">
          <div class="report-card__head">
            <div style="display:flex; gap:10px; align-items:flex-start; min-width:0;">
              <div class="brand-box report-card__icon">${brandIconHtml(r.type || 'tg', 40)}</div>
              <div style="min-width:0; flex:1;">
                <div class="report-card__title">${safeText(r.title || "Отчёт")}</div>
                <div class="report-card__sub">${safeText(r.type_label || taskTypeLabel({ type: r.type || "tg" }))}</div>
              </div>
            </div>
            <div class="report-card__reward">+${fmtRub(reward)}</div>
          </div>

          <div class="report-card__status" style="background:${meta.tone}; color:${meta.color};">${meta.label}</div>
          <div class="report-card__desc">${meta.desc}</div>

          <div class="report-card__grid">
            <div class="report-card__cell">
              <div class="report-card__label">Отправлен</div>
              <div class="report-card__value">${createdAt}</div>
            </div>
            <div class="report-card__cell">
              <div class="report-card__label">Обновлён</div>
              <div class="report-card__value">${updatedAt}</div>
            </div>
            <div class="report-card__cell">
              <div class="report-card__label">Ник / комментарий</div>
              <div class="report-card__value">${safeText(proofName || "—")}</div>
            </div>
            <div class="report-card__cell">
              <div class="report-card__label">Скрин</div>
              <div class="report-card__value">${r.proof_url ? `<a href="${safeText(r.proof_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan); text-decoration:none; font-weight:800;">Открыть</a>` : "—"}</div>
            </div>
            ${moderatorComment ? `<div class="report-card__cell" style="grid-column:1 / -1;"><div class="report-card__label">Причина / комментарий модератора</div><div class="report-card__value">${safeText(moderatorComment)}</div></div>` : ""}
          </div>
        </div>
      `;
    }).join("")}
    `;
  }

  function metricChip(label, value, tint) {
    return `<div style="background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:10px 8px;min-width:0;">
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">${label}</div>
      <div style="font-size:14px;font-weight:900;color:${tint || 'var(--text)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${value}</div>
    </div>`;
  }

  function tgSubtypeLabel(task) {
    const map = {
      sub_channel: "Telegram · Подписка на канал",
      sub_24h: "Telegram · Подписка на канал +24ч",
      sub_48h: "Telegram · Подписка на канал +48ч",
      sub_72h: "Telegram · Подписка на канал +72ч",
      join_group: "Telegram · Вступление в группу",
      join_group_24h: "Telegram · Вступление в группу +24ч",
      join_group_48h: "Telegram · Вступление в группу +48ч",
      join_group_72h: "Telegram · Вступление в группу +72ч",
    };
    const sid = String((task && task.tg_subtype) || "").trim();
    return map[sid] || "";
  }

  function isTaskTopActive(task) {
    const raw = String((task && (task.top_active_until || task._top_active_until)) || "").trim();
    if (!raw) return false;
    const ts = Date.parse(raw);
    return Number.isFinite(ts) && ts > Date.now();
  }

  function normalizeUrl(u) {
    let s = String(u || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    return s;
  }


  function openTaskLink(url) {
    const link = String(url || "").trim();
    if (!link) return;
    try {
      if (window.Telegram && window.Telegram.WebApp) {
        const tg = window.Telegram.WebApp;
        if (tg.openTelegramLink && /^https?:\/\/(t\.me|telegram\.me)\//i.test(link)) {
          tg.openTelegramLink(link);
          return;
        }
        if (tg.openLink) {
          tg.openLink(link, { try_instant_view: false });
          return;
        }
      }
    } catch (e) {}
    // fallback
    try { window.open(link, "_blank"); } catch (e) { window.location.href = link; }
  }

  function isProbablyUrl(raw) {
    const s = String(raw || "").trim();
    if (!s) return false;
    if (/\s/.test(s)) return false;
    if (/^https?:\/\//i.test(s)) return true;
    return /^[a-z0-9][a-z0-9\-_.]*\.[a-z]{2,}/i.test(s);
  }
  function isYandexMapsUrl(u) {
    try {
      const url = new URL(normalizeUrl(u));
      const h = url.hostname.toLowerCase();
      const p = url.pathname.toLowerCase();
      if (!h.includes("yandex")) return false;
      return p.includes("/maps") || p.includes("/profile") || h.includes("maps");
    } catch (e) { return false; }
  }
  function isGoogleMapsUrl(u) {
    try {
      const url = new URL(normalizeUrl(u));
      const h = url.hostname.toLowerCase();
      const p = url.pathname.toLowerCase();
      if (h === "maps.app.goo.gl" || h === "goo.gl") return true;
      if (!h.includes("google")) return false;
      return p.includes("/maps") || h.startsWith("maps.");
    } catch (e) { return false; }
  }
  function is2GisUrl(u) {
    try {
      const url = new URL(normalizeUrl(u));
      const h = url.hostname.toLowerCase();
      if (h === "go.2gis.com") return true;
      return h.includes("2gis");
    } catch (e) { return false; }
  }
  function isTaskOwner(task) {
    const uid = state.user ? state.user.user_id : null;
    if (!uid || !task) return false;
    if (task.is_owner === true) return true;
    if (task.owner_id != null && Number(task.owner_id) === Number(uid)) return true;
    return false;
  }

  function openTaskDetails(task) {
    state.currentTask = task;

    const isOwner = isTaskOwner(task);

    $("td-title").textContent = task.title || "Задание";
    $("td-reward").textContent = "+" + fmtRub(task.reward_rub || 0);
    const _ico = $("td-icon");
    if (_ico) { _ico.classList.add("rc-icon"); _ico.innerHTML = brandIconHtml(task, 56); }
    $("td-type-badge").textContent = taskTypeLabel(task);
    $("td-link").textContent = task.target_url || "";
    $("td-text").innerHTML = (isOwner ? `<div style="margin-bottom:10px;color:var(--accent-red);font-weight:800;">⚠️ Это ваше задание. Выполнить и получить награду нельзя.</div>` : "") + renderTaskInstructionHtml(task);

    // proof blocks
    const isAuto = String(task.check_type || "") === "auto" && String(task.type || "") === "tg";
    const ackWrap = $("td-important-ack-wrap");
    const ackCheckbox = $("td-important-ack");
    const hasImportantNote = !!getTaskImportantNote(task);
    const needsAck = !isOwner && !isAuto && hasImportantNote;
    if (ackCheckbox) ackCheckbox.checked = false;
    if (ackWrap) ackWrap.classList.toggle("hidden", !needsAck);

    const link = normalizeUrl(task.target_url || "");
    const a = $("td-link-btn");
    if (a) {
      a.href = link || "#";
      a.onclick = async (ev) => {
        try { ev.preventDefault(); } catch(e) {}
        if (!link) return;
        try { await apiPost("/api/task/click", { task_id: task.id }); } catch (e) {}
        openTaskLink(link);
      };
    }

    const manual = $("proof-manual");
    const auto = $("proof-auto");
    if (manual) manual.classList.toggle("hidden", isAuto);
    if (auto) auto.classList.toggle("hidden", !isAuto);

    // set nickname label + placeholder for reviews
    const nickInput = $("p-username");
    const fileInput = $("p-file");
    if (nickInput) {
      const t = String(task.type || "");
      const isReview = (t === "ya" || t === "gm" || t === "dg");
      const label = manual ? manual.querySelector("label.input-label") : null;
      if (label) label.textContent = isReview ? "Никнейм автора отзыва (как в сервисе)" : "Ваш Никнейм / Имя";

      nickInput.placeholder = isReview ? "Например: Я.К." : "Пример: Alex99";

      // Prefill: use last saved for this platform, else Telegram name
      let key = "rc_last_nick_generic";
      if (t === "ya") key = "rc_last_nick_ya";
      if (t === "gm") key = "rc_last_nick_gm";
      if (t === "dg") key = "rc_last_nick_dg";
      const saved = localStorage.getItem(key);
      if (saved) nickInput.value = saved;
      else {
        const tu = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) ? tg.initDataUnsafe.user : null;
        nickInput.value = (tu && (tu.username || tu.first_name)) ? (tu.username || tu.first_name) : "";
      }
    }

    if (fileInput) {
      fileInput.value = "";
      updateFileName(fileInput);
    }

    // action button
    const btn = $("td-action-btn");
    if (btn) {
      if (isOwner) {
        btn.textContent = "🚫 Нельзя выполнять своё задание";
        btn.disabled = true;
        btn.style.opacity = "0.65";
      } else {
        if (isAuto) {
          btn.textContent = "✅ Проверить и получить награду";
          btn.onclick = () => submitTaskAuto(task);
        } else {
          btn.textContent = "📤 Отправить отчёт";
          btn.onclick = () => submitTaskManual(task);
        }
        updateTaskActionState(task, isOwner, isAuto);
      }
    }

    openOverlay("m-task-details");
  }


  function getTaskInstructionText(task) {
    const subtype = String((task && task.tg_subtype) || "").trim();
    const retentionDays = Number((task && task.retention_days) || 0) || tgTotalRetentionDays(subtype, 0);
    const map = {
      sub_channel: `Подпишитесь на Telegram-канал и оставайтесь подписанным ${retentionDays} дн. Если выйти раньше — будет штраф.`,
      sub_24h: `Подпишитесь на Telegram-канал и оставайтесь подписанным ${retentionDays} дн. Бот перепроверит участие автоматически.`,
      sub_48h: `Подпишитесь на Telegram-канал и оставайтесь подписанным ${retentionDays} дн. Бот перепроверит участие автоматически.`,
      sub_72h: `Подпишитесь на Telegram-канал и оставайтесь подписанным ${retentionDays} дн. Бот перепроверит участие автоматически.`,
      join_group: `Вступите в Telegram-группу и не выходите ${retentionDays} дн. Если выйти раньше — будет штраф.`,
      join_group_24h: `Вступите в Telegram-группу и не выходите ${retentionDays} дн. Бот перепроверит участие автоматически.`,
      join_group_48h: `Вступите в Telegram-группу и не выходите ${retentionDays} дн. Бот перепроверит участие автоматически.`,
      join_group_72h: `Вступите в Telegram-группу и не выходите ${retentionDays} дн. Бот перепроверит участие автоматически.`,
    };
    const raw = String((task && task.instructions) || "");
    const cleaned = raw
      .replace(/(^|\n)\s*(TG_SUBTYPE|TARGET_GENDER|CUSTOM_REVIEW_MODE|CUSTOM_REVIEW_TEXTS)\s*:\s*.*(?=\n|$)/ig, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return cleaned || map[subtype] || "Выполните задание и нажмите кнопку проверки.";
  }

  function getTaskReviewTexts(task) {
    const arr = Array.isArray(task && task.custom_review_texts) ? task.custom_review_texts : [];
    return arr.map(x => String(x || "").trim()).filter(Boolean);
  }
  function getTaskImportantNote(task) {
    const raw = String((task && task.instructions) || "");
    const cleaned = raw
      .replace(/(^|\n)\s*(TG_SUBTYPE|TARGET_GENDER|CUSTOM_REVIEW_MODE|CUSTOM_REVIEW_TEXTS)\s*:\s*.*(?=\n|$)/ig, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return cleaned;
  }


  function buildPrettyTaskInstruction(task) {
    const type = String((task && task.type) || "").trim();
    const isMaps = type === "ya" || type === "gm" || type === "dg";
    const place = type === "ya" ? "Яндекс" : (type === "gm" ? "Google" : (type === "dg" ? "2GIS" : ""));
    const steps = [
      "Открой приложение",
      "Выбери задание",
      "Нажми «Перейти к выполнению»",
      "Выполни все действия из инструкции ниже",
      "Отправь отчёт",
      "Получи оплату после проверки"
    ];
    const commonHtml = `<div class="task-guide-card"><div class="task-guide-title">🚀 Как выполнить задание</div>${steps.map((step, i) => `<div class="task-guide-step"><span class="task-guide-step-num">${i + 1}</span><span>${safeText(step)}</span></div>`).join("")}</div>`;
    if (!isMaps) return commonHtml;
    const reviewBullets = [
      "Поставь лайк 5 положительным отзывам.",
      "Поставь лайк 5 фото, если они есть.",
      "Если указан сайт — обязательно зайди на него.",
      "Построй любой маршрут до этого места.",
      "Только после этого напиши естественный отзыв без мата и спама."
    ];
    const mapsHtml = `<div class="task-guide-card task-guide-card--maps"><div class="task-guide-title">📝 ${place} отзывы</div><div class="task-guide-note">Чтобы отзыв прошёл проверку, сделай так:</div><div class="task-guide-bullets">${reviewBullets.map((item) => `<div class="task-guide-bullet">— ${safeText(item)}</div>`).join("")}</div><div class="task-guide-tip">✨ Потом оставь нормальный живой отзыв и не удаляй его.</div></div>`;
    return `${commonHtml}${mapsHtml}`;
  }

  function renderTaskInstructionHtml(task) {
    const prettyInstruction = buildPrettyTaskInstruction(task);
    const importantTextRaw = getTaskImportantNote(task);
    const importantText = safeText(importantTextRaw);
    const importantBlock = importantText ? `<div class="important-task-note"><div class="important-task-note__title">⚠️ Важно от заказчика</div><div class="important-task-note__text">${importantText}</div></div>` : "";
    const baseText = importantText ? "" : safeText(getTaskInstructionText(task));
    const base = baseText ? `<div class="task-info-card"><div class="task-info-title">Текст</div><div>${baseText}</div></div>` : "";
    const reviewTexts = getTaskReviewTexts(task);
    const mode = String((task && task.custom_review_mode) || "none");
    if (!reviewTexts.length || !["single", "per_item"].includes(mode)) {
      return `${prettyInstruction}${importantBlock}${base || (!importantBlock ? safeText(getTaskInstructionText(task)) : "")}`;
    }
    const heading = "Текст отзыва";
    const items = reviewTexts.map((text) => `<button type="button" class="review-text-item review-text-copy" onclick="copyTaskReviewText(this)" data-review-text="${encodeURIComponent(String(text || ''))}"><span class="review-text-index">★</span><span class="review-text-content">${safeText(text)}</span><span class="review-text-copy-icon">📋</span></button>`).join("");
    const reviewCard = `<div class="review-text-card"><div class="review-text-title">${heading}</div>${items}</div>`;
    return `${prettyInstruction}${importantBlock}${base}${reviewCard}`;
  }

  window.copyTaskReviewText = async function (el) {
    try {
      const encoded = el && el.dataset ? String(el.dataset.reviewText || "") : "";
      const text = decodeURIComponent(encoded || "").trim();
      const ok = await copyText(text);
      if (ok && el) {
        el.classList.add("copied");
        const icon = el.querySelector(".review-text-copy-icon");
        const prev = icon ? icon.textContent : "";
        if (icon) icon.textContent = "✅";
        setTimeout(() => {
          el.classList.remove("copied");
          if (icon) icon.textContent = prev || "📋";
        }, 1200);
      }
      return ok;
    } catch (e) {
      return false;
    }
  };

  function taskImportantAckReady() {
    const wrap = $("td-important-ack-wrap");
    if (!wrap || wrap.classList.contains("hidden")) return true;
    const checkbox = $("td-important-ack");
    return !!(checkbox && checkbox.checked);
  }

  function updateTaskActionState(task, isOwner, isAuto) {
    const btn = $("td-action-btn");
    if (!btn) return;
    if (isOwner) {
      btn.disabled = true;
      btn.style.opacity = "0.65";
      return;
    }
    if (isAuto) {
      btn.disabled = false;
      btn.style.opacity = "1";
      return;
    }
    const ready = taskImportantAckReady();
    btn.disabled = !ready;
    btn.style.opacity = ready ? "1" : "0.65";
  }

  window.toggleTaskImportantAck = function () {
    if (!state.currentTask) return;
    updateTaskActionState(state.currentTask, isTaskOwner(state.currentTask), String(state.currentTask.check_type || "") === "auto" && String(state.currentTask.type || "") === "tg");
  };

  window.copyLink = function () {
    const el = $("td-link");
    const text = el ? el.textContent : "";
    copyText(text);
  };

  window.copyPhoneNumber = function (event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    const trigger = event && event.currentTarget ? event.currentTarget : null;
    const rawPhone = trigger && trigger.dataset ? trigger.dataset.copyPhone : "";
    const phone = String(rawPhone || "+79600738559").replace(/[^\d+]/g, "");
    return copyText(phone);
  };

  async function copyText(text) {
    const s = String(text || "").trim();
    if (!s) return false;

    const fallbackCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.setAttribute("readonly", "readonly");
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      ta.style.width = "1px";
      ta.style.height = "1px";
      ta.style.padding = "0";
      ta.style.border = "0";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      document.body.appendChild(ta);
      ta.focus({ preventScroll: true });
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    };

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(s);
      } else if (!fallbackCopy()) {
        throw new Error("clipboard_unavailable");
      }
      tgHaptic("success");
      tgAlert("Скопировано ✅");
      return true;
    } catch (e) {
      try {
        if (!fallbackCopy()) throw new Error("copy_failed");
        tgHaptic("success");
        tgAlert("Скопировано ✅");
        return true;
      } catch (err) {
        tgHaptic("error");
        tgAlert("Не удалось скопировать. Зажмите номер и скопируйте вручную.", "error", "Ошибка копирования");
        return false;
      }
    }
  }

  // Required by HTML
  window.updateFileName = function (input) {
    const label = $("p-filename");
    if (!label) return;
    const f = input && input.files && input.files[0] ? input.files[0] : null;
    label.textContent = f ? ("📷 " + f.name) : "📷 Прикрепить скриншот";
  };

  async function submitTaskAuto(task) {
    if (submitTaskAuto._busy) return;
    if (isTaskOwner(task)) {
      tgHaptic("error");
      return tgAlert("Нельзя выполнять своё задание");
    }
    try {
      submitTaskAuto._busy = true;
      tgHaptic("impact");
      const res = await apiPost("/api/task/submit", { task_id: String(task.id) });
      if (res && res.ok) {
        if (String(res.status || "").startsWith("hold_")) {
          tgHaptic("success");
          const fallback = "Подписка подтверждена. Бот перепроверит участие позже автоматически.";
          tgAlert(String(res.message || fallback), "info", "Удержание подписки");
          closeAllOverlays();
          await syncAll();
          return;
        }
        // Make the task disappear right away for this user
        markTaskCompleted(task.id);
        state.tasks = state.tasks.filter(t => String(t.id) !== String(task.id));
        renderTasks();
        closeAllOverlays();
        tgHaptic("success");
        tgAlert("Готово! Начислено: +" + fmtRub(res.earned || task.reward_rub || 0));
        await syncAll();
      } else {
        throw new Error(res && res.error ? res.error : "Ошибка проверки");
      }
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e));
    } finally {
      submitTaskAuto._busy = false;
    }
  }
  async function uploadProof(file, taskId) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("task_id", String(taskId || ""));
    const res = await apiPostForm("/api/proof/upload", fd);
    if (!res || !res.ok || !res.url) throw new Error("Upload failed");
    return String(res.url);
  }

  function normalizePhoneForTbank(v) {
    const digits = String(v || "").replace(/\D/g, "");
    if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) return "7" + digits.slice(1);
    if (digits.length === 10) return "7" + digits;
    return digits;
  }

  window.updateTBankFileName = function (input) {
    const label = $("tb-filename");
    if (!label) return;
    const f = input && input.files && input.files[0] ? input.files[0] : null;
    label.textContent = f ? ("📷 " + f.name) : "📷 Прикрепить скрин оплаты";
  };

  window.updateTBankPhoneFileName = function (input) {
    const label = $("tbp-filename");
    if (!label) return;
    const f = input && input.files && input.files[0] ? input.files[0] : null;
    label.textContent = f ? ("📷 " + f.name) : "📷 Прикрепить скрин оплаты";
  };

  async function submitTaskManual(task) {
    if (submitTaskManual._busy) return;
    if (isTaskOwner(task)) {
      tgHaptic("error");
      return tgAlert("Нельзя выполнять своё задание");
    }
    const nick = String(($("p-username") && $("p-username").value) || "").trim();
    const file = $("p-file") && $("p-file").files ? $("p-file").files[0] : null;

    if (!nick) return tgAlert("Напиши никнейм/имя, как в сервисе.\nПример: Я.К.", "error", "Нужен никнейм");
    if (!taskImportantAckReady()) return tgAlert("Подтверди, что ознакомился с важной информацией от заказчика.", "error", "Нужно подтверждение");

    // REQUIRED IMAGE (you asked)
    if (!file) return tgAlert("Нужен скриншот-доказательство.\nБез скрина отправить нельзя.", "error", "Прикрепи скрин");

    // lightweight validation for image type
    if (file && file.type && !/^image\//i.test(file.type)) {
      return tgAlert("Можно прикреплять только изображения");
    }

    try {
      submitTaskManual._busy = true;
      tgHaptic("impact");

      // 1) upload image -> get public URL
      const proofUrl = await uploadProof(file, task.id);

      // 2) submit completion
      const proofText = nick;
      const res = await apiPost("/api/task/submit", {
        task_id: String(task.id),
        proof_text: proofText,
        proof_url: proofUrl,
      });

      if (res && res.ok) {
        // Hide the task right away locally; server sync will keep it hidden while report is pending
        state.tasks = state.tasks.filter(t => String(t.id) !== String(task.id));
        renderTasks();
        // save nickname per platform so user doesn't type every time
        const t = String(task.type || "");
        let key = "rc_last_nick_generic";
        if (t === "ya") key = "rc_last_nick_ya";
        if (t === "gm") key = "rc_last_nick_gm";
      if (t === "dg") key = "rc_last_nick_dg";
        localStorage.setItem(key, nick);

        closeAllOverlays();
        tgHaptic("success");
        tgAlert("Отчёт отправлен ✅ Ожидай проверки модератором.");
        await syncAll();
      } else {
        throw new Error(res && res.error ? res.error : "Ошибка отправки");
      }
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e));
    } finally {
      submitTaskManual._busy = false;
    }
  }

  // --------------------
  // Create task + pricing
  // --------------------
  function initTgSubtypeSelect() {
    const sel = $("t-tg-subtype");
    if (!sel) return;

    const prevValue = String(sel.value || "");
    const available = TG_TASK_TYPES.filter(t => !TG_MANUAL_ONLY.has(t.id));

    sel.innerHTML = "";
    available.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.title} — ${t.reward}₽`;
      opt.dataset.reward = String(t.reward);
      opt.dataset.desc = t.desc;
      sel.appendChild(opt);
    });

    if (!available.length) return;
    sel.value = available.some(t => t.id === prevValue) ? prevValue : available[0].id;
  }

  function updateCreateTypeLabels() {
    const sel = $("t-type");
    if (!sel) return;
    const yaOpt = sel.querySelector('option[value="ya"]');
    const gmOpt = sel.querySelector('option[value="gm"]');
    const dgOpt = sel.querySelector('option[value="dg"]');
    if (yaOpt) yaOpt.textContent = `📍 Яндекс Карты (${YA.costPer}₽)`;
    if (gmOpt) gmOpt.textContent = `🌍 Google Maps (${GM.costPer}₽)`;
    if (dgOpt) dgOpt.textContent = `🗺️ 2GIS (${DG.costPer}₽)`;
  }

  function currentCreateType() {
    const t = $("t-type");
    return t ? String(t.value || "tg") : "tg";
  }

  function currentTgSubtype() {
    const sel = $("t-tg-subtype");
    return sel ? String(sel.value || "") : "";
  }

  function parseTgChatFromUrl(url) {
    const u = String(url || "").trim();
    const m = u.match(/(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]+)/i);
    if (m && m[1]) return "@" + m[1];
    return null;
  }


  // --------------------
  // TG target live check (nice animation)
  // --------------------
  let _tgCheckTimer = null;
  let _tgCheckSeq = 0;
  state._tgCheck = { value: "", valid: false, chat: null, msg: "", forceManual: false };

  function currentRetentionExtraDays() {
    return clamp(Number(($("t-retention-extra") && $("t-retention-extra").value) || 0), 0, 30);
  }

  function tgSubtypeBonusDays(subtype) {
    const sid = String(subtype || "").trim();
    if (sid.endsWith("24h")) return 1;
    if (sid.endsWith("48h")) return 2;
    if (sid.endsWith("72h")) return 3;
    return 0;
  }

  function tgTotalRetentionDays(subtype, extraDays = currentRetentionExtraDays()) {
    return TG_BASE_RETENTION_DAYS + tgSubtypeBonusDays(subtype) + clamp(Number(extraDays || 0), 0, 30);
  }

  function getCustomReviewTexts() {
    const raw = String(($("t-review-variants") && $("t-review-variants").value) || "").trim();
    if (!raw) return [];
    return raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
  }

  function getCustomReviewMode() {
    const mode = String(($("t-review-mode") && $("t-review-mode").value) || "none").trim();
    return ["none", "single", "per_item"].includes(mode) ? mode : "none";
  }

  function syncReviewTextsHint() {
    const type = currentCreateType();
    const wrap = $("review-text-config");
    const helper = $("review-variants-helper");
    const badge = $("review-mode-badge");
    const textarea = $("t-review-variants");
    const mode = getCustomReviewMode();
    const isReviewType = (type === "ya" || type === "gm" || type === "dg");

    if (wrap) {
      wrap.classList.toggle("hidden", !isReviewType);
      wrap.dataset.mode = isReviewType ? mode : "hidden";
    }
    if (!helper || !isReviewType) return;

    const qty = clamp(Number(($("t-qty") && $("t-qty").value) || 1), 1, 1000000);
    const lines = getCustomReviewTexts().length;

    if (mode === "single") {
      if (badge) badge.textContent = "👥 Один текст получат все";
      helper.textContent = "Напиши один готовый отзыв. Этот же текст увидят все исполнители. Используй только если специально нужен одинаковый текст для всех.";
      if (textarea) {
        textarea.placeholder = "Напиши 1 готовый текст отзыва.\nИменно этот текст получат все исполнители.";
        textarea.rows = 4;
      }
    } else if (mode === "per_item") {
      if (badge) badge.textContent = `🔥 Разный текст: ${lines}/${qty} строк`;
      helper.textContent = `Внимание: каждая новая строка — это отдельный отзыв для одного исполнителя. Сейчас заказано ${qty} шт., поэтому нужно минимум ${qty} разных строк.`;
      if (textarea) {
        textarea.placeholder = "Каждая новая строка = отдельный отзыв.\nПример 1: Уютное место, всё понравилось.\nПример 2: Быстро обслужили, приду ещё раз.";
        textarea.rows = Math.max(5, Math.min(8, qty));
      }
    } else {
      if (badge) badge.textContent = "🚫 Готовый текст не задан";
      helper.textContent = "Можно ничего не писать. Но если хочешь выдать исполнителям готовые тексты, выбери режим выше — особенно удобно для варианта «разный текст для каждого отзыва».";
      if (textarea) {
        textarea.placeholder = "Здесь можно оставить готовые тексты отзывов, если они нужны заказу.";
        textarea.rows = 4;
      }
    }
  }

  function normalizeTgChatInput(v) {
    const s = String(v || "").trim();
    if (!s) return null;
    // @username
    const at = s.match(/^@([A-Za-z0-9_]{3,})$/);
    if (at && at[1]) return "@" + at[1];
    // t.me/username
    const m = s.match(/(?:https?:\/\/)?t\.me\/(?:s\/)?([A-Za-z0-9_]{3,})/i);
    if (m && m[1]) return "@" + m[1];
    return null;
  }

  const TG_MANUAL_ONLY = new Set([]);

  function tgIsBotTarget(rawTarget, tgChat) {
    const raw = String(rawTarget || "").trim();
    const rawL = raw.toLowerCase();
    const chat = String(tgChat || "").trim().toLowerCase().replace(/^@/, "");

    // Username-based detection: @something_bot or ...bot
    if (chat && (chat.endsWith("bot") || chat.endsWith("_bot"))) return true;
    if (rawL.match(/^@?[a-z0-9_]+bot /i)) return true;

    // Links to bots
    if (rawL.includes("t.me/") && rawL.match(/t\.me\/(?:s\/)?[a-z0-9_]+bot /i)) return true;

    // Any start parameter or explicit /start mention -> bot flow
    if (rawL.includes("?start=") || rawL.includes("&start=") || rawL.includes("/start")) return true;

    return false;
  }

  function tgTargetToUrl(rawTarget) {
    const s = String(rawTarget || "").trim();
    if (!s) return "";
    if (/t\.me\//i.test(s)) return normalizeUrl(s);
    const m = s.match(/^@([A-Za-z0-9_]{3,})$/);
    if (m && m[1]) return "https://t.me/" + m[1];
    return normalizeUrl(s);
  }

  function tgNeedsChat(subType) {
    return ["sub_channel","join_group","sub_24h","sub_48h","sub_72h","join_group_24h","join_group_48h","join_group_72h"].includes(subType);
  }

  function tgAutoPossible(subType, tgKind) {
    if (!tgNeedsChat(subType)) return false;
    if (tgKind !== "chat") return false;
    return true;
  }

  function setTargetStatus(kind, title, desc) {
    const box = $("t-target-status");
    if (!box) return;
    const k = String(kind || "");
    box.className = "input-status" + (k ? " is-" + k : "");

    if (!title) {
      box.innerHTML = "";
      return;
    }

    box.style.display = "";

    const spinner = k === "loading" ? '<span class="st-spin" aria-hidden="true"></span>' : "";
    const ico = k === "ok" ? "✅" : k === "err" ? "⚠️" : k === "loading" ? "" : "";

    box.innerHTML = `
      <div class="st-row">${spinner}<span class="st-ico">${ico}</span><span class="st-title">${escapeHtml(title)}</span></div>
      ${desc ? `<div class="st-desc">${escapeHtml(desc)}</div>` : ""}
    `;
  }

  function updateTgHint() {
    const wrap = $("tg-options");
    if (!wrap) return;

    const type = currentCreateType();
    if (type !== "tg") {
      try { wrap.classList.add("hidden"); } catch (e) {}
      return;
    }
    try { wrap.classList.remove("hidden"); } catch (e) {}

    const sid = currentTgSubtype();
    const raw = $("t-target") ? String($("t-target").value || "") : "";
    const chat = normalizeTgChatInput(raw);
    const tgKind = tgIsBotTarget(raw, chat) ? "bot" : "chat";

    let manual = (tgKind === "bot") || TG_MANUAL_ONLY.has(sid) || !tgAutoPossible(sid, tgKind);

    try {
      if (chat && state._tgCheck && state._tgCheck.chat === chat && state._tgCheck.forceManual) manual = true;
    } catch (e) {}

    // Find hint elements. Prefer ids, but fall back to first <b> and text inside tg-options.
    let titleEl = $("tg-check-hint-title");
    let textEl = $("tg-check-hint-text");
    if (!titleEl || !textEl) {
      const b = wrap.querySelector("b");
      if (b) titleEl = b;
      const div = wrap.querySelector("div");
      if (div) {
        let sp = div.querySelector("span");
        if (!sp) {
          sp = document.createElement("span");
          div.appendChild(sp);
        }
        textEl = sp;
      }
    }

    if (!titleEl || !textEl) return;

    if (manual) {
      titleEl.textContent = "🛡️ Ручная проверка:";
      textEl.textContent = "Нужно отправить скрин/доказательства. Автоматически это не проверить.";
      try {
        wrap.style.background = "rgba(255, 60, 120, 0.08)";
        wrap.style.borderColor = "rgba(255, 60, 120, 0.22)";
      } catch (e) {}
    } else {
      titleEl.textContent = "⚡ Автоматическая проверка:";
      const sidNow = currentTgSubtype();
      const totalDays = tgTotalRetentionDays(sidNow);
      textEl.textContent = `После вступления выходить нельзя ${totalDays} дн. Бот проверит участие в конце срока автоматически. Если исполнитель выйдет раньше — выплата отменится и включится штраф.`;
      try {
        wrap.style.background = "rgba(0,234,255,0.05)";
        wrap.style.borderColor = "var(--glass-border)";
      } catch (e) {}
    }

    let warnEl = $("tg-retention-warning");
    if (!warnEl) {
      warnEl = document.createElement("div");
      warnEl.id = "tg-retention-warning";
      warnEl.style.cssText = "margin-top:8px;font-size:13px;line-height:1.35;color:#ffb74d;background:rgba(255,183,77,.08);border:1px solid rgba(255,183,77,.18);padding:8px 10px;border-radius:10px;";
      wrap.appendChild(warnEl);
    }
    warnEl.textContent = `⚠️ Условия удержания: минимум ${tgTotalRetentionDays(sid)} дн. без выхода. Если исполнитель покинет канал/группу раньше срока, бот это зафиксирует, отменит оплату и выдаст штраф.`;
    warnEl.style.display = "block";
  }

  async function runTgCheckNow(rawValue) {
    const type = currentCreateType();
    const value = String(rawValue || "").trim();

    if (type !== "tg") {
      setTargetStatus("", "", "");
      return;
    }

    const sid = currentTgSubtype();

    if (/t\.me\/(\+|joinchat\/)/i.test(value)) {
      state._tgCheck.valid = false;
      state._tgCheck.chat = "";
      state._tgCheck.forceManual = false;
      setTargetStatus("err", "Приватная ссылка запрещена", "Укажи публичный @username канала или группы. Инвайт-ссылки t.me/+... и joinchat не подходят.");
      updateTgHint();
      return;
    }

    const chat = normalizeTgChatInput(value);
    if (!chat) {
      setTargetStatus("err", "Нужен @юзернейм или ссылка t.me", "Пример: @MyChannel или https://t.me/MyChannel");
      return;
    }

    const kind = tgIsBotTarget(value, chat) ? "bot" : "chat";
    const manualOnly = (kind === "bot") || TG_MANUAL_ONLY.has(sid) || !tgAutoPossible(sid, kind);

    if (manualOnly) {
      const label = kind === "bot" ? `Бот: ${chat}` : `TG: ${chat}`;
      state._tgCheck.valid = true;
      state._tgCheck.chat = chat;
      state._tgCheck.forceManual = true;
      setTargetStatus("ok", label, "Ручная проверка (скрин) ✅");
      updateTgHint();
      return;
    }

    const seq = ++_tgCheckSeq;
    setTargetStatus("loading", "Проверяем…", "Пробуем найти чат и проверить, что бот добавлен");

    try {
      const res = await apiPost("/api/tg/check_chat", { target: chat });
      if (seq !== _tgCheckSeq) return; // outdated

      if (res && res.ok && res.valid) {
        const name = res.title ? String(res.title) : chat;
        const tp = res.type ? (String(res.type) === "channel" ? "Канал" : "Группа") : "Чат";
        state._tgCheck.valid = true;
        state._tgCheck.chat = res.chat || chat;
        state._tgCheck.forceManual = false;
        setTargetStatus("ok", `${tp}: ${name}`, "Авто-проверка доступна ✅");
        updateTgHint();
      } else {
        state._tgCheck.valid = false;
        state._tgCheck.chat = chat;
        state._tgCheck.forceManual = false;
        setTargetStatus("err", `TG: ${chat}`, (res && res.message) ? String(res.message) : "Авто-проверка недоступна. Добавь бота в чат/канал и выдай нужные права.");
        updateTgHint();
      }
    } catch (e) {
      if (seq !== _tgCheckSeq) return;
      state._tgCheck.valid = false;
      state._tgCheck.chat = chat;
      state._tgCheck.forceManual = false;
      setTargetStatus("err", `TG: ${chat}`, "Авто-проверка недоступна. Добавь бота в чат/канал и выдай нужные права.");
      updateTgHint();
    }
  }

  function scheduleTgCheck() {
    updateTgHint();
    const type = currentCreateType();
    const target = $("t-target") ? $("t-target").value : "";

    if (type !== "tg") {
      setTargetStatus("", "", "");
      return;
    }

    if (_tgCheckTimer) window.clearTimeout(_tgCheckTimer);
    _tgCheckTimer = window.setTimeout(() => runTgCheckNow(target), 450);
  }

  function initTgTargetChecker() {
    const inp = $("t-target");
    const sel = $("t-type");
    if (inp) {
      inp.addEventListener("input", scheduleTgCheck);
      inp.addEventListener("blur", scheduleTgCheck);
    }
    if (sel) sel.addEventListener("change", () => { recalc(); scheduleTgCheck(); });

    // Also recheck when TG subtype changes (doesn't change chat, but keeps status visible)
    const sub = $("t-tg-subtype");
    if (sub) sub.addEventListener("change", () => { recalc(); scheduleTgCheck(); });
    const retention = $("t-retention-extra");
    if (retention) retention.addEventListener("change", () => { recalc(); scheduleTgCheck(); });
    const reviewMode = $("t-review-mode");
    if (reviewMode) reviewMode.addEventListener("change", () => { syncReviewTextsHint(); recalc(); });
    const reviewVariants = $("t-review-variants");
    if (reviewVariants) reviewVariants.addEventListener("input", syncReviewTextsHint);
  }

  const TASK_MIN_BUDGET_RUB = 50;
  const TOP_FIXED_PRICE_RUB = 250;

  function isTopWanted() { return !!state.createTopWanted; }
  function setTopWanted(v) {
    state.createTopWanted = !!v;
    updateTopUi();
    recalc();
  }
  function toggleTopWanted() { setTopWanted(!state.createTopWanted); }
  window.toggleTopWanted = toggleTopWanted;

  function updateTopUi() {
    const card = $("top-option-card");
    const badge = $("top-option-badge");
    const hint = $("top-option-hint");
    if (!card) return;
    const on = !!state.createTopWanted;
    card.classList.toggle("selected", on);
    card.setAttribute("aria-pressed", on ? "true" : "false");
    if (badge) badge.textContent = on ? "Выбрано" : "Не выбрано";
    if (hint) hint.textContent = on ? `К сумме добавится ${TOP_FIXED_PRICE_RUB} ₽ за 24 часа.` : `Поднимет задание выше остальных на 24 часа.`;
  }


  function syncTaskCommentUi(type) {
    const wrap = $("task-comment-wrap");
    const label = $("t-text-label");
    const input = $("t-text");
    if (!wrap || !label || !input) return;
    const isReview = (type === "ya" || type === "gm" || type === "dg");
    label.textContent = isReview ? "Комментарий к отзыву / доп. информация" : "Текст задания / комментарий";
    input.placeholder = isReview
      ? "Например: что важно упомянуть в отзыве, какие нюансы учесть, что нельзя писать."
      : "Например: выполните задание и отправьте отчёт.";
  }

  window.toggleTaskCommentBox = function () {
    const wrap = $("task-comment-wrap");
    if (!wrap) return;
    wrap.classList.toggle("hidden");
    syncTaskCommentUi(currentCreateType());
  };

  function recalc() {
    const type = currentCreateType();
    const qtyInput = $("t-qty");
    
    // Limits
    let minQty = 1;
    let minReward = 100; // default for YA
    if (type === "tg") {
       minQty = 10;
       const sid = currentTgSubtype();
       const st = TG_TASK_TYPES.find(x => x.id === sid);
       minReward = st ? st.reward : 5;
    } else if (type === "ya") {
       minReward = 84; // Cost 100
    } else if (type === "gm") {
       minReward = 59; // Cost 70
    } else if (type === "dg") {
       minReward = 10;
    }

    const qty = clamp(Number((qtyInput && qtyInput.value) || minQty), minQty, 1000000);
    const priceInput = $("t-price-per-unit");
    const pricePerUnit = clamp(Number((priceInput && priceInput.value) || minReward), minReward, 1000000);
    
    const vipOnlyInput = $("t-vip-only");
    const isVipOnly = !!(vipOnlyInput && vipOnlyInput.checked);
    
    const cur = $("t-cur") ? $("t-cur").value : "rub";
    const commissionEnabled = state.config && state.config.feature_commission_disabled ? false : true;

    syncTaskCommentUi(type);
    
    const tgWrap = $("tg-subtype-wrapper");
    const tgOpt = $("tg-options");
    const retentionWrap = $("retention-config-wrap");
    if (tgWrap) tgWrap.classList.toggle("hidden", type !== "tg");
    if (tgOpt) tgOpt.classList.toggle("hidden", type !== "tg");
    if (retentionWrap) retentionWrap.classList.toggle("hidden", type !== "tg");

    // Base cost
    const baseTotal = pricePerUnit * qty;
    
    // Commission (20%) - round down
    const commTotal = commissionEnabled ? Math.floor(baseTotal * 0.20) : 0;
    
    // VIP surcharge (10%) - round down
    const vipTotal = isVipOnly ? Math.floor(baseTotal * 0.10) : 0;
    
    const grandTotal = baseTotal + commTotal + vipTotal;

    // Display breakdown
    if ($("calc-base")) $("calc-base").textContent = fmtRub(baseTotal);
    if ($("calc-comm")) $("calc-comm").textContent = fmtRub(commTotal);
    if ($("calc-comm-row")) $("calc-comm-row").style.display = commissionEnabled ? "flex" : "none";
    if ($("calc-vip")) $("calc-vip").textContent = fmtRub(vipTotal);
    if ($("calc-vip-row")) $("calc-vip-row").style.display = isVipOnly ? "flex" : "none";
    
    const totalEl = $("t-total");
    if (totalEl) {
      if (cur === "star") {
        totalEl.textContent = rubToStars(grandTotal) + " ⭐";
      } else {
        totalEl.textContent = fmtRub(grandTotal);
      }
    }

    const minWarn = $("t-min-budget-warning");
    const minCostTarget = (type === "ya" ? 100 : (type === "gm" ? 70 : (type === "tg" ? 5 : 15)));
    const actualCostPer = pricePerUnit + Math.floor(pricePerUnit * (commissionEnabled ? 0.2 : 0)) + Math.floor(pricePerUnit * (isVipOnly ? 0.1 : 0));
    
    if (minWarn) {
      minWarn.style.display = actualCostPer < minCostTarget ? "block" : "none";
      minWarn.textContent = `Минимальная цена задания — ${minCostTarget} ₽.`;
    }

    syncReviewTextsHint();
  }
  window.recalc = recalc;

  async function createTask() {
    const type = currentCreateType();
    const qty = Number(($("t-qty") && $("t-qty").value) || 1);
    const target = String(($("t-target") && $("t-target").value) || "").trim();
    const txt = String(($("t-text") && $("t-text").value) || "").trim();
    const reviewMode = getCustomReviewMode();
    const reviewTexts = getCustomReviewTexts();
    
    const vipOnlyInput = $("t-vip-only");
    const isVipOnly = !!(vipOnlyInput && vipOnlyInput.checked);
    const pricePerUnitInput = $("t-price-per-unit");
    const pricePerUnit = Number((pricePerUnitInput && pricePerUnitInput.value) || 100);
    const cur = ($("t-cur") && $("t-cur").value) || "rub";

    if (!target) {
      if (type === "tg") {
        const sid = currentTgSubtype();
        if (tgNeedsChat(sid)) return tgAlert("Укажи @канал или @группу (пример: @MyChannel)", "error", "Нужно указать чат");
      } else {
        return tgAlert("Укажи ссылку на карточку места (Яндекс/Google/2GIS)", "error", "Нужна ссылка");
      }
    }

    if (pricePerUnit < 100) return tgAlert("Минимальная цена за 1 шт. — 100 ₽.");

    // TG validation
    let tgChat = null;
    let tgKind = null;
    let subType = null;
    let checkType = "manual";

    if (type === "tg") {
      subType = currentTgSubtype();
      tgChat = normalizeTgChatInput(target);
      if (tgNeedsChat(subType)) {
        if (!tgChat) {
          tgAlert("Для Telegram-задания нужен @юзернейм канала/группы.", "error", "Укажи чат");
          return;
        }
        tgKind = tgIsBotTarget(target, tgChat) ? "bot" : "chat";
        if (tgKind === "bot" || TG_MANUAL_ONLY.has(subType) || !tgAutoPossible(subType, tgKind)) {
           tgAlert("Для этого подтипа Telegram доступна только авто-проверка. Бот должен быть в канале/группе.", "error", "Telegram");
           return;
        }
        checkType = "auto";
      } else {
        checkType = "auto";
      }
    }

    const payload = {
      type,
      qty_total: qty,
      reward_rub: pricePerUnit,
      target_url: (type === "tg") ? tgTargetToUrl(target) : normalizeUrl(target),
      title: (type === 'tg' ? 'Активность TG' : (type === 'ya' ? 'Отзыв Яндекс' : (type === 'gm' ? 'Отзыв Google' : 'Отзыв 2GIS'))),
      currency: cur,
      vip_only: isVipOnly,
      tg_subtype: subType,
      tg_chat: tgChat,
      check_type: checkType,
      retention_days: type === 'tg' ? tgTotalRetentionDays(subType) : 0,
      gender: ($("t-gender") && $("t-gender").value) || "any",
      comment: txt,
      custom_review_mode: reviewMode,
      custom_review_texts: reviewTexts,
    };

    try {
      tgHaptic("impact");
      const res = await apiPost("/api/task/create", payload);
      if (res && res.ok) {
        tgHaptic("success");
        closeModal();
        tgAlert(`✅ Задание создано! Списано: ${res.charged_amount} ${res.charged_currency === 'star' ? '⭐' : '₽'}`);
        await syncAll();
      } else {
        throw new Error(res && res.error ? res.error : "Ошибка создания");
      }
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e));
    }
  }
  window.createTask = createTask;

  async function buyVip(currency) {
    try {
      tgHaptic("impact");
      const res = await apiPost("/api/vip/buy", { currency });
      if (res && res.ok) {
        tgHaptic("success");
        closeModal();
        tgAlert("👑 VIP-статус успешно активирован!");
        await syncAll();
      } else {
        throw new Error(res && res.error ? res.error : "Ошибка покупки");
      }
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e));
    }
  }
  window.buyVip = buyVip;

  async function adminToggleCommission() {
    try {
      const current = state.config && state.config.feature_commission_disabled ? false : true;
      const next = !current;
      const res = await apiPost("/api/admin/config/toggle_commission", { enabled: next });
      if (res && res.ok) {
        tgHaptic("success");
        await syncAll();
      }
    } catch (e) {
      tgAlert("Ошибка управления комиссией");
    }
  }
  window.adminToggleCommission = adminToggleCommission;

  // --------------------
  // Tabs
  // --------------------
  function showTab(tab) {
    if (tab === "friends") showSection("friends");
    else if (tab === "profile") showSection("profile");
    else if (tab === "help") showSection("help");
    else showSection("tasks");
    // when user opens tasks tab — refresh immediately
    if (state.currentSection === "tasks") {
      if (state.filter === "reports") refreshReports();
      try { syncTasksOnly(true); } catch (e) {}
    }
  }
  window.showTab = showTab;

  // FAQ accordion toggle
  window.toggleFaq = function (headerEl) {
    var card = headerEl.closest(".faq-card");
    if (!card) return;
    var body = card.querySelector(".faq-card-body");
    var arrow = card.querySelector(".faq-card-arrow");
    if (!body) return;
    var isOpen = body.style.display !== "none";
    body.style.display = isOpen ? "none" : "block";
    if (arrow) arrow.style.transform = isOpen ? "rotate(0deg)" : "rotate(90deg)";
    card.classList.toggle("faq-open", !isOpen);
  };

  // --------------------
  // Friends: copy/share invite
  // --------------------
  window.copyInviteLink = function () {
    copyText(state._inviteLink || "");
  };

  window.shareInvite = function () {
    const link = state._inviteLink || "";
    if (!link) return;
    const text = "Присоединяйся к ReviewCash: " + link;
    try {
      if (tg && tg.openTelegramLink) {
        tg.openTelegramLink("https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent(text));
      } else {
        window.open("https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent(text), "_blank");
      }
    } catch (e) {
      window.open(link, "_blank");
    }
  };

  // --------------------
  // Withdrawals (user)
  // --------------------
  async function refreshWithdrawals() {
    try {
      const res = await apiPost("/api/withdraw/list", {});
      const list = (res && res.withdrawals) ? res.withdrawals : [];
      renderWithdrawals(list);
    } catch (e) {
      // ignore
    }
  }

  function parseWithdrawDetails(raw) {
    const src = String(raw || "");
    const parts = src.split("|").map(v => String(v || "").trim());
    return {
      fullName: parts[0] || "",
      method: parts[1] || "",
      value: parts.slice(2).join(" | ") || src
    };
  }

  function renderWithdrawals(list) {
    const box = $("withdrawals-list");
    if (!box) return;
    if (!Array.isArray(list) || !list.length) {
      box.innerHTML = `<div class="card" style="margin:0; padding:14px; color:var(--text-dim); font-size:13px;">Заявок пока нет</div>`;
      return;
    }
    box.innerHTML = "";
    list.forEach(w => {
      const st = String(w.status || "pending");
      const stLabel = st === "paid" ? "✅ Выплачено" : (st === "rejected" ? "❌ Отклонено" : "⏳ В обработке");
      const info = parseWithdrawDetails(w.details || "");
      const methodLabel = info.method === "card" ? "Карта" : (info.method === "phone" ? "Телефон" : "Реквизиты");
      const row = document.createElement("div");
      row.className = "card";
      row.style.margin = "0";
      row.style.padding = "14px";
      row.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
          <div style="min-width:0;">
            <div style="font-weight:900; font-size:16px;">${fmtRub(w.amount_rub || 0)}</div>
            <div style="margin-top:6px; font-size:13px;">👤 ${safeText(info.fullName || "—")}</div>
            <div style="margin-top:4px; font-size:12px; color:var(--text-dim);">${methodLabel}: ${safeText(info.value || "—")}</div>
          </div>
          <div style="font-size:12px; opacity:0.85; white-space:nowrap;">${stLabel}</div>
        </div>
      `;
      box.appendChild(row);
    });
  }

  window.requestWithdraw = async function () {
    const fullName = String(($("w-fullname") && $("w-fullname").value) || "").trim();
    const payoutMethod = String(($("w-method") && $("w-method").value) || "phone").trim();
    const payoutValue = String(($("w-details") && $("w-details").value) || "").trim();
    const amount = Number(($("w-amount") && $("w-amount").value) || 0);

    if (!fullName || !fullName.includes(" ")) return tgAlert("Укажи имя и фамилию");
    if (!payoutValue) return tgAlert("Укажи номер телефона или карты");
    if (!amount || amount < 300) return tgAlert("Минимум 300₽");

    try {
      tgHaptic("impact");
      const res = await apiPost("/api/withdraw/create", {
        full_name: fullName,
        payout_method: payoutMethod,
        payout_value: payoutValue,
        amount_rub: amount
      });
      if (res && res.ok) {
        tgHaptic("success");
        tgAlert("Заявка на вывод создана ✅");
        if ($("w-fullname")) $("w-fullname").value = "";
        if ($("w-details")) $("w-details").value = "";
        if ($("w-amount")) $("w-amount").value = "";
        if ($("w-method")) $("w-method").value = "phone";
        await syncAll();
        await refreshWithdrawals();
      } else {
        throw new Error(res && res.error ? res.error : "Ошибка");
      }
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e));
    }
  };

  // --------------------
  // History (ops)
  // --------------------
  async function refreshOpsSilent() {
    try {
      const res = await apiPost("/api/ops/list", {});
      if (res && res.ok) renderOps(res.operations || []);
    } catch (e) {}
  }

  function renderOps(list) {
    const box = $("history-list");
    if (!box) return;
    state._opsCache = Array.isArray(list) ? list.slice() : [];

    let view = Array.isArray(list) ? list.slice() : [];
    const f = state.opsFilter || "all";
    if (f !== "all") {
      view = view.filter(op => {
        const k = String(op.kind || "");
        if (f === "topup") return k === "topup";
        if (f === "withdrawal") return k === "withdrawal";
        if (f === "earning") return k === "earning";
        return true;
      });
    }

    if (!list.length) {
      box.innerHTML = `<div class="menu-item" style="margin:0; opacity:0.7;">История пуста</div>`;
      return;
    }
    box.innerHTML = "";
    view.forEach(op => {
      const kind = String(op.kind || "");
      let title = "";
      let sub = "";
      let amountText = fmtRub(op.amount_rub || 0);
      let amountStyle = "font-weight:900;";
      if (kind === "topup") {
        if (String(op.status || "paid") !== "paid") return;
        title = "Пополнение";
        sub = (op.provider ? String(op.provider).toUpperCase() : "");
      } else if (kind === "earning") {
        const src = String(op.source || "");
        if (src === "task") title = "Начисление за задание";
        else if (src === "referral") title = "Реферальный бонус";
        else if (src === "admin") title = "Начисление админом";
        else title = "Начисление";
        sub = String(op.title || "") || src;
      } else if (kind === "fine") {
        title = "Штраф";
        sub = String(op.title || "") || "Списание администратором";
        amountStyle = "font-weight:900; color:var(--danger);";
      } else if (kind === "payment") {
        title = "Пополнение (" + safeText(op.provider || "") + ")";
        sub = (op.status === "paid") ? "✅ Оплачено" : (op.status === "rejected" ? "❌ Отклонено" : "⏳ В ожидании");
      } else {
        title = "Вывод";
        sub = (op.status === "paid") ? "✅ Выплачено" : (op.status === "rejected" ? "❌ Отклонено" : "⏳ В ожидании");
      }
      const row = document.createElement("div");
      row.className = "menu-item";
      row.style.margin = "0";
      row.style.border = "none";
      row.style.background = "transparent";
      row.innerHTML = `
        <div style="display:flex; flex-direction:column;">
          <div style="font-weight:900;">${title}</div>
          <div style="font-size:12px; color:var(--text-dim);">${sub}</div>
        </div>
        <div style="${amountStyle}">${amountText}</div>
      `;
      box.appendChild(row);
    });
  }

  window.showHistory = function () {
    showSection("history");
    refreshOpsSilent();
  };
  window.closeHistory = function () {
    showSection("profile");
  };

  // --------------------
  // Topup: Stars + T-Bank
  // --------------------
  window.processPay = async function (kind) {
    if (kind !== "pay_stars") return;
    if (!starsPaymentsEnabled()) return tgAlert("Оплата Stars временно отключена администратором", "error", "Stars выключены");

    const amount = Number(($("sum-input") && $("sum-input").value) || 0);
    if (!amount || amount < 120) return tgAlert("Минимум 120 ₽");

    try {
      tgHaptic("impact");
      const res = await apiPost("/api/pay/stars/link", { amount_rub: amount });
      if (!res || !res.ok) throw new Error(res && res.error ? res.error : "Не удалось создать инвойс");

      // If backend returned invoice_link -> open it inside Mini App
      if (res.invoice_link && tg && tg.openInvoice) {
        tg.openInvoice(res.invoice_link, async function (status) {
          // status: "paid" | "cancelled" | "failed" (depends on Telegram)
          if (status === "paid") {
            tgHaptic("success");
            tgAlert("Оплачено ✅ Баланс обновится сейчас.");
            await syncAll();
            closeAllOverlays();
          } else if (status === "failed") {
            tgHaptic("error");
            tgAlert("Платёж не прошёл.");
          }
        });
      } else {
        // Backend may have sent invoice as a message
        tgAlert("Инвойс отправлен в чат с ботом. Оплати сообщение-инвойс и вернись в приложение.");
      }
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e));
    }
  };

  window.openTBankPay = function () {
    const amount = Number(($("sum-input") && $("sum-input").value) || 0);
    if (!amount || amount < 120) return tgAlert("Минимум 120 ₽");

    // generate code
    state.tbankCode = "RC" + Math.random().toString(10).slice(2, 8);
    if ($("tb-code")) $("tb-code").textContent = state.tbankCode;
    if ($("tb-amount-display")) $("tb-amount-display").textContent = fmtRub(amount);

    openOverlay("m-pay-tbank");

    // ensure referral button works even if HTML calls openTbankReferrals
    try {
      const btn = document.getElementById("tb-ref-btn");
      if (btn) btn.onclick = () => window.openTbankReferrals();
    } catch (e) {}
  };

  window.copyCode = function () {
    copyText(state.tbankCode || "");
  };

  window.openTBankPhonePay = function () {
    const amount = Number(($("sum-input") && $("sum-input").value) || 0);
    if (!amount || amount < 120) return tgAlert("Минимум 120 ₽");

    state.tbankPhoneCode = "RC" + Math.random().toString(10).slice(2, 8);
    if ($("tbp-code")) $("tbp-code").textContent = state.tbankPhoneCode;
    if ($("tbp-amount-display")) $("tbp-amount-display").textContent = fmtRub(amount);

    openOverlay("m-pay-tbank-phone");
  };

  window.copyPhoneCode = function () {
    copyText(state.tbankPhoneCode || "");
  };

  window.confirmTBankPhone = async function () {
    const amountStr = ($("tbp-amount-display") && $("tbp-amount-display").textContent) || "";
    const amount = Number(String(amountStr).replace(/[^\d.,]/g, "").replace(",", ".")) || Number(($("sum-input") && $("sum-input").value) || 0);
    const sender = String(($("tbp-sender") && $("tbp-sender").value) || "").trim();
    const phoneRaw = String(($("tbp-phone") && $("tbp-phone").value) || "").trim();
    const phone = normalizePhoneForTbank(phoneRaw);
    const file = $("tbp-file") && $("tbp-file").files ? $("tbp-file").files[0] : null;

    if (!amount || amount < 120) return tgAlert("Минимум 120 ₽");
    if (!sender) return tgAlert("Укажи имя отправителя");
    if (phone.length !== 11 || !phone.startsWith("7")) return tgAlert("Укажи корректный номер телефона РФ");
    if (!file) return tgAlert("Прикрепи скрин оплаты");
    if (file && file.type && !/^image\//i.test(file.type)) return tgAlert("Можно прикреплять только изображения");

    try {
      tgHaptic("impact");
      const proofUrl = await uploadProof(file, `tbank_phone_${state.tbankPhoneCode || ""}`);
      const res = await apiPost("/api/tbank/claim", {
        amount_rub: amount,
        sender: sender,
        phone: phone,
        proof_url: proofUrl,
        code: state.tbankPhoneCode,
      });
      if (res && res.ok) {
        tgHaptic("success");
        tgAlert("Заявка отправлена ✅ Ожидай подтверждение админом.");
        closeAllOverlays();
        if ($("tbp-sender")) $("tbp-sender").value = "";
        if ($("tbp-phone")) $("tbp-phone").value = "";
        if ($("tbp-file")) $("tbp-file").value = "";
        updateTBankPhoneFileName(null);
        await refreshOpsSilent();
      } else {
        throw new Error(res && res.error ? res.error : "Ошибка");
      }
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e));
    }
  };

  window.confirmTBank = async function () {
    const amountStr = ($("tb-amount-display") && $("tb-amount-display").textContent) || "";
    const amount = Number(String(amountStr).replace(/[^\d.,]/g, "").replace(",", ".")) || Number(($("sum-input") && $("sum-input").value) || 0);
    const sender = String(($("tb-sender") && $("tb-sender").value) || "").trim();
    const phoneRaw = String(($("tb-phone") && $("tb-phone").value) || "").trim();
    const phone = normalizePhoneForTbank(phoneRaw);
    const file = $("tb-file") && $("tb-file").files ? $("tb-file").files[0] : null;

    if (!amount || amount < 120) return tgAlert("Минимум 120 ₽");
    if (!sender) return tgAlert("Укажи имя отправителя");
    if (phone.length !== 11 || !phone.startsWith("7")) return tgAlert("Укажи корректный номер телефона РФ");
    if (!file) return tgAlert("Прикрепи скрин оплаты");
    if (file && file.type && !/^image\//i.test(file.type)) return tgAlert("Можно прикреплять только изображения");

    try {
      tgHaptic("impact");
      const proofUrl = await uploadProof(file, `tbank_${state.tbankCode || ""}`);
      const res = await apiPost("/api/tbank/claim", {
        amount_rub: amount,
        sender: sender,
        phone: phone,
        proof_url: proofUrl,
        code: state.tbankCode,
      });
      if (res && res.ok) {
        tgHaptic("success");
        tgAlert("Заявка отправлена ✅ Ожидай подтверждение админом.");
        closeAllOverlays();
        if ($("tb-sender")) $("tb-sender").value = "";
        if ($("tb-phone")) $("tb-phone").value = "";
        if ($("tb-file")) $("tb-file").value = "";
        updateTBankFileName(null);
        await refreshOpsSilent();
      } else {
        throw new Error(res && res.error ? res.error : "Ошибка");
      }
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e));
    }
  };

  // --------------------
  // Admin panel
  // --------------------
  async function checkAdmin() {
    try {
      const res = await apiPost("/api/admin/summary", {});
      if (res && res.ok) {
        state.isAdmin = true;
        state.isMainAdmin = !!(res.is_main_admin);
        state.adminCounts = res.counts || state.adminCounts;
        if (res.features && Object.prototype.hasOwnProperty.call(res.features, "stars_payments_enabled")) {
          state.config = Object.assign({}, state.config || {}, { stars_payments_enabled: !!res.features.stars_payments_enabled });
        }
        renderAdminBadge();
        applyStarsUiState();
        const apc = $("admin-panel-card");
        if (apc) apc.style.display = "block";
      } else {
        state.isAdmin = false;
        state.isMainAdmin = false;
        applyStarsUiState();
        const apc2 = $("admin-panel-card");
        if (apc2) apc2.style.display = "none";
      }
    } catch (e) {
      state.isAdmin = false;
      state.isMainAdmin = false;
      applyStarsUiState();
      const c = $("admin-panel-card");
      if (c) c.style.display = "none";
    }
  }

  function renderAdminBadge() {
    const b = $("admin-badge");
    if (!b) return;
    const n = (Number(state.adminCounts.proofs || 0) + Number(state.adminCounts.withdrawals || 0) + Number(state.adminCounts.tbank || 0) + Number(state.adminCounts.tasks || 0));
    b.textContent = String(n);
    b.style.opacity = n > 0 ? "1" : "0";
  }

  window.openAdminPanel = async function () {
    if (!state.isAdmin) return;
    openOverlay("m-admin");
    renderAdminStarsToggle();
    await switchAdminTab("proofs");
  };

  window.adminToggleStarsPayments = async function (enabled) {
    if (!state.isMainAdmin) return tgAlert("Только для главного админа");
    try {
      const res = await apiPost("/api/admin/stars-pay/set", { enabled: !!enabled });
      if (!res || !res.ok) throw new Error((res && res.error) || "Не удалось сохранить");
      state.config = Object.assign({}, state.config || {}, { stars_payments_enabled: !!res.enabled });
      applyStarsUiState();
      tgAlert(`Оплата Stars ${res.enabled ? "включена" : "выключена"}`);
    } catch (e) {
      tgAlert(String(e.message || e));
    }
  };

  window.switchAdminTab = async function (tab) {
    qsa(".admin-tab").forEach(el => el.classList.remove("active"));
    const t = $("at-" + tab);
    if (t) t.classList.add("active");

    const avp = $("admin-view-proofs");
    const avw = $("admin-view-withdrawals");
    const avt = $("admin-view-tbank");
    const avts = $("admin-view-tasks");
    if (avp) avp.classList.toggle("hidden", tab !== "proofs");
    if (avw) avw.classList.toggle("hidden", tab !== "withdrawals");
    if (avt) avt.classList.toggle("hidden", tab !== "tbank");
    if (avts) avts.classList.toggle("hidden", tab !== "tasks");

    if (tab === "proofs") await loadAdminProofs();
    if (tab === "withdrawals") await loadAdminWithdrawals();
    if (tab === "tbank") await loadAdminTbank();
    if (tab === "tasks") await loadAdminTasks();
  };

  function adminCard(html) {
    const d = document.createElement("div");
    d.className = "card";
    d.style.padding = "14px";
    d.innerHTML = html;
    return d;
  }

  let adminProofsLoadToken = 0;

  async function loadAdminProofs() {
    const box = $("admin-list");
    if (!box) return;

    const loadToken = ++adminProofsLoadToken;
    box.innerHTML = `<div class="card" style="padding:14px; opacity:0.7;">Загрузка...</div>`;

    const res = await apiPost("/api/admin/proof/list", {});
    if (loadToken !== adminProofsLoadToken) return;
    box.innerHTML = "";
    let proofs = (res && res.proofs) ? res.proofs : [];
    const seen = new Set();
    proofs = proofs.filter(p => {
      const sig = [p && p.id, p && p.user_id, p && p.task_id, p && p.proof_url, p && p.proof_text, p && p.status].join("|");
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });

    const rulesCard = adminCard(`
      <div style="font-weight:900; margin-bottom:8px;">📘 Правила для админов</div>
      <div style="font-size:12px; color:var(--text-dim); line-height:1.45; display:grid; gap:6px;">
        <div>1. Проверяй совпадение задания, ника и скрина.</div>
        <div>2. Для Яндекс/Google/2GIS смотри, что отзыв размещён на нужной карточке и текст выглядит живым.</div>
        <div>3. Если отчёт можно исправить — отправляй на доработку с понятной причиной.</div>
        <div>4. Если отчёт не подходит — отклоняй и обязательно указывай причину.</div>
        <div>5. Если есть явный обман или чужой/поддельный скрин — помечай как фейк и применяй санкции по регламенту.</div>
      </div>
      <a href="/app/admin_rules.html" target="_blank" class="btn btn-secondary" style="width:100%; margin-top:10px; text-decoration:none; justify-content:center;">Открыть полный регламент</a>
    `);
    box.appendChild(rulesCard);

    if (!proofs.length) {
      box.appendChild(adminCard(`<div style="opacity:0.7;">Нет отчётов на проверку</div>`));
      return;
    }

    proofs.forEach(p => {
      const t = p.task || {};
      const taskLink = t.target_url ? normalizeUrl(t.target_url) : "";
      const proofUrl = p.proof_url ? normalizeUrl(p.proof_url) : "";
      const imgHtml = proofUrl ? `<img src="${safeText(proofUrl)}" style="width:100%; max-height:240px; object-fit:contain; border-radius:14px; margin-top:10px; background:rgba(255,255,255,0.03);" />` : "";
      const linkHtml = taskLink ? `<a href="${safeText(taskLink)}" target="_blank" class="btn btn-secondary" style="width:100%; margin-top:10px; padding:10px; text-decoration:none; justify-content:center;">🔗 Ссылка на место отзыва</a>` : "";
      const isReview = ["ya", "gm", "dg"].includes(String(t.type || "").toLowerCase());

      const c = adminCard(`
        <div style="display:flex; justify-content:space-between; gap:10px;">
          <div style="flex:1;">
            <div style="font-weight:900;">${safeText(t.title || "Задание")}</div>
            <div style="font-size:12px; color:var(--text-dim);">User: ${safeText(p.user_id)} • Reward: ${fmtRub(t.reward_rub || 0)}</div>
            <div style="margin-top:8px; font-size:13px; background:var(--glass); padding:10px; border-radius:12px;">
              <b>Ник:</b> ${safeText(p.proof_text || "")}
            </div>
          </div>
          <div class="brand-box" style="width:46px; height:46px; font-size:22px;">${brandIconHtml(t, 38)}</div>
        </div>
        ${linkHtml}
        ${imgHtml}
        <div style="display:grid; grid-template-columns:${isReview ? '1fr 1fr 1fr' : '1fr 1fr'}; gap:10px; margin-top:12px;">
          <button class="btn btn-main" data-approve="1">✅ Принять</button>
          <button class="btn btn-secondary" data-approve="0">❌ Отклонить</button>
          ${isReview ? '<button class="btn btn-secondary" data-rework="1">🛠 На переработку</button>' : ''}
        </div>
      `);

      c.querySelector('[data-approve="1"]').onclick = async () => decideProof(p.id, true, c);
      c.querySelector('[data-approve="0"]').onclick = async () => {
        const comment = (prompt("Причина отклонения:", "") || "").trim();
        if (!comment) return tgAlert("Укажи причину отклонения.", "error", "Нужен комментарий");
        await decideProof(p.id, false, c, { comment });
      };
      const rw = c.querySelector('[data-rework="1"]');
      if (rw) rw.onclick = async () => {
        const comment = (prompt("Причина отправки на переработку:", "") || "").trim();
        if (!comment) return tgAlert("Укажи причину переработки.", "error", "Нужен комментарий");
        await decideProof(p.id, false, c, { rework: true, comment });
      };
      box.appendChild(c);
    });
  }

async function decideProof(proofId, approved, cardEl, extra = {}) {
    try {
      tgHaptic("impact");
      await apiPost("/api/admin/proof/decision", Object.assign({ proof_id: proofId, approved: !!approved }, extra || {}));
      tgHaptic("success");
      if (cardEl) cardEl.remove();
      await checkAdmin();
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e));
    }
  }

async function loadAdminWithdrawals() {
    const box = $("admin-withdraw-list");
    if (!box) return;
    box.innerHTML = "";

    const res = await apiPost("/api/admin/withdraw/list", {});
    const list = (res && res.withdrawals) ? res.withdrawals : [];
    if (!list.length) {
      box.innerHTML = `<div class="card" style="opacity:0.7;">Нет заявок</div>`;
      return;
    }

    list.filter(w => w.status === "pending").forEach(w => {
      const info = parseWithdrawDetails(w.details || "");
      const methodLabel = info.method === "card" ? "Карта" : (info.method === "phone" ? "Телефон" : "Реквизиты");
      const c = adminCard(`
        <div style="font-weight:900;">Вывод ${fmtRub(w.amount_rub || 0)}</div>
        <div style="font-size:12px; color:var(--text-dim);">User: ${safeText(w.user_id)}</div>
        <div style="margin-top:6px; font-size:13px;">👤 ${safeText(info.fullName || "—")}</div>
        <div style="margin-top:4px; font-size:12px; color:var(--text-dim);">${methodLabel}: ${safeText(info.value || "—")}</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px;">
          <button class="btn btn-main" data-approve="1">✅ Выплатить</button>
          <button class="btn btn-secondary" data-approve="0">❌ Отклонить</button>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
          <button class="btn btn-secondary" data-ban-withdraw="1" style="padding:8px 10px; font-size:12px;">🚫 Бан вывода 1д</button>
          <button class="btn btn-secondary" data-ban-global="1" style="padding:8px 10px; font-size:12px;">⛔ Бан 1д</button>
          <button class="btn btn-secondary" data-fine="1" style="padding:8px 10px; font-size:12px;">💸 Штраф</button>
        </div>
      `);
      c.querySelector('[data-approve="1"]').onclick = async () => decideWithdraw(w.id, true, c);
      c.querySelector('[data-approve="0"]').onclick = async () => decideWithdraw(w.id, false, c);

      // Sanctions
      const uid = Number(w.user_id || 0);
      const bw = c.querySelector('[data-ban-withdraw="1"]');
      if (bw) bw.onclick = () => adminBanQuick(uid, "withdraw", 1);
      const bg = c.querySelector('[data-ban-global="1"]');
      if (bg) bg.onclick = () => adminBanQuick(uid, "global", 1);
      const bf = c.querySelector('[data-fine="1"]');
      if (bf) bf.onclick = () => adminFineQuick(uid);

      box.appendChild(c);
    });
  }

  async function decideWithdraw(withdrawId, approved, cardEl) {
    try {
      tgHaptic("impact");
      await apiPost("/api/admin/withdraw/decision", { withdraw_id: withdrawId, approved: !!approved });
      tgHaptic("success");
      if (cardEl) cardEl.remove();
      await checkAdmin();
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e));
    }
  }

  async function loadAdminTbank() {
    const box = $("admin-tbank-list");
    if (!box) return;
    box.innerHTML = "";

    const res = await apiPost("/api/admin/tbank/list", {});
    const list = (res && res.tbank) ? res.tbank : [];
    if (!list.length) {
      box.innerHTML = `<div class="card" style="opacity:0.7;">Нет заявок</div>`;
      return;
    }

    list.forEach(p => {
      const sender = (p.meta && p.meta.sender) ? p.meta.sender : "";
      const phone = (p.meta && p.meta.phone) ? p.meta.phone : "";
      const proofUrl = (p.meta && p.meta.proof_url) ? normalizeUrl(p.meta.proof_url) : "";
      const proofHtml = proofUrl ? `<img src="${safeText(proofUrl)}" style="width:100%; max-height:240px; object-fit:contain; border-radius:14px; margin-top:10px; background:rgba(255,255,255,0.03);" />` : "";
      const c = adminCard(`
        <div style="font-weight:900;">T-Bank ${fmtRub(p.amount_rub || 0)}</div>
        <div style="font-size:12px; color:var(--text-dim);">User: ${safeText(p.user_id)} • Code: ${safeText(p.provider_ref || "")}</div>
        <div style="font-size:12px; color:var(--text-dim);">Sender: ${safeText(sender)}</div>
        <div style="font-size:12px; color:var(--text-dim);">Phone: ${safeText(phone || "—")}</div>
        ${proofHtml}
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px;">
          <button class="btn btn-main" data-approve="1">✅ Подтвердить</button>
          <button class="btn btn-secondary" data-approve="0">❌ Отклонить</button>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
          <button class="btn btn-secondary" data-ban-tbank="1" style="padding:8px 10px; font-size:12px;">🚫 Бан T‑Bank 1д</button>
          <button class="btn btn-secondary" data-ban-global="1" style="padding:8px 10px; font-size:12px;">⛔ Бан 1д</button>
          <button class="btn btn-secondary" data-fine="1" style="padding:8px 10px; font-size:12px;">💸 Штраф</button>
        </div>
      `);
      c.querySelector('[data-approve="1"]').onclick = async () => decideTbank(p.id, true, c);
      c.querySelector('[data-approve="0"]').onclick = async () => decideTbank(p.id, false, c);

      // Sanctions
      const uid = Number(p.user_id || 0);
      const bt = c.querySelector('[data-ban-tbank="1"]');
      if (bt) bt.onclick = () => adminBanQuick(uid, "tbank", 1);
      const bg = c.querySelector('[data-ban-global="1"]');
      if (bg) bg.onclick = () => adminBanQuick(uid, "global", 1);
      const bf = c.querySelector('[data-fine="1"]');
      if (bf) bf.onclick = () => adminFineQuick(uid);

      box.appendChild(c);
    });
  }

  async function decideTbank(paymentId, approved, cardEl) {
    try {
      tgHaptic("impact");
      await apiPost("/api/admin/tbank/decision", { payment_id: paymentId, approved: !!approved });
      tgHaptic("success");
      if (cardEl) cardEl.remove();
      await checkAdmin();
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e));
    }
  }

  // --------------------
  // Admin sanctions (ban / fine)
  // --------------------
  async function adminPunish(userId, action, kind, extra = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error("bad user_id");
    const payload = Object.assign({ user_id: uid, action: String(action || ""), kind: String(kind || "global") }, extra || {});
    return await apiPost("/api/admin/user/punish", payload);
  }

  async function adminBanQuick(userId, kind = "global", days = 1) {
    try {
      const uid = Number(userId || 0);
      if (!uid) return;
      const reason = (prompt("Причина бана (необязательно):", "") || "").trim();
      tgHaptic("impact");
      await adminPunish(uid, "ban", kind, { days: Number(days || 1), reason });
      tgHaptic("success");
      tgAlert(`Бан (${kind}) выдан ✅`, "success", "Админка");
      await checkAdmin();
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e), "error", "Админка");
    }
  }

  async function adminUnbanQuick(userId, kind = "global") {
    try {
      const uid = Number(userId || 0);
      if (!uid) return;
      tgHaptic("impact");
      await adminPunish(uid, "unban", kind, {});
      tgHaptic("success");
      tgAlert(`Бан (${kind}) снят ✅`, "success", "Админка");
      await checkAdmin();
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e), "error", "Админка");
    }
  }

  async function adminFineQuick(userId) {
    try {
      const uid = Number(userId || 0);
      if (!uid) return;
      const raw = (prompt("Штраф в ₽ (введите число):", "100") || "").trim();
      const n = Number(raw.replace(",", "."));
      if (!isFinite(n) || n <= 0) { tgAlert("Некорректная сумма", "error"); return; }
      const reason = (prompt("Причина штрафа (необязательно):", "") || "").trim();
      tgHaptic("impact");
      await adminPunish(uid, "fine", "global", { amount_rub: -Math.abs(n), reason });
      tgHaptic("success");
      tgAlert(`Штраф -${Math.abs(n)} ₽ применён ✅`, "success", "Админка");
      await checkAdmin();
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e), "error", "Админка");
    }
  }


  // --------------------

  function tgConfirm(text) {
    return new Promise((resolve) => {
      try {
        if (tg && tg.showConfirm) {
          return tg.showConfirm(String(text || ""), (ok) => resolve(!!ok));
        }
      } catch (e) {}
      resolve(window.confirm(String(text || "")));
    });
  }

async function loadAdminTasks() {
    const box = $("admin-task-list");
    if (!box) return;
    box.innerHTML = "";
    if (state.isAdmin) {
      // User management (ban / fine)
      const um = adminCard(`
        <div style="font-weight:900; margin-bottom:8px;">⚠️ Санкции пользователю</div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
          <input id="admin-user-id" placeholder="User ID" inputmode="numeric" style="flex:1; min-width:140px; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.06); color:var(--text);" />
          <button class="btn btn-secondary" data-um-ban="1" style="padding:10px 12px;">⛔ Бан 1д</button>
          <button class="btn btn-secondary" data-um-unban="1" style="padding:10px 12px;">✅ Разбан</button>
          <button class="btn btn-secondary" data-um-fine="1" style="padding:10px 12px;">💸 Штраф</button>
        </div>
        <div style="font-size:11px; opacity:0.65; margin-top:8px;">Бан по умолчанию — глобальный на 1 день. Штраф — списание ₽.</div>
      `);
      const getUid = () => {
        const uidInput = um.querySelector("#admin-user-id");
        return Number((((uidInput && uidInput.value) || "").trim()) || 0);
      };
      const bban = um.querySelector('[data-um-ban="1"]');
      if (bban) bban.onclick = () => { const u = getUid(); if (u) adminBanQuick(u, "global", 1); else tgAlert("Введите User ID", "error"); };
      const bunban = um.querySelector('[data-um-unban="1"]');
      if (bunban) bunban.onclick = () => { const u = getUid(); if (u) adminUnbanQuick(u, "global"); else tgAlert("Введите User ID", "error"); };
      const bf = um.querySelector('[data-um-fine="1"]');
      if (bf) bf.onclick = () => { const u = getUid(); if (u) adminFineQuick(u); else tgAlert("Введите User ID", "error"); };
      box.appendChild(um);
    }

    const res = await apiPost("/api/admin/task/list", {});
    const list = (res && res.tasks) ? res.tasks : [];

    if (!list.length) {
      box.appendChild(adminCard(`<div style="opacity:0.7;">Нет активных заданий</div>`));
      return;
    }

    list.forEach(t => {
      const link = t.target_url ? normalizeUrl(t.target_url) : "";
      const qty = (t.qty_left != null && t.qty_total != null) ? `${t.qty_left}/${t.qty_total}` : "";
      const owner = t.owner_id != null ? String(t.owner_id) : "";

      const del = state.isMainAdmin ? `<button class="btn btn-secondary" data-del="1" style="width:100%;">🗑 Удалить</button>` : "";
      const delHint = state.isMainAdmin ? `<div style="font-size:11px; opacity:0.6; margin-top:6px;">Удалять может только главный админ</div>` : "";

      const c = adminCard(`
        <div style="display:flex; justify-content:space-between; gap:10px;">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:900;">${safeText(t.title || "Задание")}</div>
            <div style="font-size:12px; color:var(--text-dim);">Награда: ${fmtRub(t.reward_rub || 0)} • Осталось: ${safeText(qty)}</div>
          </div>
          <div class="brand-box" style="width:46px; height:46px; font-size:22px;">${brandIconHtml(t, 38)}</div>
        </div>
        ${link ? `<a href="${safeText(link)}" target="_blank" class="btn btn-secondary" style="width:100%; margin-top:10px; padding:10px; text-decoration:none; justify-content:center;">🔗 Открыть ссылку</a>` : ""}
        ${del ? `<div style="margin-top:10px;">${del}</div>${delHint}` : ""}
      `);

      const btn = c.querySelector('[data-del="1"]');
      if (btn) {
        btn.onclick = async () => {
          const ok = await tgConfirm("Удалить задание? Это нельзя отменить.");
          if (!ok) return;
          try {
            tgHaptic("impact");
            await apiPost("/api/admin/task/delete", { task_id: String(t.id) });
            tgHaptic("success");
            tgAlert("Задание удалено ✅", "success", "Админка");
            c.remove();
            await checkAdmin();
          } catch (e) {
            tgHaptic("error");
            tgAlert(String(e.message || e), "error", "Админка");
          }
        };
      }

      box.appendChild(c);
    });
  }

// --- Telegram initData fallback (when tg.initData is empty) ---
function extractTgWebAppDataFromUrl() {
  try {
    // Telegram may pass tgWebAppData in URL hash or query string depending on platform.
    const h = String(location.hash || "");
    const s = String(location.search || "");
    const all = (h.startsWith("#") ? h.slice(1) : h) + (s ? ("&" + s.slice(1)) : "");
    const params = new URLSearchParams(all);
    const v = params.get("tgWebAppData") || params.get("tgWebAppDataRaw") || "";
    return v ? decodeURIComponent(v) : "";
  } catch (e) {
    return "";
  }
}


  // Bootstrap
  // --------------------
  async function bootstrap() {
    state.api = getApiBase();
    initDeviceHash();
    // init performance mode ASAP (affects animations + refresh interval)
    applyPerfMode(getInitialPerfMode());

    const themeBtn = document.getElementById("theme-toggle");
    if (themeBtn && !themeBtn.dataset.bound) {
      themeBtn.dataset.bound = "1";
      themeBtn.addEventListener("click", toggleTheme);
    }

    // init theme
    try {
      const savedTheme = (localStorage.getItem(THEME_KEY) || "").trim();
      if (savedTheme === "light" || savedTheme === "dark") applyTheme(savedTheme);
      else if (tg && tg.colorScheme === "light") applyTheme("light");
      else applyTheme("dark");
    } catch (e) { try { applyTheme("dark"); } catch(e2){} }
    forceInitialView();

    if (tg) {
      try {
        tg.ready();
        tg.expand();
      } catch (e) {}
      state.initData = (tg && typeof tg.initData === 'string' && tg.initData) ? tg.initData : '';

      if (!state.initData) {

        const fb = extractTgWebAppDataFromUrl();

        if (fb) state.initData = fb;

      }

      try { console.log('[RC] initData len=', (state.initData||'').length, 'platform=', tg && tg.platform); } catch(e) {}
try { state.startParam = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) ? String(tg.initDataUnsafe.start_param) : ""; } catch (e) {}

      // Prefill user from Telegram (so avatar/name start loading immediately)
      try {
        const tu = (tg.initDataUnsafe && tg.initDataUnsafe.user) ? tg.initDataUnsafe.user : null;
        if (tu) {
          state.user = state.user || {};
          state.user.username = tu.username;
          state.user.first_name = tu.first_name;
          state.user.last_name = tu.last_name;
          state.user.photo_url = tu.photo_url;
          if (tu.photo_url && state.perfMode !== "low") { const im = new Image(); im.decoding = "async"; im.src = tu.photo_url; }
          renderHeader();
          renderProfile();
        }
      } catch (e) {}
    }

    bindOverlayClose();
    ensureModalCloseButtons();
    ensureFilterSliders();
    initPlatformSliderDrag();
    initTgSubtypeSelect();
    updateCreateTypeLabels();
    initTgTargetChecker();
    initPlatformFilterIcons();
    requestAnimationFrame(refreshFilterSliders);
    window.addEventListener("resize", scheduleRefreshFilterSliders, { passive: true });
    try { const pfBar = qs(".pf-bar"); if (pfBar) pfBar.addEventListener("scroll", scheduleRefreshFilterSliders, { passive: true }); } catch (e) {}

    try {
      requestAnimationFrame(() => {
        document.documentElement.classList.toggle("perf-low", state.perfMode === "low");
      });
    } catch (e) {}

    // keep loader until first sync is done
    const loader = $("loader");
    if (loader) loader.style.display = "flex";

    // initial tab
    showTab("tasks");
    setFilter("all");
    setPlatformFilter(state.platformFilter);
    recalc();

      try {
    await syncAllWithRetry();
    startTasksAutoRefresh();
  } catch (e) {
    tgAlert(String(e.message || e), "error", "Подключение");
  } finally {
    hideLoader();
  }
}


  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllOverlays();
  });

  document.addEventListener("DOMContentLoaded", bootstrap);

  // Expose some globals required by HTML
  window.showTab = showTab;
  window.copyInviteLink = window.copyInviteLink;
  window.shareInvite = window.shareInvite;
  window.openAdminPanel = window.openAdminPanel;
})();

/* === V11 HOTFIX: native touch swipe + safe mouse drag for horizontal filters === */
(function(){
  const DRAG_SCROLL_SELECTORS = ['.tasks-seg-switch', '.pf-bar', '.ops-filter', '.admin-tabs'];

  function enableDragScroll(el){
    if (!el || el.dataset.dragScrollReady === '1') return;
    el.dataset.dragScrollReady = '1';
    el.setAttribute('data-drag-scroll', '1');

    let isMouseDown = false;
    let isDragging = false;
    let suppressClick = false;
    let startX = 0;
    let startScrollLeft = 0;

    const overflowed = () => (el.scrollWidth - el.clientWidth) > 4;

    const finishDrag = () => {
      if (!isMouseDown && !isDragging) return;
      isMouseDown = false;
      el.classList.remove('dragging');
      if (isDragging) {
        suppressClick = true;
        window.setTimeout(() => { suppressClick = false; }, 160);
      }
      isDragging = false;
    };

    // Touch devices: use native horizontal swipe only.
    // Desktop: add mouse drag without breaking button clicks.
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (!overflowed()) return;
      isMouseDown = true;
      isDragging = false;
      startX = e.clientX;
      startScrollLeft = el.scrollLeft;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isMouseDown) return;
      const dx = e.clientX - startX;
      if (!isDragging && Math.abs(dx) > 8) {
        isDragging = true;
        el.classList.add('dragging');
      }
      if (!isDragging) return;
      el.scrollLeft = startScrollLeft - dx;
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('mouseup', finishDrag);
    el.addEventListener('mouseleave', () => {
      if (isMouseDown && !isDragging) finishDrag();
    });

    el.addEventListener('click', (e) => {
      if (!suppressClick) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    // Desktop wheel -> horizontal scroll feels natural.
    el.addEventListener('wheel', (e) => {
      if (!overflowed()) return;
      const mostlyVertical = Math.abs(e.deltaY) > Math.abs(e.deltaX);
      if (!mostlyVertical && Math.abs(e.deltaX) < 2) return;
      const delta = mostlyVertical ? e.deltaY : e.deltaX;
      if (Math.abs(delta) < 2) return;
      el.scrollLeft += delta;
      e.preventDefault();
    }, { passive: false });

    el.addEventListener('dragstart', (e) => e.preventDefault());
  }

  function initDragScrollContainers(root){
    const scope = root || document;
    DRAG_SCROLL_SELECTORS.forEach((selector) => {
      scope.querySelectorAll(selector).forEach(enableDragScroll);
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    initDragScrollContainers(document);
    const mo = new MutationObserver(() => initDragScrollContainers(document));
    try { mo.observe(document.body, { childList:true, subtree:true }); } catch (_) {}
  });
})();
