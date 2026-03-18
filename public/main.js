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

  const RC_BUILD = "rc_20260318_142800_icons2";
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
      if (window.Telegram?.WebApp?.openTelegramLink) {
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
    const text = String(msg ?? "");
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
  <text x="64" y="72" text-anchor="middle" font-family="Plus Jakarta Sans, Arial" font-size="44" font-weight="800" fill="#EAF9FF">${decodeURIComponent(txt)}</text>
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

    // Make sure we always show something instantly
    try {
      imgEl.decoding = "async";
      imgEl.loading = "eager";
    } catch (e) {}

    imgEl.style.opacity = "0.96";
    imgEl.style.transition = "opacity .22s ease";
    imgEl.src = placeholder;

    if (!url) return;

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
  { id: "sub_channel", title: "Подписка на канал", reward: 3, cost: 12, desc: "2 дня обязательного удержания. Бот проверяет, что исполнитель не вышел из канала." },
  { id: "join_group", title: "Вступление в группу", reward: 3, cost: 12, desc: "2 дня обязательного удержания. Бот проверяет, что исполнитель не вышел из группы." },
  { id: "sub_24h", title: "Тг подписка +24ч", reward: 4, cost: 16, desc: "2 дня обязательного удержания + ещё 1 день. Бот проверит участие по итогу срока." },
  { id: "sub_48h", title: "Тг подписка +48ч", reward: 5, cost: 20, desc: "2 дня обязательного удержания + ещё 2 дня. Бот проверит участие по итогу срока." },
  { id: "sub_72h", title: "Тг подписка +72ч", reward: 6, cost: 24, desc: "2 дня обязательного удержания + ещё 3 дня. Бот проверит участие по итогу срока." },
  { id: "join_group_24h", title: "Вступление в группу +24ч", reward: 4, cost: 16, desc: "2 дня обязательного удержания + ещё 1 день. Бот проверит участие по итогу срока." },
  { id: "join_group_48h", title: "Вступление в группу +48ч", reward: 5, cost: 20, desc: "2 дня обязательного удержания + ещё 2 дня. Бот проверит участие по итогу срока." },
  { id: "join_group_72h", title: "Вступление в группу +72ч", reward: 6, cost: 24, desc: "2 дня обязательного удержания + ещё 3 дня. Бот проверит участие по итогу срока." },
  ];
  const TG_BASE_RETENTION_DAYS = 2;
  const TG_EXTRA_RETENTION_REWARD_PER_DAY = 1;
  const TG_EXTRA_RETENTION_COST_PER_DAY = 3;

  // Reviews payouts you asked for
  const YA = { costPer: 12, reward: 3, title: "Яндекс Карты — отзыв" };
  const GM = { costPer: 12, reward: 3, title: "Google Maps — отзыв" };

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
      // Respect OS/user preference first
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "low";

      // Heuristics (best-effort; not always available in Telegram WebView)
      const mem = Number(navigator.deviceMemory || 0);
      if (mem && mem <= 3) return "low";

      const cores = Number(navigator.hardwareConcurrency || 0);
      if (cores && cores <= 4) return "low";
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
    return (state.perfMode === "low") ? 45000 : 15000;
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
  }

  function closeAllOverlays() {
    qsa(".overlay").forEach(el => { el.style.display = "none"; });
    document.body.style.overflow = "";
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
        const left = String(t && (t.qty_left ?? "") );
        const total = String(t && (t.qty_total ?? "") );
        const st = String(t && (t.status ?? "") );
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
    state.filter = f === "my" ? "my" : "all";
    const fa = $("f-all"), fm = $("f-my");
    if (fa) fa.classList.toggle("active", state.filter === "all");
    if (fm) fm.classList.toggle("active", state.filter === "my");
    renderTasks();
  }
  window.setFilter = setFilter;


  // --------------------
  // Platform filter (All / Ya / Google / TG)
  // --------------------
  function setPlatformFilter(p) {
    const v = (p === "ya" || p === "gm" || p === "tg") ? p : "all";
    state.platformFilter = v;
    try { localStorage.setItem("rc_platform_filter", v); } catch (e) {}

    const ids = ["pf-all", "pf-ya", "pf-gm", "pf-tg"];
    ids.forEach(id => {
      const el = $(id);
      if (!el) return;
      const want = (v === "all") ? (id === "pf-all") : (id === ("pf-" + v));
      el.classList.toggle("active", want);
    });

    renderTasks();
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
    ya: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAACAAAAAgACAYAAACyp9MwAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABmJLR0QA/wD/AP+gvaeTAAAAB3RJTUUH6AcIDzI18cgQ3wAAgABJREFUeNrs/Xm453VB//8/nq/3ObMwwyYDA8M5ZwZEXAbXEZFlzpwBRFFxJ5e01NRyy1bLLddKy8olN8wyzUyxrCQtUzmM4FJRfb790BZDmBkwlkJFgZnzfr2fvz8GywVkmDnLe7ndrsuLkQsvr+uu1zmv1/v5eL9eCQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALKUiAQAAAPSfumnTeFZet/p//0Zv13ia5au//5+bK+WQjNXvub8vNSuTrPjeTwBqp/TKQT/w31Nyww/+l7ffrk1n9/f8rW5vblltvvUD/+zy9hvZ1en977+/ePs3StLzvyAAAAAsPgMAAAAA2Ad107oDsqJzSJpySLdpD07prCq9ekBKWZ7aO6ikGUtySJo63ktdXWpzQNJbnpSDkjqWlENSM15KVveSlWXPgf1BSfb85wZbm+SbSXYluakk306yu6Z+IyndJN9Iyq6kd1NN+XZK3d3U5htJr5s036il7k4t305Tbqq17qq1fmO87X0jve7X8401Xy+XXbbb/wMBAADgBxkAAAAAMLLqyRMr05RDdy8rhzY1h5aaQ1NzaEkO7TU5NLV3aEkOTXJoajm0lvzfv//+b9izmG5JcnOSW2pyQ6m5IaXekOSGmtyQ0tzQ9L7z59xQS27oldywbHe9IV8/6HoDAgAAAIaVAQAAAABDoc5sWJHe7sPnanNU02mOSK2Hl+SoXqlHlFoOT8pRJfWImtwle75hv1K1UVVuTOrXS/I/NflaUq+rpVzb9PK1mnJdbXrX1lK/Nt4duzadK68rs+lqBgAAwEDc8UoAAABAv/rON/TnlpWjml7W3frt/KN6pbduzzfxy1E1ufXPOdJ9LgvkliRXp+Zrtz5p4Opamq81vdxQS66uJV/rldywrDO2s3zq8m/IBQAAwFLxwQgAAABLop557MG72+5Ep+2tL6WZ6KVOlGR9Uibrnj9PxLf0GTzfKMnOmmxPys6S3s5amytryo6xXndn2rKjfH7nzTIBAACwEAwAAAAAmHf17OOW58bdR3fHsq7UHFVqjt3zrf1yVEmOrcmx2fOtfRhFN9TkayW5OqmX19J8ram5uldy+Vg3l+fmw3eUSy+dkwkAAIA7ywAAAACAO61uWnfA7lXNXTslx5VS7lprmUrq+pJM1NSJpByhEuyzNsl/JfXKpOysyc6m1K/2kq+M9fKf+fbaKwwEAAAAuC0GAAAAANymOrNhxe7Su2unl3uVmmNr6R2blGOz59v7G5I0KsGS+VqSy5J6eanN5bXk8l6Ty8fHd/1r+eQ135YHAABgNBkAAAAAjLB62tShc+M5tunl2Ns45D/GfSMMpBtKcnlNLq+lfKnUXNZrcvn4Tcv+o3zxK9+UBwAAYHj5IAcAAGDI1ZkNK+Z69Z5N2nvWptyrJMeVmuNqctckhygEI+W/knwlyVdK8h819cudtl6WsasuL7PpygMAADDYDAAAAACGRN24cdnuI268W6eXe9WSjaXWe9VkY0nunqSjEPBDzCXZkdQv1ZLLSq/5Uq+Ty8Zrc1mZveIWeQAAAAaDAQAAAMCAcdAPLCLDAAAAgAFiAAAAANCn6tnHLd99y+7jbuOg/x5JGoWAJdRNsv0HhgG39L5UPr/zZnkAAACWhgEAAABAH6inTR3aHcvGppdNtfQ21ZRNDvqBAdStyb+X1EtLbS7tNblsrNP+U/n0Vf8tDQAAwMIzAAAAAFhk9dTJde1Y2VRLNpXa25SUeyU5VhlgiH0tqZfW0lxaai7tlObvy+wV/yULAADA/DIAAAAAWCD13HTytan1bScbv+uw/6Qkh6sDkK8luaymfqnU5tK2k0uXXbj9SyWp0gAAAOwbAwAAAIB5UDdtGt990HXHd9o9j/AvtWxKyf2THKAOwF77Zmr+pZZbXyHQyWXj1x74L+Wyy3ZLAwAAcMcMAAAAAPbBrY/xP7Wmd9qth/0PTLJcGYB59+3U/PN3RgGdlM+WbVd+VRYAAIAfZAAAAABwB+pJxx3UXbn7Pk0vp9bSOy0pD06yRhmAJfO1pF5aS3NpkovHdvUuKZ/febMsAADAqDMAAAAA+C713HR2Xz91j06bTSm9U2vKaSW5R5JGHYC+1a3Jv5fUS0uai7tNLll24fYvlaRKAwAAjBIDAAAAYKTd+ij/TbVkU6n11CSnJDlAGYCB980kf1dLuaTUXNoZaz9XPn3Vf8sCAAAMMwMAAABgZNSZjM21Ew/olLK5lpyS5KQkRysDMBJ6Nfm3knwxpV7S6dZt5eKr/l0WAABgmBgAAAAAQ6vOZGyuTN230+a0WuqpSR6S5BBlALjVNUn9+1Kbi9tOPjV+4fZ/KklPFgAAYFAZAAAAAEOjnjyxsru82dT0cmot9cwkpyZZqQwAe6fcmNQvllo+1WtyydiNh3+xXHrpnC4AAMDA3NVIAAAADKp61tpV3d3LT05yWqn11CSnJVmhDADz5FtJvlBLuSTJxWMrl322fOIru2QBAAD6lQEAAAAwMOqpaw7sjh9wUtI7s/TKaSk5MckyZQBYJDel5p9qUy9Omk+N7epdUj6/82ZZAACAfmEAAAAA9K160nEHtSt3nZ5aTi+pW2pyQpJGGQD6xC1J/q4mF6Wpnx775trPeWUAAACwlAwAAACAvlHPTWfu+qn7ddqcWUs9M8l0fMMfgMFxU5LPlVo+1XbyqfELt/9jSaosAADAYjEAAAAAllQ9berYXidn1tQzkzwkySGqADAkrkmyraR8qun0/qp8ZudVkgAAAAvJAAAAAFhU9YyjD2u7ndOT3plJOSvJBlUAGBGXJ/VTSfOpTvemvy6XXH+jJAAAwHwyAAAAABZUncnYXJm673c91n8myZgyAIy4m5Nc8l2vC/inkvRkAQAA9ocBAAAAMO++77H+D01ykCoA8ENdl2S2pHyqabt/XS6+erskAADAnWUAAAAA7Ld68sTK7vLm1NTeOSXlsUkmVQGA/XJ5Tb0gpfnYWLbPltl0JQEAAO6IAQAAALBP6ilrj2jHlj8spT4yydlJVqsCAAviv5N8JrVc0GmavyyzV3xdEgAA4LYYAAAAAHulJs3c1qn7d9qcWVPPSckp7ikAYNG1qflCSflYU/Ox8tntX5IEAAD4Dh/WAQAAt6tuWndAu3rsjKT3yKQ8Msk6VQCgr/zfqwKuO3Bbueyy3ZIAAMDoMgAAAAC+R53ZsKFXe2fV9M5JykOSLFcFAAbCt5N6YUnzsaY0f1lmr/gvSQAAYLQYAAAAwIir56Yzd/3U/UrNOU2tj6zJJlUAYOC1JfnnXikX1JKPLbtw+6WSAADA8DMAAACAEVTPTad73dTJqb1zS8oTk6xVBQCG2hU19S9TmvPHZrdfUpIqCQAADB8DAAAAGBF1ZsOKtvYekvTOTcqjkhysCgCMpB019aMpzcfGsn22zKYrCQAADAcDAAAAGGJ107oD2tVjZ+w59G8ek9QDVQEAvsv1Sf1E0pzf+dbhf10uvXROEgAAGFwGAAAAMGTqzIZDbv2m/zlJeVySVaoAAHvhf5L6V0lzfueAZZ8sn/jKLkkAAGCwGAAAAMAQqGccfVg713lESu/cpJyVZJkqAMB+uCmpn0ltzu80N/9Zmb3uW5IAAED/MwAAAIABVTcfeXhblp1966H/Q5OMqwIALICbk/rp1Ob8zq5lf16++JVvSgIAAP3JAAAAAAZIPXVyXW8sT6wp5yb1pCSNKgDAIrolNX+T1PM7K+b+vHzymm9LAgAA/cMAAAAA+lw989iD293dR9/6Tf+HJRlTBQDoA7ck9VNJ877O9Qf+Rbnsst2SAADA0jIAAACAPlRnNqxoa+8hSe/cpDw+yQGqAAB97IakXlBL876x2e2fKUlPEgAAWHwGAAAA0Cdq0nRnpk4ptfe0pDwpyUGqAAADaGdN/bOU5vzx2e0XywEAAIvHAAAAAJbYrq1TG5vae1qp5ceTHKkIADAsavKllHL+WK/3gbJt538oAgAAC8sAAAAAlkCdXn/PblOfmFqfUpK7KQIADLuSXJpa3t80zYfK7BX/pQgAACzIdTcAALAY6ukTR/e6zRNq6rkpOVURAGBEtan5Qinlfc0ty/6kfPEr35QEAADmhwEAAAAsoHrqmgPbzoofScrTUrI5SaMKAMD/ujklf5lefV9n7c6/KeenlQQAAPadAQAAACyA3VunNjW93nOS8pQkqxUBALhDX6up5/dqfm/5tp3/IgcAANx5BgAAADBPbn3E/1Nrqc9KcpwiAAD7piSXJuW8pnvTB8sl19+oCAAA7PW1NAAAsK/q2cctb2/a/aik92NJeViSMVUAAObNLUk+Vks5b2x2+6dLUiUBAIDbZwAAAAD7YNfWqY1N7T2t1PITSdYoAgCw4HbUUv94rNd5V9l25VflAACAH2QAAAAAe6meNnVor5Nzk95P1ZT7KwIAsCR6qfl8KeV9zbe6f1QuvfomSQAAYA8DAAAA+CHquel0r5vaWmp9TpJHJ1mmCgBA3/hGUj9US/P+8dntF8sBAMCoMwAAAIDbUDdP3atb6jNKydOSrFUEAKC/leT/l+T3m97cH5XP/td1igAAMKLXxQAAQJLUjRuXtWtufHRSn5PkDNfLAAADaXeSv6ilnDc2u/3TJamSAAAwKnygCQDAyKunTxzd7TXPLrX33KQcoQgAwJBc56X8W1PzB81c793l8zv/RxEAAIadAQAAACOpJk13Zur0UutzkjwuSUcVAIChdUuSj9XavGl825WfkwMAgGFlAAAAwEipMxuO7PV6P15L/akkGxQBABgtJbk0Kec1y3d9oHzymm8rAgDAkF3vAgDA8Nu9dWpT0+u9KClPSjKuCADAyPtGUj/U1vzu8m07/0UOAACGgQEAAABDq5557MG9ue4Tk/rCmpygCAAAt6Ukl9Za3tL59uEfLJdeOqcIAAADfG0LAADD5dZv+z8nKT+aZJUiAADspWtqqe8d63XeVbZd+VU5AAAYNAYAAAAMhbpp3QHt6uZHS8pP1eQBigAAsB/apH4iyds7F+38m5L0JAEAYBAYAAAAMNDqzIYju+n9VKn1+UnWKAIAwDz7z1LLu5umeVeZveLrcgAA0M8MAAAAGEi3Pub/RUl5UpJxRQAAWGDfrKnvHStjv1Nmr7hCDgAA+pEBAAAAA6MmTbtl6hGp9ZdScqoiAAAsgV5SP15L8+bx2e2fkgMAgH5iAAAAQN+rZx57cG939+m11J9LMqUIAAD9oCT/mJR3NaV5X5m94hZFAADog2tUAADoT3V64m7dkheUlJ9IskoRAAD61DW1lHeOpfu7Zfbq6+UAAGCpGAAAANBXalK6M1NnlNp7UVIe4ZoVAIABsiupH25rfnP5tp3/IgcAAIvNh6kAAPSFOrNhRdvr/Ugp9cU12agIAACDfYGbS1LKmztHbP+zcn5aQQAAWAwGAAAALKm6ef1R3U79yVLrC5IcpggAAEPmP0st726a5l1l9oqvywEAwEIyAAAAYEns2jxxn06neXFqfWKSMUUAABhyN9SSt4/t3v2W8rlrrpUDAICFYAAAAMCimpuZOq3U3i8l5RGuRwEAGEG7kvrhTltfVy6+6t/lAABgPvnAFQCABVeT0m6ZemTS++WknKIIAACkl9SP91Jes+yiHX8vBwAA88EAAACABVM3bRpvV1335FLqi2uyUREAALitC+dcklLeMHbR9o+JAQDA/jAAAABg3tWz1q7q3bL8WbXUn0sypQgAANyxkvpPtTZv6qzd/oFyflpFAAC489eUAAAwT+rMujXdjL2g1PqCJIcpAgAA++Q/Sy1vbZrmXWX2ilvkAABgbxkAAACw3+rpx6zvtnM/V1J+IskqRQAAYF5cU0t551iaN5XZK74uBwAAd8QAAACAfbZrZvKETq0vTsqTkowrAgAAC+KbNfW9Y93yhnLJjqvlAADg9hgAAABwp83NTJ1Wer1fTikPd00JAACL5uaU/H4nnTeW2SuukAMAgO/nw1oAAPba3MzUaaX2fikpj1QDAACW7tI8qX/SqXlt2bbzP+QAAOA7DAAAALhDew7+6yuTnKkGAAD0jV6SP+20vZeXi6/6dzkAADAAAADgdt36qP9XpZQz1AAAgL61ZwjQtK8oF179b3IAAIwuAwAAAH7ArY/6f3VSTlcDAAAGhiEAAMCIMwAAAOB/7Tn4z2uSulUNAAAYWHuGAKXzK2X2in+VAwBgdBgAAABw68F/fW2SGTUAAGBo7BkC1OaVZduVX5YDAGD4GQAAAIywuZmpM289+H+wGgAAMLR6Sf14r9RXLJu96p/lAAAYXgYAAAAjaG5m6szSq69LyUlqAADAyNgzBKidX1m27cp/kgMAYPgYAAAAjJBbv/H/q0kepAYAAIysPUOAXueVyz575T/KAQAwPAwAAABGwNzM1Gml1l9LslkNAADgVjXJRzq1vqxs2/kfcgAADD4DAACAIbZ7y+SJTfJrSc5UAwAAuB1zSf2DTievKZ/ZeZUcAACDywAAAGAI1ZkN92hr+5okT3DNBwAA7KXdSX1vZ27uFeVz11wrBwDA4PFhMADAEKnT6ybb0rw8Kc9MMqYIAACwD75VS33b2M0rfq188SvflAMAYHAYAAAADIE6s25NN80vlFpelGSFIgAAwDy4vtTyxqZp3lxmr7hFDgCA/mcAAAAwwOrM4at7vZXPr6W+NMlBigAAAAtgR0l5XXPE9veU89PKAQDQvwwAAAAGUN24cVlvzY1Pr+m9NilHKAIAACz4fUjy5ZLyys5F2z9SkqoIAED/MQAAABggdSZjbW/qKSn11Uk2KAIAACyBv6tNeen4hds/LQUAQH8xAAAAGAA1Ke2WqSfU1NeV5HhFAACAPrhRuaQ25ZfHZ7dfLAYAQH8wAAAA6HNzMxMPa2rz6zX1fmoAAAB9pib5aKd0XlZmr/hXOQAAlpYBAABAn6rT6+/ZlvY3kvJINQAAgD7XTervd8bGf6V8+qvXyAEAsDQMAAAA+kydWbemW5tXlJTnJ+koAgAADJBv1VJ+ayzN68vsFbfIAQCwuAwAAAD6RN207oDeqrEX1lJfmuQgRQAAgAG2I7W8vLNt+/vLntcEAACwCAwAAACWWE1Ku2XqCUn9jSQbFAEAAIbI39fk58cv2vFZKQAAFp4BAADAEprbcvTWJuW3asr91QAAAIZXvaDTKT9TPrPjP7UAAFg4BgAAAEugnnb08W2neV2Sc9UAAABGxFxS/6BTei8rs1dfLwcAwPwzAAAAWET15Im7dJfnxaWWn02yTBEAAGAE/U+p5TeaVcveVD7xlV1yAADMHwMAAIBFUDduXNY77Mbn1lJfleQQRQAAgJG/T0r+o6S8rHPR9o+UpCoCALD/DAAAABZYd8vUOUl9U5Jj1QAAAPgBX6i1+fnxbVd+TgoAgP1jAAAAsEDmptefUtL77ZScpAYAAMAPVZPygU5pX1Jmr9opBwDAvjEAAACYZ3Vmw5Ft7b46Kc9K0igCAACw126qpfzmWJrXl9krbpEDAODOMQAAAJgnddOm8d6q655XS31NkoMUAQAA2Gf/mVJ+Zmx2+wVSAADsPQMAAIB5MLfl6K1NmrfU5AQ1AAAA5s2nOrX56bLtyi9LAQBwxwwAAAD2Qz194ui2za8n5WlqAAAALIi5mvqOse4tLy+XXH+jHAAAt88AAABgH9SNG5f1DrvxubXU1yVZrQgAAMCCuzq1vKSzbfv7S1LlAAD4QQYAAAB3UnfL1DlJfVOSY9UAAABYZDUXtakvXL5t57+IAQDwvQwAAAD2Up2euFtbmjcl9eFqAAAALKluUn+/M1ZfWj591X/LAQCwhwEAAMAdqJvWHdA9cOzFpdZfTrJcEQAAgL7x36WW1zbbtr+1JD05AIBRZwAAAPBD3Pq4/99NMqUGAABAfyrJpb30Xjh+0VWfVwMAGPHrIgAAvt/urUfft+k1b02yWQ0AAICBUJP6R525uV8on7vmWjkAgFFkAAAA8F3qqWsO7I6teF1JeX6SjiIAAAAD54ZSy0uabdvf7bUAAMCoMQAAALiVx/0DAAAMj5Jc2jblJ5dduP1SNQCAEboGAgAYbfXUyXXtWH1zUp6gBgAAwFDp1tS3j5VdLyuz131LDgBg2BkAAAAjq85krNeben4teW1SD1QEAABgaH01qc8fu2jnJ6QAAIaZAQAAMJJ2T6+/f1N670pyohoAAACjol7QKfW5ZfaqnVoAAMPIAAAAGCn1rLWrurvHX1Fq+YUkHUUAAABGzjdKLa9s1m7/3XJ+WjkAgGFiAAAAjIzulqlzkvq2JJNqAAAAjLaS/GNb8pPLZnf8gxoAwBBd4wAADLd6+sTRbbd5c0p9vBoAAAB8l25NfftY2fWyMnvdt+QAAAadAQAAMLTqTMZ6vann11Jfl2S1IgAAANyOq1LrT49t2/lnUgAAg8wAAAAYSrs3r39A0/TeleSBagAAALB36gWd2nte2Xb1Di0AgEFkAAAADJV65rEHd+d2v6akPD9JRxEAAADupG+UWl7ZrN3+u+X8tHIAAIPEAAAAGBrdLVPnJPWdSdapAQAAwP4pn++U5pll9op/1QIAGJgrGAkAgEFXZzYc0tbuG5LyHDUAAACYR7fUUt4wduPhv1ouvXRODgCg3xkAAAADzbf+AQAAWGgl+X9tr3nmss9e+Y9qAAB9ft0CADB46ilrj2jHx9+YlKepAQAAwCKYq6X+9th1B/9Kueyy3XIAAP3IAAAAGDjdLVPnJvXtSdaoAQAAwGIqyb+0Jc9cNrvjH9QAAPrwWgUAYDDUmQ1HtrV9W5LHqQEAAMAS6tZSf2ts5YpXlk98ZZccAEC/MAAAAAbCrd/6f0eSw9QAAACgH9TkS7Wpz1x24c4vqgEA9AMDAACgr9XN649qS+8dKXm0GgAAAPShXlJ/r7N87ufKJ6/5thwAwFIyAAAA+lJNSjs99bSU+qYkhyoCAABAn7u8pves8YuuulAKAGCpGAAAAH2nzmzY0Nb23UnOVAMAAIBBuqVN6rs7ZdfPl9nrviUHALDYDAAAgL5Rk9LbMvXsmrwxqQcqAgAAwIC6opby7PHZ7Z+SAgBYTAYAAEBfqNPrj2lL771JptUAAABgGG51U/Ouzordv1A+ec235QAAFoMBAACw5LrTUz+Wkt/1rX8AAACG0Fdr8uPjF+34rBQAwEIzAAAAlkzdfOThbTN+XpLHqAEAAMAQa2upbxy77uBfKZddtlsOAGChGAAAAEuiu2Xi7KS8J8lRagAAADAKSvIv3V596vLP7vz/1AAAFuh6AwBg8dRT1xzYjq14Y1KeowYAAAAj6JZSy6uabdt/syQ9OQCA+WQAAAAsmrktR59c0rwvyXFqAAAAMNJq/XQnvWeUbVfvEAMAmC8GAADAgqubNo13D7zuZaXWlyfpKAIAAABJkm+UlBd3Ltp+nhQAwHwwAAAAFtSurVMbx3q999eU+6sBAAAAt6V+pDNWf6p8+qr/1gIA2B+NBADAQqhJaaenXtTp1Usd/gMAAMAPU57QdpvLujNTj9QCANivqwoJAID5Vk8/Zn3bdt+bZEYNAAAA2Ptb6qS+u1N2/XyZve5bcgAAd5YBAAAwr7pbps5N6ruSHKoGAAAA7JPLayk/Pj67/WIpAIA7wwAAAJgXdfORh7fN+HlJHqMGAAAA7LduLfW3xq47+FfKZZftlgMA2BsGAADAfpvbOvnQ0ssfJlmrBgAAAMyjmi92euUp5eLtl4sBANwRAwAAYJ/VmYx1M/XyUusrkjSKAAAAwEIoN6b2nju2becHtAAAfuhVgwQAwL6oMxs2tLX3x0k9WQ0AAABYlLvx93fKrueV2eu+pQUAcFsMAACAO607M/WE1PruJIeoAQAAAIunpvxbreXJy7Zd+U9qAADfzwAAANhr9eSJld1leX1J+Wk1AAAAYMnsKrW8stm2/TdL0pMDAPgOAwAAYK/smpk8YazmT2qyUQ0AAADoC5/slM6Pl9kr/ksKACBJGgkAgB+mJqWdnnpRp+YfHP4DAABAXzmrre0/z22dfKgUAEDiCQAAwA9RZ9ataWvzB0l5pBoAAADQv7fwNfWtY99a+wvl0kvn5ACA0WUAAADcprktR28tad6f5Gg1AAAAYCD8XactTy4Xb79cCgAYTQYAAMD3qDMZ62bq5aXWlyfpKAIAAAAD5ZtJfmrsoh0flAIARo8BAADwv+pp66baTucDSU5TAwAAAAb6Lv/9neVzzy2fvObbWgDA6DAAAACSJN3picellN9LcqgaAAAAMPhq6r/Wpj5p2YVX/T81AGA0GAAAwKh/GHD2ccvbb+96U0p+Sg0AAAAYOjen1heObdv5HikAYPgZAADACKvT6ybb0vlwkgerAQAAAEP9KcD7O9/q/VS59OqbtACA4WUAAAAjqrt1/SPS670vyV3UAAAAgOFXky+P9coTyme3f0kNABhOBgAAMGo3++em071u6hWl1lckaRQBAACAUVJuTM2zxrZt/7AWADCEv+klAIDRUTcfeXjbjH8gyUPUAAAAgFFWz+tcf/ALy2WX7dYCAIaHAQAAjIi5LZObS/InSdapAQAAACT5+05n7Nzyma9eKQUADAeP/QWAIVeT0k5Pvagkn47DfwAAAOD/nNi23X+Y2zr5UCkAYDh4AgAADLF60nEHtStueU9SnqAGAAAAcDtqLfU3xmZ3vrQkPTkAYHAZAADAkNo9c/T9mtp8JMld1QAAAADuWP1MZ2z8KeXTX71GCwAYTF4BAABDqDs99WNNbS6Jw38AAABgr5XT2273H+a2HH2yFgAwoL/NJQCA4VFnNqxoa++tSX2WGgAAAMA+6pZaXt7Ztv0NUgDAYDEAAIAhUacn7tYr5SM1uY8aAAAAwDz4aGd8/BnlU5d/QwoAGAwGAAAwBLpbJx6fXvn9JAepAQAAAMyXmnx5rDaPL9uu/LIaAND/GgkAYKBvwks7PfVL6ZUPx+E/AAAAMM9Kcs+29P6uOz3xODUAYCB+dwMAg6ieuubAdmzl+5I8Rg0AAABggdVa6m+Mze58aUl6cgBAfzIAAIBBvOOenrhbt5S/KMk91QAAAAAWTa1/1Vm27EfLpy7/hhgA0H8MAABgwHSnJx6eUj6Q5BA1AAAAgMVWk38fq81jyrYrv6wGAPSXRgIAGJib69JOT/1SSvlYHP4DAAAAS6Qkx7elfrG7dfLRagBA3/2eBgD6XZ05fHXbW/nelPp4NQAAAIA+UWupvzE2u/MlJalyAMDSMwAAgH6/kz598q69Nn9ekxPUAAAAAPrQ+Z3lu59RPnnNt6UAgKVlAAAAfWxu6+RDSy8fTHKoGgAAAEC/Ksn/17TlseXi7ZerAQBLp5EAAPpTu2XqOaWXC+LwHwAAAOhzNblP26l/P7dl6iFqAMDS8QQAAOi3G+aZDSva2r4ryY+pAQAAAAyYttTyss627W+QAgAWnwEAAPSROnP0RFubjyZ5oBoAAADAAPtg51vts8qlV98kBQAsHgMAAOgTc1smN5fk/CRr1QAAAAAGXUn556Y0jy2zV1yhBgAsjkYCAFh67czEC0rymTj8BwAAAIZETb1fW7tfnJuZOk0NAFgcngAAAEt5I3xuOt1rJ367pPy0GgAAAMCQ2p1anjO2bfsfSgEAC8sAAACWSD11zYHt2Io/Tsoj1QAAAACGXU19y9hFO3+2JD01AGBhGAAAwFLc8E6vP6ZbeheU5F5qAAAAACOjlj/tfLv7Y+XSq28SAwDmnwEAACyyuS1Hn1zSfDTJWjUAAACAUVNS/rkp7Tll9qqdagDA/GokAIDF052efGJJ8+k4/AcAAABGVE29X1ubL+zeOrVJDQCYXwYAALAoN7YpczNTr0rJB5OsVAQAAAAYcUc3vTrb3Tr5aCkAYP54BQAALLB69nHL25t3vye1/qgaAAAAAN+j1lJeMz67/VVSAMD+MwAAgIW8g51Zt6atnY8mOU0NAAAAgNtR8p7OjUc8t1x66ZwYALA/v1IBgAWxa3ri3p2SjyVlvRoAAAAAd+jiTmkfW2avvl4KANg3jQQAMP/mtk4+tFPKZx3+AwAAAOy109ra+Xzduu7uUgDAvjEAAIB51m6Zek7p5YIkB6sBAAAAcKcc1/Y6n5ubmZiRAgDuPK8AAIB5Umcy1vYmfyclL1ADAAAAYL/sTslPjs3ueK8UALD3DAAAYB7UmQ2HtLU9P8mZagAAAADMj1rr68e27XxpSaoaAHDHDAAAYH9vRE+dXNcbK39VU++nBgAAAMA8q+VPO03z1DJ7xS1iAMAPZwAAAPth19apjZ1e/XiSKTUAAAAAFkq5sFOax5XZK76uBQD8kN+YEgDAvpmbmZgptXw0ySFqAAAAACysklzW1Pbssu3qHWoAwG1rJACAO6+7deLxpZZPxOE/AAAAwKKoyca2dL6we+bo+6kBALfNAAAA7qR2eupF6ZUPJ1mhBgAAAMCiWtfU5sK5rRNbpACAH2QAAAB7qSZlbsvUG2qpb/I7FAAAAGDJHFJ65ZPdLZNPlgIAvleRAADuWD37uOXtTbvem+RJagAAAAD0hVpLec347PZXSQEAexgAAMAd3UnObDik7bV/nhKPlgMAAADoMzX1LWMX7fzZkvTUAGDUGQAAwA+7gTx1cl1vLB+vyX3VAAAAAOhbH+3srj9aPr/zZikAGGUGAABwO3bNTJ7Qqfl4kkk1AAAAAPpd+XyndB9VZq++XgsARlUjAQD8oLktR2/t1Fwch/8AAAAAA6Ke3K2di+pp66a0AGBUGQAAwPfpzkw9oaT5eJKD1QAAAAAYHCW5V9vpfGH39Pr7qwHAKDIAAIDv0k5PvSi1fijJCjUAAAAABtJRTeltm9s6+VApABg1BgAAkKQmZW5m4k211Df5/QgAAAAw8FaXXv6yOz31I1IAMEqKBACMunpuOu21k+cleaYaAAAAAEOlLSnP61y0/TwpABgFBgAAjLR69nHL22/v/kBKfbwaAAAAAMOplvqG8dmdv6wEAMPOAACA0b3xO2vtqnbXso8meYgaAAAAAMOtpr5l7KKdP1OSqgYAw8oAAIDRvOE7berQtpO/SurJagAAAACMjPd1yo6fKLPpSgHAMDIAAGDk1M3rj+o1vb+pyb3VAAAAABg5f94pnSeX2StukQKAYWMAAMBIqdPrj2lL72+T3FUNAAAAgFFVP9Pp3vKYcsn1N2oBwDAxAABgZOzaOrWx06ufTLJODQAAAICR9/edsd7Z5dNX/bcUAAwLAwAARsLuzRMPapry8SSHqQEAAABAktTkS2Odelb5zM6r1ABgGDQSADDs5qbXn9405dNx+A8AAADAdynJvdq2fLbOTBynBgDDwAAAgKHWnZl8TCm9jydZrQYAAAAAt+GYtpbP7to8cR8pABh0BgAADK3u9NSPp+b8JMvVAAAAAOCHOLLTlNm5LUefLAUAg8wAAICh1E5PvSil/kGSMTUAAAAA2AuHljR/Ozc9eZYUAAwqAwAAhkpNytzMxOtrqW9KUhQBAAAA4E5YVUo+1p2ZeoIUAAwiByMADI2aNO3M5NtT85NqAAAAALAfuin1GWOzO/9ICgAGiQEAAEOhJk27ZfLdSZ6pBgAAAADzoJeaZ49t2/H7UgAwKAwAABh49dx02usm35OaH1cDAAAAgHlUS6k/3Znd+btSADAIDAAAGOw7sHPTaa+dem9Sn6oGAAAAAAugllp+trNt+5ulAKDfGQAAMLh3Xps2jberrvtgSn28GgAAAAAspJK8rHPRjl9TAoA+/30FAIOnbty4rF3zzQ8leYwaAAAAACyGkvxK56Idr1UCgD7+XQUAg6Wefdzy9qZdH07yKDUAAAAAWEy11DeMz+78ZSUA6EcGAAAM1g3WpnUHtKs7f57kIWoAAAAAsBSMAADoVwYAAAzOjdWmdQe0q5q/TClnqAEAAADAUqo1bxzftuMXlQCgnxgAADAYN1RnrV3V7lr+saRuVQMAAACAvlDzzs62Hc8rSRUDgH5gAABA/99HnXnswe1c9xNJPVkNAAAAAPpLPa9z0c7nlqSnBQBLzQAAgP6+fZrZcEjba/86JSepAQAAAEBfKnlPZ3bHc4wAAFj6X0kA0KfqaVOHtp36N0lOVAMAAACAPvfBTtnxY2U2XSkAWCoGAAD0pbr5yMN7zfinanIfNQAAAAAYCCUf6mTHU40AAFi6X0UA0GfqGces7Xa7nynJvdQAAAAAYMCc3yk7nmIEAMBSMAAAoK/UmXVrerVzYU1OUAMAAACAwVQ/0ik7n2wEAMBiayQAoG9ui2Y2HNKrnb92+A8AAADAYCtPaOvkB+q56WgBwGIyAACgL9Qzjz24re0na7JJDQAAAACGwI+0107+XnUWA8Ai8ksHgCVXTzruoHb33N8kOVENAAAAAIbI09uZyfOqVzIDsEgMAABYUnXTugPaFbs+lpKT1AAAAABg6NT8RLtl6s1CALAYDAAAWLp7n03rDmhXj12QZFoNAAAAAIZXfeHc9OTv6ADAQvPIGQCW5pbn5ImV7Xg+llLOUAMAAACAUVBLfmt8dscvKAHAQvEEAAAW/0Zn48Zl7XjOd/gPAAAAwCgpNT8/NzP1KiUAWLDfNRIAsJjqxo3L2jXf/EiSc9QAAAAAYBSVmpd3tu34VSUAmG+eAADAoqnnptOu+eb74/AfAAAAgBFWS17Xzkz9shIAzDdPAABgcW5qzk2nvXby/UmerAYAAAAAJCX1xZ2Ldv6mEgDM3+8WAFhgew7/p96b1KeqAQAAAAD/q5bkBZ2LdrxdCgDmg1cAALCwdzBJaa+deofDfwAAAAD4AaUmv9vOTP6UFADMyy8WCQBYKDUp7fTk21PiBgYAAAAAbl9N6k+OXbTz3VIAsD8MAABYMN3pybem5AVKAAAAAMAdalPLU8a2bf+wFADsK68AAGBBzE1PvtbhPwAAAADstU5K/aPu9MTDpQBgX3kCAADzrp2ZeEGt5a1KAAAAAMCddnNNHjp+0Y7PSgHAnWUAAMC86m6ZelpS3xtPmQEAAACAffWNXm22Ltt25T9JAcCdYQAAwLzpTk8+KiV/mmRMDQAAAADYL9d1mnZzufDqf5MCgL1lAADAvJibXn96Kb2/SrJCDQAAAACYFzs6bXtaufjq7VIAsDc8nhmA/bZ788SDSql/Hof/AAAAADCfJrudzt/WU9YeIQUAe8MAAID9smvr1MamKR9P6oFqAAAAAMD8Ksnx7fiyC+qpa3z+BsDe/N4AgH1Tp9dNtqVzcZIpNQAAAABgIZULO6V5eJm94hYtALg9ngAAwD6pp6w9olvG/jYO/wEAAABgEdStbW0/VGcypgUAt8cAAIA7f6tx5rEH98bH/7qk3l0NAAAAAFg0j2rr1B9U5zsA3A6/IAC4U+qmdQe0c3MX1JT7qwEAAAAAi60+tZ2ZfIsOANwWAwAA9v7WYtOm8XZ15yNJTlMDAAAAAJZIzfPb6YlXCgHA9zMAAGDv7inOTac98Nr3JzlbDQAAAABYWrWUV7VbJn9OCQC+mwEAAHd8M5GU9tqpd6TmiWoAAAAAQH+oyRu705PPVAKA7zAAAOAOdbdM/mpSn60EAAAAAPSVkpJ3dbeuf4QUAOz5xQAAP0Q7PfWTtdR3KgEAAAAAfevmmt4Z4xdd9XkpAEabAQAAt6u7ZeqcpH40SUcNAAAAAOhr13fa3qnl4qv+XQqA0WUAAMBt2r154kFNUz6TZJUaAAAAADAQLu+MjZ1SPv3Va6QAGE2NBAB8vzozcVzT5GNx+A8AAAAAg+TYttu9oJ611ud6ACPKAACA71E3H3l4W8snknKEGgAAAAAwcB7Y3jL+oTqTMSkARo8BAAD/q5665sBeM/7XSY5TAwAAAAAGVCmPaOvUO4QAGD0GAAAkSeqmTeNtZ+X5NXmAGgAAAAAw6Oqz2i2Tr9ABYLQYAACQmpR29bXnpeShagAAAADAcKjJq7vTk89UAmB0GAAAkO6WydcleboSAAAAADBUSkrO605PPkoKgFH5wQ/ASOtumXh2Us5TAgAAAACG1k290jtj2exVX5ACYLgZAACMsO7M1CNT60eTjKkBAAAAAEPtuk6tp5ZtO/9DCoDhZQAAMKJ2b5k8sUkuTLJKDQAAAAAYCf/Zmdt9SvncNddKATCcGgkARk89ffKuTeoFcfgPAAAAAKPkru34sgvqWWt9LggwpAwAAEZM3Xzk4d02n0jKEWoAAAAAwMg5sd01/id1xmtBAYaRAQDACKlnrV3VNuMfL8nd1AAAAACAUVUe2dbJN+sAMHwMAABGRE2adtey9yd5oBoAAAAAMPKe105PvUgGgOFiAAAwIrpbpn49yWOVAAAAAACSpJb6293pyUcpATA8igQAw687M/n01PyBEgAAAADA9yo39pp287ILr/p/WgAMwU91CQCG29yWyc0l+dsky9UAAAAAAG7DVZ1OPal8ZudVUgAMNq8AABhi9bSpY0vyp3H4DwAAAADcvqN7bfmLumndAVIADDYDAIAhVU+bOrTbyceTHK4GAAAAAPDD1GRTu7r5w+rp0QADzQAAYBgv1jdtGm+b3vkl9e5qAAAAAAB7pzyhu2XqVToADC4DAIAh1K669i0p5QwlAAAAAIA7o6S+ortl6mlKAAzqz3EAhko7M/kLteY3lQAAAAAA9tHu2tSzxi/ceZEUAIPFAABgiHS3TJydlI8l6agBAAAAAOyH/+6U+uAyu/MrUgAMDgMAgCGxa+vUxk6vfi7JQWoAAAAAAPurJl8eK51TyuwVX1cDYDA0EgAMwYX4zIYjO736iTj8BwAAAADmSUnu2db2Q3UmY2oADAYDAIABV0+eWNn22j9PMqkGAAAAADDPzmrr1DtkABgMBgAAA6wmpV1W3pOSk9QAAAAAABZGfVa7ZeKFOgD0PwMAgAHW3TL5uiRPVgIAAAAAWEg15Xe6W6bOUQKgvxUJAAZTd3riKSnlA0oAAAAAAIvkm53aPLhsu/LLUgD0JwMAgAG0e+bo+zW1uSTJAWoAAAAAAIulJv8xVjoPKrNXfF0NgP7jFQAAg3aBfcbRhzW1+bM4/AcAAAAAFllJ7tbW9kP13HTUAOg/BgAAA6TOZKztNh9JcowaAAAAAMASOat77eRrZADoPwYAAAOkzeSbkswoAQAAAAAspZK8pDs9+UQlAPru5zMAg6A7PfVjKfUPlQAAAAAA+sTNvV5z2rLPXvmPUgD0BwMAgAGwe+boBze1mU2yXA0AAAAAoI9c0SntiWX26uulAFh6XgEA0OfqzIYjm9qcH4f/AAAAAED/2dD2mj+pMxmTAmDpGQAA9LG6adN4W9sPJ5lQAwAAAADoS6Wc0c3k64UAWHoGAAB9rF193duSbFYCAAAAAOhnpebnu1smn6EEwBL/PJYAoD+1WyafV5O3KQEAAAAADIhbesn0sot2/L0UAEvDAACgD81Nrz+llN6FSZapAQAAAAAMkO2dud0nls9dc60UAIvPKwAA+kzdvP6oUnrnx+E/AAAAADB4ptqxZX9WN270+SbAEjAAAOgjdWbDirbp/XmSdWoAAAAAAAOp5NT2sG/+lhAAi88AAKCPtLV9W5IHKQEAAAAADLSSF3RnJp4lBMBi//gFoC+0WyZ/tia/rQQAAAAAMCTmaimnj89uv1gKgMVhAADQD1fB05PTpeTTScbUAAAAAACGyFWdud0PKJ+75lopABaeVwAALLF6xjFrS8kH4/AfAAAAABg+R7fjy/+knpuOFAALzwAAYAnVc9Npu90/SrJODQAAAABgONWt3WsnX6kDwMIzAABYQt3rJn41yZlKAAAAAADDrCQv726dfLQSAAv+8xaApdCdmXpkav1LP4sBAAAAgBFxQ6c2m8q2K78qBcDC8AQAgCVQTz9mfWp9bxz+AwAAAACj49C29D5Uzz5uuRQAC8MAAGCR1bOPW95ru3+a5DA1AAAAAIARc2J7867fkgFgYRgAACyy9uZdb67JJiUAAAAAgJFU8/zulqmnCQEw/zx6GmARdbdMPjnJHysBAAAAAIy4b3d65UHls9u/JAXA/DEAAFgku2YmT+jUfCHJKjUAAAAAgFFXU/5trHvTieWS629UA2B+eAUAwGJcyM4cvrqp+XAc/gMAAAAAJElK6t3bsZXnKQEwfwwAABZBW1e+oyT3VAIAAAAA4Hs8qd0y+TwZAOaHVwAALLB2y9RP19Q3KwEAAAAAcJvmanpbxi+66vNSAOwfAwCABbR788SDmqZ8NskyNQAAAAAAbtf2Tmk3ldmrr5cCYN95BQDAAqknT9ylacqH4vAfAAAAAOCOTLV17A+rsyuA/eKHKMACqEnTLisfSLJBDQAAAACAvVEf3puefIkOAPvOAABgAfRmJl+a5GFKAAAAAADsvVry6rmZiRklAPZNkQBgfs3NTJ1War0wyZgaAAAAAAB32lWd0t6vzF59vRQAd44nAADMozqz4ZBS6/vj8B8AAAAAYF8d3dbO+6ovsgLcaQYAAPOoTfvOJBuUAAAAAADYL2f3tky9UAaAO8dyCmCetFsmn1uTtysBAEDfaJpk1YHJ8hXJsuUpqw5MxpcnKw9IVhyQLFuWrD5oz99bsSJl5aqkM77nP3vgwXv+OjaWrFy1588rVibjy/b8efVBSbntjxXK6oO1B773nvkFj03+5zohALizdvVqc/KybVf+kxQAe8cjqgHm4yp069TG2qtvVAIAgHnVNMlBhyYHHZJy0KHJwYfuOZhfdWCy6qA9B/qrVierD95zIL/qwJTVByYHHLjnn1mxUkOgP3R8DAnAPlnelN6H66lrHlAuuf5GOQDumCtvgP1UZzas6PXaP67JAWoAAPBDNU1y6JqUQ9Ykhx+ZHHJYcpfDUw45bM9B/8Hfd9h/0KGaAQAw6o5rx1a+OckzpQC4YwYAAPupTfumJPdRAgBghJWy5yD/8KOSw49Kjjgq5S5HJIcdseeQ//Aj9xz6H3pY0nT0AgCAO+cZ3emJT49t2/kBKQB+uCIBwL7rTk88LqX8qRIAAENu1YEp66aSI9YlRxx960H/2mTtxJ4/rzkyGR/XCeB2tOeelFz3NSEA2B/f6rS9TeXiq/5dCoDb5wkAAPuoTq+bbEt5txIAAEPiwINTjppK1u35Vzlq/a1/vfXvAQAAS2l122k+UDduPLVcdtluOQBumwEAwD6oMxlre50PJrmLGgAAA6JpkiPWpUwem0ze9da/Hpuybn2ydl3ScYsMAAB97oHdw7/xmiS/LAXAbfPpBsA+6PYmX1lKTlUCAKAPrTowZf3dkqnvHPIfk0wcmzJxTLJsuT4AADDASi2/OLdl6tPjF23/WzUAbuPnpAQAd87c9OR0KflMko4aAABLaGwsZeLYZMPdUjYcn2w4fs9f1x+XFLe7AP2kPfek5LqvCQHAPKnXdsrYfcvsFf+lBcD38gQAgDtzWXna1KFtqe+Pw38AgMVTSnLUVMrdNqbc9Z57DvqPvUeybippXJYBAMAI3iQc0fba99bk7JJUPQD+jwEAwF6qSWmb+gdJptQAAFggnbE9j+2/+71T1h+fHHN8yr3unxx8F20AAID/U/LQ3vTkz2Xbjt8SA+D/GAAA7KXelqkXJvXRSgAAzJPOWMpd75Hc434px5+Q3O2EPd/sH1+mDQAAcIdqya/vnjn6kmWzV31BDYA9vBQRYC/smpk8oVPzd0lWqgEAsI/WrE05/t4px987ufeJKRs3JStcXgGMgvbck5LrviYEAAvhPzu3LH9A+eJXvikFgCcAANyhevZxy3s37fpgdfgPALD3Dli959H997x/yr3un3KP+yaHrtEFAACYb3dtV+x6c5JnSAFgAABwh7o33/KGknKCEgAAP8Sha1Lueb+UE05M7nNiyt3vm4yP6wIAACyGp3e3TH187KLt50sBjDqvAAD4Iea2Tp1RevVv/bwEAPg+66ZS7n1iygknptz7xGT9cUlxyQTAbfMKAAAWwfWd0rl3mb3iv6QARpknAADcjnrmsQe3c3O/H4f/AADfe+D/4K3J4UdpAgAA9JM1ba99b03OLkmVAxhVBgAAt6Ptdt+WZEoJAGAk3eXwlPs8KGXT5pQTp5MjJzQBAAD6W8lDe1umnp2Ltp8nBjC6PwoB+AHdLROPTcqfKQEAjIzVB6U84LSUB25OecApycQxmgAwb7wCAIBF9O1Orfcv23b+hxTAKPIEAIDvU0+dXNcm71YCABh2ZcPxySln7PmW/31OSsbHRQEAAAbdqrY0f1jPzeZyflo5gFFjAADwXWpS2rHy7qQepgYAMHQOvkvK/U/ec+B/8hnJmrWaAAAAQ6ie3Lt28peSHb+mBTBqvAIA4Lu0WyafV5O3KQEADM1N33Ebk1MfknLKmSnH3zspbgMBWIL7ba8AAGDxdXvJKcsu2vH3UgCjxCc/ALeqp0/etW3zz0lWqwEADKymk7LxASknn5ky/bBk4hhNAFhyBgAALIWafHlsd91UPr/zZjWAUeEVAABJ6kzG2jZ/FIf/AMAgOvDglE2npZzykJRTH5KsOlATAABg5JXknt1l5VeT/JwawKgwAABI0qsTL03yYCUAgIFx0CEpJ5+RMvPIlAdOJ+PjmgAAAHyfkrxobnr9BePbrvyMGsCI/NwDGG27N69/QNP0vpDEp+YAQH876NCUk09PmXlkyolbkjGbbgAGg1cAALDEruq05d7l4u03SAEMO58WASOtzmxY0avtH1aH/wBAvzr4LikP3poy88iUB21JOm7jAAAA7qSj207ekuRpUgDDzidHwEhra+83kpygBADQV1YflHLqQ+LQHwAAYL7Up3anJy8Y27bjQ1oAw8wrAICRNbd16ozSq3/rZyEA0BfGl6WcOJ0y88iU6bOTFSs1AWBoeAUAAH3i653Su3eZvWqnFMCw8jUSYCTVmQ2HtL32vXH4DwAspaZJ2bgpZeaRKQ95THLQoZoAAAAsnEPa2ry7Jg8vSZUDGEYGAMBIatO+KcmEEgDAkpi6a5qH/UjKWY9L1qzVAwAAYPE8rJ2Z+InM7vw9KYBh5JuvwMjpbpk4OykfVwIAWFSrVqec9tCUsx6f8oBTk+J2DIDR4RUAAPSZb3Zqe0LZdvUOKYBh4wkAwEipJx13UJtd71ICAFgs5fh7p5zzoylnPjpZuUoQAACApXdQW8bemeQRUgDDxgAAGCntit1vTDKpBACwoA47IuXhT0pz9o8k66b0AAAA6Dv14d0tU08bu2j7+7UAholnTgIjY256/eml9D7lZx8AsGA3WMffO+UJP5Fy+qOSMXtrAPgOrwAAoE99vdOpJ5TP7LxKCmBY+EQKGAn1rLWr2l298+LwHwCYb6sOTDn9nJTHPSPlmLvrAQAAMDgOadvyjiSPkgIYFgYAwEhody97Q5K7KgEAzJdy/L1TzvnRlIc8JllxgCAAAACD6Zzu9OQTx7bt+JAUwDDwTVhg6M1Nrz+llN5nkzRqAAD7pemkPHhrylOel3LCA/UAgL3kFQAA9LnrO3O7N5bPXXOtFMCg8wQAYKjVTesO6Jbee+PwHwDYH6sOTDn73DTnPjtZe7QeAAAAw2VNO77szUmeLAUw6AwAgKHWXd15XUnupgQAsE8mjknz2KenPOJJyYqVegAAAAyvJ3WnJ84f27bzz6QABplXAABDa/fWiZOaXrkkSUcNAGDv75JKyolbUn7k2SmbTkuK2yYA2F9eAQDAgPivzu66sXx+5/9IAQwqTwAAhlI9+7jlvZt2vac6/AcA9lbTpDz49JQfe1HKPe6rBwAAwOg5sl1WfifJj0sBDCoDAGAodW++5dUlZaMSAMAdGl+Wcvo5aZ76wmTyWD0AAABG2491t07+2diFO/5CCmAQeZYlMHR2T6+/f1N6X0wyrgYAcLtWrU45+0fSPOm5yZq1egDAAvIKAAAGzNWdtpxQLt5+gxTAoPEEAGCo1I0bl/XKN/+wOvwHAG7PoWvSPOmnUs55SnLAaj0AAAD4fuvaTt6Q5DlSAIPGAAAYKt01N76sJPdWAgD4AYccluZHnpPyuKcnK1bqAQAAwA9RnzW3dfJPxy/c8TdaAIPEKwCAobFr88R9Ok35+yTL1AAA/tehh6U518E/ACwlrwAAYDDVKzvdW+5dLrn+Ri2AQeEJAMBwXIadm057bXlPHP4DAN/xnYP/xz8jWb5CDwAAAO6ksr47vuK1SX5GC2BQGAAAQ6F37dTzk/pAJQCAHLomzVNfmHLOU5Jly/UAAABgn5VaXrh768QHl12484tqAIPAAAAYeHXz+qPa9F6jBACMuJWrUh77Y2l+9IXJqtV6AAAAMB+aTq+8q87kgWU2XTmAfmcAAAy8tun9bpKDlQCAETU+nvKwc9M88xeSQ9foAQAAwLyqyX17vannJ9vfrAbQ74oEwCDrbpk4OykfVwIARlDTpEyfneYnX5ocNakHAPSx9tyTkuu+JgQAA6zc2CntvcrsVTu1APqZJwAAA6tuWndAm/I2JQBg9JTND0vz7F9Kpu4qBgAAAIugHtjW5i1JHqcF0M8aCYBB1T2w85okxygBAKOjHH9Cmjd/OM1rz3P4DwAAwGJ7bHfr5KNlAPqZVwAAA2nX5on7dJryD0nG1QCAEbDmyDQ//jMpj3hi0nT0AIAB4xUAAAyRHZ3uzRvLJdffKAXQj7wCABg4NWnapnlnUh3+A8CwW7Ey5XFPT/PUFyYHrNYDAACApTbZHVv56iQ/JwXQj7wCABg4vZmJ5yX1ZCUAYJjvVJqUhz8xnQ98Ns1zXuLwHwAAgL5Rkp/evXn9A5QA+pEBADBQ6syGI2str1UCAIZXOf6ENL/7Z2le/JvJYUcIAgAAQL/pNE3vXfXceEcd0HcMAICB0tbuW5McogQADKGDDknzwleneefHUu7lixQAAAD0tQf2rp16vgxAvzEAAAbG3MzEw5LyBCUAYNjuSpqUhz4+nfddmPL4ZySNL1AAAADQ/2ryujpz9IQSQD8ZkwAYiAupTesOaGt5mxIAMFzK8fdO+dnXpdzz/mIAAAAwYOqBbW3enOTxWgD9whMAgIHQXT32qiTHKgEAQ+LAg9P84hvSvOsCh/8AAAAMssd1pycfJQPQLwwAgL63a3ri3iX1Z5QAgOFQTjkznT/425RHPDkpRRAAAAAG/EY3b60zh68WAugHXgEA9LWaNG3JO5OMqwEAA27N2jQvem3K5odpAQAAwDCZ6mbFq5L8ghTAUvMEAKCv9WYmn5OUU5QAgEG+62hSznlKOu+70OE/AAAAQ6nUvGj3zNH3UwJYap4AAPStevLEXdqa1yoBAIOrHLcx5RffkHL3+4gBAADAMBtranlbTU4rSZUDWCqeAAD0rXZ5+bUka5QAgAHUGUt5ynPTvOMvHf4DAAAwIsop7fTEU3QAlpIBANCXdk+vv39qnqUEAAyecszd07zjL9M85yXJ+LggAAAAjNBNcXljPfPYg4UAlooBANB3alKa0ntzko4aADBAvvOt//P+KuX4E/QAAABgFB3Zneu+TAZgqRgAAH2nnZ56WpLNSgDAANlwtzRv++it3/pfpgcAAAAjq6S+qM5suIcSwFIwAAD6Sj11zYEp9deVAIBBuaNoUp783HTO+3jKPe6rBwAAACTL2tq+VQZgKRgAAH2lO7byVUnWKQEAA+CIdWl++4NpfvIlybLlegAAAMD/ObM7M/kYGYDFZgAA9I06vf6eJXmhEgDQ/8r0w9P5vb9Oud/JYgAAAMBtqXlz3bTuACGAxWQAAPSNNr3fSTKuBAD0sQNWp/n516d5zTuTgw7RAwAAAG7fVG9V84syAIvJAADoC92tE49PyUOVAID+Ve5x33TO+6uUc54iBgAAAOyFWsov1en1xygBLBYDAGDpL4BOnliZXnmjEgDQr3cNTcrTXpjmbR9NJnxmAQAAAHfCyrb0fP4NLBoDAGDJdZeVlyTZoAQA9KGD75Lm9e9N8xO/mHTG9AAAAIA773FzMxMPkwFYDAYAwJKqp00dWxLvQAKAPlTu86B03vPXKQ+aEQMAAAD2Ry1vqWcft1wIYKEZAABLqu3U30myQgkA6COlpDzhmWl++0+SNUfqAQAAAPt7q53crXfzrhcqASw0AwBgycxtmXpIkkcpAQB9ZNWBaV79jjQveFUy5pH/AAAAMF9qLb9ST51cpwSwkAwAgKW50Nm4cVmStyoBAP2j3PP+6fz+J1OmHy4GAAAAzLt6YDtWX68DsJAMAIAl0Tvsxp8tqXdXAgD6Q3nI49K86UPJ2qPFAAAAgIW7A3/q3PTktA7AQvFMT2DR1ZkNR7a1fbkSANAHOmNpfuIXU57yXC0AAABg4ZWm5HdqcmJJenIA880TAIBF16Z9XZLVSgDAEjvksDRv/COH/wAAALCIavKAdnrqaUoAC8EAAFjcC5vNU/dKzY8rAQBLqxx/QjrvuiDl/qeIAQAAAIt+Y15/tZ61dpUQwHwzAAAWVdvU34nXjwDAkiqPeFKat/15svZoMQAAAGBpHN3bteznZADmmwEAsGi6WybOTnKWEgCwREpJ8/SfTfOLv5GML9MDAAAAllBNXlw3rz9KCWA+GQAAi3Mhc246JeU3lACAJbLigDSve3fK039WCwAAAOgPq9umvkYGYD4ZAACLonfN1LNqcoISALAE1qxN85bzU071IB4AAADoL/WZuzevf4AOwHwxAAAW/vJl5vDVtdRXKQEAi6/c9V7pvP0vUo6/txgAAADQf5qmaX9TBmDefqhIACy0bl3xkiRHKgEAi6tMn53mbR9NjlgnBgAAAPTvHfzp3S0TZ+sAzAcDAGBB1dMnji7JzygBAIur/Miz07zqHcmKlWIAAABAn6spv1VnMqYEsL8MAIAF1bbN65McoAQALJJS0jznJWme94qkcbkPAAAAA3E7n9yzl8lnKQHsL58IAgtm9/T6+yf1KUoAwCIZH0/z8rekPOW5WgAAAMCAqTWvqWcee7ASwP4wAAAW8AdM+5t+zgDAIlm5Ks2v/X7KGY/WAgAAAAbT4d25uV+SAdgfDuaABdGdmXxMSjlDCQBYBIcdkeYtH0k5cYsWAAAAMMBK8rP19GPWKwHsKwMAYN7VTZvGa80blACARTB113Te/hcpd9uoBQAAAAy+FW2v/VUZgH1lAADMu97q655bkuOVAICFVTYcn87vfChZe7QYAAAAMCxqfcruLZMnCgHsCwMAYH6vS2Y2HFJTX6EEACysco/7pnnL+clhR4gBAAAAQ3bb36S8uSZFCuDOMgAA5lU37cuTrFECABbwU4D7PjjNb38wOehQMQAAAGAo1ZPb6YnH6gDcWQYAwPxdjpx+zPpS8wIlAGDhlAefnuY33pccsFoMAAAAGGK1lNfXmYwpAdwZBgDAvGl73VcnWa4EACyMsvWRaV73e8nyFWIAAADAsH8OkNytV6eeqQRwZxgAAPOibl1399T8qBIAsEA3/Q99fJpXvDUZM/wHAACAUVFTX1k3rTtACWBvGQAA86LtdX498SgiAFgI5fRz0rz4N5OmIwYAAACMlnW9AzvPkwHYWwYAwH7bPTP5wCSPUQIA5l85/Zw0L3tz0rGzAwAAgFFUa15aT5s6VAlgbxgAAPv/g6RXX5+kKAEA88vhP/D/Z+8+oy2p6vwPf/e5txNNDgJNNxkRMaMiKtiYA+iA4l/RGXPArBgwYxjFiGNixDijY9Yx54AJIxgxgySRnBuavvfU/r9oGAnd0OGGU1XPsxZricvli886d5/ap361CwAAIMlmk2P1uTIAa8IAALBeJpZuf++Uci8lAGBqlf0PcPMfAAAASJKU5Ln1XjttrQRwUwwAAOt30VHra1QAgCn+ft3/gAxe9nY3/wEAAIBrbDg5nHixDMBNMQAArLPJ/RYfnOQuSgDA1Cl3v5+b/wAAAMANlFoOq/vtsJMSwI0xAACsk3pIxmopnv4HgKncyO919wxe+S43/wEAAIBVmTsszctlAG6MAQBgnQzPW/KvJbmlEgAwNcot75DBa9+bzJkrBgAAALA6/1b33d5v88BqGQAA1lrdc8+5qTFlCABTpOyyRwZv+K9kwUIxAAAAgBszNhxUp/MCq2UAAFhrzZaXPTXJzkoAwBRYvFMGb/pIstEmWgAAAABr4uAVS7e7iwzAqhgAANZKve/WC2vqS5QAgCmw9XYZO/rjyeZbaQEAAACssUEdOAUAWPX6IAGwNpqr5j4vydZKAMB62nizjL3pI8lW22oBAAAArK17T+y//b1kAK7PAACwxurdt9+sJs9VAgDW07z5Gbzu/cn2u2gBAAAArJPS1NfXpCgBXJsBAGCNTQ7qS5JspgQArM8V+FgGL/2PlFvdUQsAAABgfdxpuHTJQ2QArs0AALBG6t2WLColT1MCANbzAvwZr0jZ7wFCAAAAAOut1nJUXZpxJYBrGAAA1shwLC9PsoESALDuyr8+M+XgxwkBAAAATImSuvuwbv9IJYBrGAAAblLdb9GSlDxeCQBYjw35vf8lg8c/XwgAAABgitVXOAUAuIYBAOAmDTP2kiRzlQCAdVNuc+cMXvTmpBQxAAAAgKm26zCLHyEDkBgAAG7C1U//O6sYANbVtksyePV7kjlm6QAAAIDpUWtxCgCQxAAAcBOGZeyIJPOUAIB1sHDDDF73gWTTLbQAAAAApk1Jdhs2i/+fEoABAGC16r47bJt4+h8A1u1KeyyDl78zZafdtQAAAACmXS3llfWQjCkB/WYAAFitYWlekmSBEgCwDhfaz3hFyl3uKQQAAAAwI0qy2/DcJQ9XAvrNAACwSnXfHbZNyROUAIB12HA/6BEpBztEBwAAAJhZNXl5df8Pes0CAKzScFBfHE//A8BaK7e9SwbPe50QAAAAwIwryR7DpU4BgD4zAADcQF264zZJfaISALCWtrhZBq94ZzI2rgUAAAAwK2rNK5wCAP3ljx+4gclMHhFP/wPA2hkfz+BV/5lscTMtAAAAgFlTkj2G+23/MCWgnwwAANdRl+64TanlSUoAwFpeWD/7tSm3uqMQAAAAwKyrpb7SKQDQT/7wgeuYrMMXJtlACQBYc+V+D0058FAhAAAAgJFQklsO77H9Q5WA/jEAAPyfeq+dti7JU5QAgLXYUO+2ZwbPe70QAAAAwEgpcQoA9JE/euD/TE5OevofANbGJptn8Nr3JfPmawEAAACMlJrsOdx/8UFKQL8YAABWXggsXbRlSZ6sBACsoVIyeOEbk6230wIAAAAYSaUpr3IKAPSLP3ggSTLZjL0oyYZKAMAabqAf/uSUu91XCAAAAGBk1WTP4X6L/0UJ6A8DAMDKp/9LnqoEAKyZcovbZvDEFwoBAAAAjLxSnAIAfeKPHchkHX9BPP0PAGtmw40zeOW7kzlztAAAAABGXk1uNbzH4ocoAf0wLgH0/It/n8WbD5PDlACANTN44RuTbZcIAXTP8iuSK1f+Uy+/dOW/L78iuWJZsuyyZPmVyfIrUpdduvK/m5xMLr/kuv8fyy5PmuE///2qK5MVK/7575MTqcuv0HodlLvdN4Onv0IIAADW7Xoyg1fU5HMlqWpAtxkAgJ5r5panJ3UjJQBgDTbLBz0mZb8HCgG0wyUXJhdfmHrJhcnFFyQXnpdccmHqJRdd799X/u+uc+Oe0XPxhRoAALDOaurtJpduf68cd/q31IBuMwAAff7C32vRBsPkmUoAwE0rO948g8NeJgQwGq5clnrO35Ozz0zO+fvK/3z1P/XsM1fe3HdDHwAAuJZS64uSGACAjjMAAD3WbDR4fGq2UgIAbsKcOSkv+49k7jwtgJlRa3LuWamnn5yc9tfUf5yWnP335Nyrb/ZferFGAADA2rr3iv0X7z33u2f+VAroLgMA0FP1kIwNzy3PUQIAbtrgCS9I2XVPIYCpNzm58kb/aX9J/vbnlTf6T/1L6sl/SK64XB8AAGBKDZpyeJKHKwHdZQAAemp4zuJHpGQXJQDgxpXb3iXl4U8WAlh/5/w99S+/S/3Tb5NT/pB62l+Tf5yRDCe1AQAAZspD636LdyvfP/MvUkA3GQCAniolh1cZAODGLdwog5ccnQwGWgBr54JzU//82+RPv0n9829T//Cr5KLzdQEAAGbbYFjy/CRPkQK6yQAA9NDkfosfWFNurwQA3MSO+DmvSbbeTgjgxl1yYepvf77yJv+ff7fyxv8lF+oCAACMqPKYerclryo/OuMsLaB7DABAL7/by4tEAICb+Lpc+qCU+xwsBHBD55+d+uufpv7mZ8mvf5p62l+S6nwtAACgNeZNzqnPSnKEFNA9BgCgZ1bsu/jOSfZTAgBuxCabZ/Ds1+gArHTBuSuf8D/hB8lvf+GGPwAA0HqllsPq0h2PKsederEa0C0GAKBnBqW8RAUAuInvy2e/OtlsSyGgry69KPXn30/96XdTTzw+Of9sTQAAgK7ZuEnz1CRHSQHdYgAAeqQu3fEWwzo8UAkAWL1y13un3PPBQkDfnPqX1OO/lXrCD1J//ZNkclITAACg02qtz6n7LP6P8uMzr1QDusMAAPTIsA5flGSgBACsxoYbZ/C81+kAfbD8itRf/jj1+G+m/uS7yXn/0AQAAOibrZs5g39L8h4poDsMAEBP1KXbLR7WHKoEAKze4JmvSrbcRgjoqvPPSf3eV1K//9XU3/0iGXrKHwAA6Lda6gvrIXlf+VSGakA3GACAnpisg+eVZK4SALBq5S73TLnfQ4WArrn0otSffDf1uC+l/vQ4N/0BAACua+fhOds/NDn9k1JANxgAgB6o+yzefJg8SQkAWI0FCx39D11y4Xkrn/L/7pdSf/uzpGk0AQAAWI1S6ktq8qmSVDWg/QwAQA80c/OMJBsqAQCrNnjsc5ObLRIC2uyyS1K/84XU476c+uufJo3TKwEAANZETW47eY/t753vnf5NNaD9DABA17+491q0wTDlGUoAwKqVnW+R8tDHCwFtvd79829Tv/g/qd/832T5lYIAAACsg1KbFyUxAAAdYAAAOq5ZOPa4JFspAQCrMBikPO/1ybjLYmiVC85N/fpn0nzpo8lZp+kBAACwvkq514qlS+4497gzfiEGtJtfOqHDajIYljxXCQBYzd72gEem3GovIaANmmHqL3+88mn/H3w9GU5qAgAAMIUGNc9N8igloN0MAECHDfdfcmCa7KIEAKzCZltk8KQjdIBRd94/0vzvf6V+9ZPJRefrAQAAMH0OqfstOqJ8/6wzpID2MgAAXdaUZydVBwBYhcHTXp5stIkQMKLqX05K/fT7Ur/9+WTS0/4AAAAzYM5kGTssyUukgPYyAAAdddXSJbdKrUuVAIAbKrfaK+XeBwkBo6ZpUn/63dRPvz/1hB/qAQAAMMNK8tR6363/vXzjnGVqQDsZAICOGqt53srvagDgOgaDlGe+Kim+JmFkXLks9VufT/Op9yann6wHAADA7NmsWT7v0UneIwW0kwEA6KC67zZbDZNHKgEAN1Qe8PCU3W8jBIyCi85P88n3pn7xf5LLL9UDAABgBDQlz63JscU7hqGVDABAF7+cB+OHJZmvBABczwYbZvD45+sAs+3Si1I/+6GVT/wvu1wPAACAEVJSd5/cf8l9890zvq4GtI8BAOiYuueec4e59KlKAMANDR7z7GSLmwkBs+X/bvy/L1l2mR4AAAAjqjR5dhIDANBCBgCgY4ZbXPaIJNsqAQDXs2iHlIMfpwPMhisuT/3ch9P8zzvd+AcAAGiH+9f9dtijfP+0P0gB7WIAALqm1GeIAAA3NHjGK5M5c4WAmXT5pWk+/f5UT/wDAAC0TRmW5plJniYFtMtAAuiOif2W7JfkTkoAwPV2rLe9S8pd7y0EzJThZOoXP5rho++R+qGj3fwHAABop8fUe223hQzQLk4AgA4pJc9WAQBu+AVZnnKEDjBD6gk/TH3nq1L/9icxAAAA2m2DZmLsiUneIAW0hxMAoCPqPXfaIcmDlQCA6yr7H5hyyzsIAdPtjJPTvPhxaQ4/1M1/AACAjqilPrPutdccJaA9nAAAHTHZTD6z+JsGgOtd7Y5n8ITn6wDT6bJL0nzs3amfel8yMaEHAABAt2w3XHjuwUk+IQW0g5uF0AF16VYbDmueoAQAXFc58NHJdjsKAdNhOJn6v/+d5r/fllx6sR4AAABdVcqzYwAAWsMrAKADmjrvcUk2VQIArmXBwgz+7Vk6wDSoJ/8+zdP+Jc07j3TzHwAAoPu7wH1W7L94bx2gHQwAQNu/dpPSZPB0JQDgehe6j3xqstmWQsBUump56oeOTvOUA1L/9Bs9AAAAemLQlGerAC35e5UA2m14j+0PKKm7KwEA17LxZikP83YcmEr1Nz/L8EkPSPOho5PJSUEAAAD65ZC636IlMsDoMwAArVedbQwA17/IfeRTkw02FAKmwrLL0rzzyDTPeXhy+sl6AAAA9NP4ZAZPkwFGnwEAaLG6/6Ldk9xLCQC4lk02T3nIv+oAU3G9+eNvZ/jYe6d++gNJ0wgCAADQY6WUJ9alO85XAkbbuATQXpPDsaeWkqIEAPzT4NDDPP0P6+uKy9Mc89rUL35UCwAAAK6x5bCZPDiJzSKMMCcAQEvVfRYvKCX/pgQAXMumW6Q8+NE6wPpcZ/7pNxk++UFu/gMAAHBDpTxVBBhtBgCgpYZzyyOSbK4EAFzr4vZRT08WLBQC1kWtqZ/5YJpnHJSc+Tc9AAAAWJV9r9pv8a1lgNFlAADay5QdAFzb5lulHPgoHWBdXHR+mhc9Js07XplMTOgBAADAao0NylNUgNFlAABaaMXS7W6X5M5KAMC1Lmz/31OS+QuEgLVUj/9Who+9d+rPjhMDAACANdhIln+rd9tyIyFgNBkAgDb+4daxp6sAANey8aYpD/b0P6yVyck0b39lmpc+IbnkQj0AAABYQ3Wj4fj8R+gAo8kAALTta3XlVN3/UwIA/qkc9NhkwUIhYE1delGaFz469bMfTGrVAwAAgLVSUjyoCCPKAAC0TDNn/mOS6mgdALjG/AUZHPQYHWAN1ZN/n+GTH5R64vFiAAAAsG57y+S2K/Zd7FXFMIIMAEDrvlXLU0QAgH8qBzwy2XQLIWBNLiW/+6U0Tz84OftMMQAAAFgvg0E5TAUYwb9NCaA9JvZbsl9NbqUEAFxtfDyDQ56kA9yUWlM/dHSaVz89WX6FHgAAAEyF/1f3Wby5DDBaDABAi5SSp6oAANf6brz3QcnW2wkBN+aKy9O87ElpPnR0UqseAAAATJUFzbzBv8kAo8UAALREXbpoyyQHKwEAVyslg0eYjYMbdc7fM3zqgak/+oYWAAAATLla69NrUpSA0WEAAFqiyfgTk8xTAgBWKne6R7LjbkLA6pz6lwyfcXBy+slaAAAAMF12nbzHdktlgNFhAABaoCal1voEJQDgn8rDHi8CrO768fcnZvishyXn/UMMAAAAplXJ4DAVYHQYAIAWGN5j8f2T7KoEAFxtyc4pd9xPB1iF+qNvpnnuI5JLLxIDAACAmXBQvduSRTLAaDAAAK1QTM8BwLUvYh/2hGTgUhaur37t02le8ZTkquViAAAAMFPGm7E8TgYYDX41hRFX91u0JMkDlQCAq224ccr9HqoDXP+68aPHpHnD4clwUgwAAABmdk9a8pR6SMaUgNlnAABG3GTGnpz40gSAa5QDDk3mbyAEXKPWNO98VZpjX5/UqgcAAACzYcnw3O09zAgjwAAAjLB6SMZKyeOVAICrjY1ncNBjdIBraY55beqn3y8EAAAAs6w+SQOYfQYAYIQNz1l8vySLlACAlcpd751svZ0QcLXmfW9M/eR7hQAAAGAUPKDuu8O2MsDsMgAAo6zkcSIAwLW+Gh/8KBHgas3735z6kXcKAQAAwKgYbwbDR8sAs8sAAIyoeq/ttkjKgUoAwNW2XZKy1746QJLmQ0enfvjtQgAAADBa+9UMnqACzC4DADCqX5KTY49KMk8JALj6wvXARyUDl69QP/Ge1A8dLQQAAAAjp6TuvmL/xXsrAbPHL6gwuhz/DwDXmDMn5QEP14Heqx87Js0x/y4EAAAAI2tQi/sbMJt/gxLA6Llq38W3qam3UwIAVir73j/ZbEsh6LX6rc+lOfYoIQAAABjxDWweWfdatIEQMDsMAMAIGhsMnqgCAPxTOfBRItBr9ZfHp3nD4UmtYgAAADDqNh4uHBwkA8wOAwAwYuqee85N6iOVAICrLdk55Xb76EB/rw9P/kOalz0xmZgQAwAAgLbwGgCYJQYAYMQMt7rswUmccQwA11yw3v+QpBQh6Kfzz0nz4sclyy7XAgAAgPYo5Z717tvvLATMPAMAMGqqqTgA+OfV6iDlPk6Mo6euuDzNix6TnHuWFgAAALRNaQbNv8oAM88AAIyQunTHbZJ6XyUA4Oqd4h3ultxskRD0z+Rkmlc+NfXk32sBAABAK9VSHlvdi4QZ548ORkiT5rFJxpUAgJXK/R4qAv28LnzLEak//74QAAAAtNmOk/vtsFQGmFkGAGCENLV5jAoAcLWFG6bs+wAd6J36+Q+nfvWTQgAAANB6pVSvPYYZZgAARsTE/tvfraTcQgkAuHqDuPSAZP4CIeiV+odfpXnnq4QAAACgKzvdh9alO26qA8wcAwAwIko1BQcA1/luvN/DRKBfLr04zauelkys0AIAAICuWNDU5uEywMwxAAAjoN5364WpOUQJALjaNotTbn0nHeiPZpjm1U9Pzj5TCwAAADqlxgOQMJMMAMAIGC6f99AkGysBACuVex6YlCIEvdF88K2pv/iBEAAAAHTRXep+O+whA8wMAwAwCorpNwC4zlfj/g8Wgd6oP/526v+8SwgAAAA6a7LUx6oAM8MAAMyyut8OOyW5hxIAcLUlO6fstqcO9MPZZ6Z53XOSptECAACAziqp/1YPyZgSMP0MAMAsawbNo5I44xgArtkQ3ushItCTC8EmzVGHJ5ddogUAAABdt83kOUvuJQNMPwMAMNtqHiECAFzrAnXpASLQj8vAT7039Vc/FgIAAIBeKCWPVAGmnwEAmEUrlm53u5o44xgArtkI7rJHsuNuQtB9p/4lzfvfrAMAAAB9cnDdZ/ECGWB6GQCAWVTq2KEqAMC1vhs9/U8fTEyk+fdnJSuu0gIAAIA+2Xg4b/AgGWB6GQCAWVKTUtI8XAkA+Key9IEi0HnNf78t9S8nCQEAAED/1Oo1ADDNDADALJncf/F+SdlBCQC42g67Jkt20YFOqyedkPo/7xYCAACAvjqg7rN4cxlg+hgAgFlSajHlBgDX/m68231FoNuWX5nmqMOTZqgFAAAAfTV3OCcHyQDTxwAAzIK6115zUvMwJQDgn8q+9xOBTmv++23JGacIAQAAQN95QBKmkQEAmAXDDc+7f5ItlACAq225dcotbqcD3XXGKamfer8OAAAAUMr+9Z6LtxMCpocBAJgV9VANAOBa+7673TcpRQg6qzn6JcnECiEAAAAgGTTD8nAZYJr+wCSAmVXvu/XCJAcqAQD/VO5+XxHo7vXftz+feuLxQgAAAMA1e2WvAYBpYwAAZthwxZyDkixUAgCutnDDlNvtowPdtOzyNMe8VgcAAAC4rjvVu293cxlg6hkAgJlWB6baAOBayl77JXPmCkEnNR98c3L+OUIAAADA9ffMg+J+CUwDAwAwg+rSRVsm9T5KAMA/lb2XikA3r/3+9qfUz/23EAAAALCqfXMpj1YBpp4BAJhBTR17eJI5SgDA1UpJufM9dKCT6tEvTSYnhQAAAIBV23XF0iV3lAGmlgEAmEG15lAVAOCfyk67J1ttKwTdu+770TdTf/MzIQAAAOBGlBqvAYApZgAAZki9+6LtU3JXJQDgWvbeXwO6p2lSP/AWHQAAAOAmlOSR9ZCMKQFTxwAAzJBmbPxRK7/LAID/2+TtvVQEOqd+63OpJ/9eCAAAALhp206es4P3Q8IUMgAAM6Y6xgYArm2DDVP29Jo3OmZyMs2HjtYBAAAA1lAp7p/AVDIAADPgqv2337Mmt1YCAK61ubvD3ZI5c4SgU+oXP5KcdZoQAAAAsOa76YfVPfecqwNMDQMAMAPGh83DVACA6yp73V0EumX5FWk+/A4dAAAAYO1sOrnVJfeUAaaGAQCYCaU8VAQAuN7X4+3vKgKdUj/1vuTC84QAAACAtVTqwH0UmCIGAGCa1f0W7+b4fwC4ns23SnbYVQe6Y9llaT7+Hh0AAABgndSD6tKM6wDrzwAATLNmYGoNAK6v3P6uSSlC0Bn1Cx9Jll0mBAAAAKybLSabHfaTAdafAQCYZrVWAwAAcD3l9vuIQHdMTqb53//SAQAAANZDKY37KTAFDADANKr7LVqSZC8lAOB6G7rb31UEunPN983PJueeJQQAAACsn4Ore5ew3vwRwTRqytjDkjjfGACu7WaLku121IFuqDX1E8fqAAAAAOtvm8n9t3dsJKwnAwAwjWqN42oA4Hoc/0+nrvd++t3UU/8sBAAAAEyFxmuVYX0ZAIBpUpfuuE1K3OEAgOspt9lbBLpzzfex/xQBAAAApkhJDqlOVob1YgAApklThwf7GwOAVWzkbn0nEeiE+sdfp/76J0IAAADA1Fk8cY8ld5QB1p2bkzBNahxTAwA3sPGmyZKddaAb13ufPFYEAAAAmGKluL8C68MAAEyDeq/ttkjKfkoAwPU2cHvulRSnuNEBl1yY+oOv6wAAAABTrNRyiAqw7gwAwDQYTpR/STKuBABcbwN3Kye40Q31a59KJlYIAQAAAFNv56v2XXwbGWDdGACA6VCK42kAYFUMANARzVc+IQIAAABMk8Fg4D4LrOvfjwQwteq9d94kyb2UAIDrGR9P2d3wNh243vv1T5PT/ioEAAAATN/u+2EawLoxAABTbDi54sAkc5UAgOsqu906mb9ACFqvfuljIgAAAMA0Kskt63477KEErD0DADDVquP/AWCVbnk7DWi/yy5J/f5XdAAAAIBp1qQ5WAVYewYAYArVvRZtkOS+SgDADZXdbysC7b/e++Znk6uWCwEAAADTrVQPXMI6MAAAU2i4cPyAJBsoAQCrcPNbaUDr1S9/XAQAAACYiT14yu3rPZfsogSsHQMAMJVKfYgIALAKCxambG+/RrvVU/6YevIfhAAAAIAZ0kzmX1SAtWMAAKZIPSRjSe6nBADcUNltz2QwJgTtvt477ssiAAAAwEzuxUt5kAqwdgwAwBSZPG/xvkm2UAIAVmH322hA69XvGQAAAACAGd6N71vvvv1mOsCaMwAAU6UxhQYAq1NufmsRaLV66p+T0/4qBAAAAMys8eF4dfoyrAUDADBVSj1ABABYzdfkLZwAQLs5/h8AAABma1PuAUxYGwYAYCq+e+6+/c4l5RZKAMAqLFiYbLeTDrTb976iAQAAAMyK+sC6NOM6wJoxAABToBnPg1UAgFUrO98iGbjspMXOODn1b3/SAQAAAGbH5pPZ/i4ywJrxSyxMgdo0jv8HgNXZeXcNaPe13ne+KAIAAADMpqbxGgBYQwYAYD3VvXfdOKXsqwQArFrZyQAALb/e+/7XRAAAAIBZNCjlQBVgDf9eJID1M5y/4n5J5ioBAKuxyy01oL0uPC/1lD/oAAAAALOoJnvWey7ZRQm4aQYAYH2V6tgZALixr8qdbi4CrVV/9r2kViEAAABgljXD+kAV4KYZAID1UJNBau6vBACsxlbbJhtvpgPtvd474QciAAAAwCjs0WvxQCasAQMAsB4m99vhLkm2VgIAVq3sfAsRaK9aU0/4oQ4AAAAwCkqW1rttuZEQcOMMAMB6fdk0ps0A4MYYAKDF6l9/n1x4nhAAAAAwGuYNx+ffWwa4cQYAYP3+gA5QAQBWr+ywqwi018+/pwEAAACMlOK+DNwEAwCwjurdF21fk1srAQA3YsnOGtDe671ffF8EAAAAGK3d+gHV/U24Uf5AYB01g7EDkxQlAGD1igEA2mr5lam//YUOAAAAMFLKzSb2XXxHHWD1DADAOqolD1IBAG7Exput/AfaeK33258lEyuEAAAAgBFTBgP3Z+BGGACAdVDvu/XCJPsrAQA3shnb3tP/tPh676QTRQAAAIARNEg9QAW4sb8RYK0NJ+beO8l8JQDgRiw2AECL/f6XGgAAAMAIqsnt69LtFisBq2YAANZFUx8oAgDcuLLEAAAtVWvqH3+tAwAAAIymMqzlATLAqhkAgHX7brmPBgBwEwwA0FZnnpJcepEOAAAAMLLcp4HVMQAAa6kuXbxrkp2UAICbsNjXJS293vv9r0QAAACA0XbvekjGZIAbMgAAa6mppsoAYE2UbbyKjXaqvz9RBAAAABhtm02cu+QOMsANGQCAtVQTAwAAcFM23SLZYEMdaKc//FIDAAAAGHFj7tfAKhkAgLVw9XEyS5UAgBvn6X9a66rlqaf8UQcAAAAYcR7YhFUzAABrYfLc7e6cZDMlAOAmGACgpepffpdMTgoBAAAAo++udelWjqCE6zEAAGv1B1NMkwHAmth2ew1oJ0//AwAAQFvMHTbz9pMBrssAAKyFagAAANaIVwDQ2uu9U/8iAgAAALRlH+++DdyAAQBY0y+Ru225UZK9lQCANWAAgLY69c8aAAAAQEsMSgwAwPX/LiSANTMcW7B/kjlKAMBNK14BQEtVAwAAAADQnn18smddup0nUeBaDADAmjNFBgBr6mbbakD7XHpxcuF5OgAAAECLDJuxe6kA/2QAANZQLd4jAwBrZMONk/kb6ED7rvdO+4sIAAAA0DYDD3DCdf8kgJtUl263uKTurgQArIEtt9aAdvqb4/8BAACgdWq9d02KELCSAQBYA8Om3E8FAFgzZQsDALRTPc0AAAAAALTQ1hP7b3cbGWAlAwCwRn8pjv8HgDW2+c00oJ1O9QoAAAAAaKOxOnAfB65mAABuQk0GqbmnEgCwhrbaRgPaed3391NFAAAAgDbu6WsMAMDVDADATZjYf/vbJ9lKCQBYM14BQCs1TXLBOToAAABAO+1X91m8QAYwAAA3aczUGACsnS0NANBCF56XTEzoAAAAAO00f3Le4G4ygAEAuEm1NgYAAGBtbHEzDWjfNd95Z4kAAAAArd7ce6ATEgMAcOPfFXst2iApd1UCANZc2WxLEWifcwwAAAAAQJsN4oFOWPm3AKzW5Mbj+ySZrwQArIVNNteA9jnn7xoAAABAi9WU29Z9Fvthit4zAAA3psl+IgDAWhgfTxZupAOt4xUAAAAA0HqD4dzB3WSg938IEsDqlVQDAACwNjbeLClFB9rn3H9oAAAAAC1Xq/s6YAAAVvclseeec5PcWQkAWHPF8f+0lVcAAAAAQOuV4mRnMAAAqzG55aV7J9lACQBYCwYAaKl6/tkiAAAAQPvdod5tS++npNcMAMDq/jiqKTEAWGubGgCgpS69SAMAAABov/HJuQvuKgN9ZgAAVqM6JgYA1p4TAGijK5clExM6AAAAQBc07u/QbwYAYBXq0ownZR8lAGAtbbyZBrTP5ZdqAAAAAB1RYgCAfjMAAKswURbvlVTviAGAtd1gbejrk/apjv8HAACALrlz3WvRBjLQVwYAYBXGHA8DAOtmoQEAWuiySzQAAACA7pg7uWHZWwb6ygAArEJ1PAwArJsNDADQQgYAAAAAoFMGtbjPQ38//xLAddVkkJS7KwEA62DhhhrQPpderAEAAAB0SC0e9KS/DADA9Uws3e42STZVAgDWgVcA0EaXOwEAAAAAuqXsU/fcc64O9JEBALiesWbsHioAwDoyAEALVa8AAAAAgK5ZMLnF5XeUgT4yAADXU0t1LAwArKOygVcA0ELLLtcAAAAAOmZQqgc+6ednXwL4p5qUpN5dCQBYR04AoI0mV2gAAAAAHVPjgU/6yQAAXNu+2++RlJsJAQDraIOFGtA+ExMaAAAAQPfcvS7NuAz0jQEAuJZm4DgYAFhnc+YkgzEdaJ9JAwAAAADQQRtOZMntZKBvDADAtdTEcTAAsK7mzteAdjIAAAAAAJ001sSDn/SOAQC4LgMAALCu5s7TgHbyCgAAAADopJrsqwJ9YwAArvkSuPv2OydZpAQArKN5TgCgpYaTGgAAAEAXldy9JkUI+sQAAFxtOGj2UQEA1oMTAGiriRUaAAAAQDdtkbtvt5sM9IkBALhGGewtAgCsx1epEwBoq0knAAAAAEBXDQdjd1GBPjEAAP+n+gIAgPUx1wAALTU5oQEAAAB0VakeAKVXDABAkvqAXecluY0SALAevAKAtmqGGgAAAEBHlcQDoPSKAQBIMrlsYq8k7loAwPowAEBrd0VjGgAAAEBH1eQ29b5bL1SCvjAAAEkGpXH8CwCsrzE3UWnrxaBtEQAAAHTY+ORVc+8gA33hly5IUksMAADAel9ZGgDAZxcAAAAYwa1/qtcA0KPPO5BUCz8ArP+VpUtLWsrpFQAAANBptQ48CEpv+JUWi/5dt75ZUnZQAgDW98rSpSUtZQAAAAAAuq3UfUSgL/xKS+8N5869qwoAMBVXlm6i0lJj4xoAAABAty2qS7dbLAN9YACA3qtNdewLAEzJlaVLS3x2AQAAgNE0zJjXQdMLfumi90rx3hcAmJorS5eWtJQTAAAAAKDzPBBKX/iVln4v9odkLKl7KQEAU3Fl6RUAtPWza1sEAAAAXVdKnABAL/ili15bcfbiPZNsrAQATMWVpUtLWsoJAAAAANAHd6x77TVHBrrOr7T02vhgYNoLAKZKM9SAdjIAAAAAAH0wf2Lj824jA11nAIBeq/G+FwCYMsNGA9pp3nwNAAAAoAfGhtWDoXSeAQB6rcb7XgBgyjgBgLaav0ADAAAA6IFaPBhK9xkAoL+L/N67blySWygBAFNkOKkB7bRgAw0AAACgB2qKB0PpPAMA9NbkghV39jcAAFNo6AQA2qnMcwIAAAAA9OI3gGTXunTRlkrQZW5+0uMPv/e8AMCUcgIAbTXfCQAAAADQE2XYDO4sA11mAIDeqk3uqAIATCEnANBWC5wAAAAAAH1RivtDdJsBAHq8wuf2IgDAFHICAG3lBAAAAADojZri/hCdZgCAfi7u99puiyTbKwEAU6hxAgAtZQAAAAAAeqQaAKDTDADQS5PDMYs7AEw1rwCgrRYYAAAAAID+KDvUpYu21IGuMgBAPz/4tTEAAABTzSsAaKv5CzQAAACAHpls5txGBbrKAAC95P0uADANnABAWy1YqAEAAAD0yCAeFKXLn2/ooer9LgAw9ZwAQEuVjTYVAQAAAHqkDjwoSncZAKB/i/p9t15YUnZTAgCm2LDRgHbaZDMNAAAAoEdq9aAo3WUAgN6ZXD7/tknGlACAKd44rbhKBNppztxk/gY6AAAAQE+UZPe61yI/BtBJBgDo4Yfee10AYFpcuUwD2mvjTTUAAACA/hib2HhwaxnoIgMA9E4dxAAAAEyH5VdoQGuVjb0GAAAAAPpkrBb3i+gkAwD0TqkGAABgWlxpAIAWcwIAAAAA9Eqt1f0iOskAAP1azPfaa05NbqkEAEyD4WSy4iodaCcDAAAAANAzTgCgmwwA0CsTG599yyTzlQCAaXLlMg1oJ68AAAAAgL65dd1rrzky0DUGAOjXB74OTHMBwHRafqUGtNMmBgAAAACgZ+av2Ojc3WWgawwA0Cve5wIA0/xd6wQAWqpstKkIAAAA0DNj1WsA6B4DAPRKSbmDCgAwjQwA0FabbakBAAAA9EyNB0fpHgMA9GgRT0lyGyUAYBpdeYUGtNNW22gAAAAAPVMSAwB0jgEA+mO/xbsm2VgIAJhGTgCgrRv+LQ0AAAAAQA/d7uoHSKEzDADQG8MMTHEBwHRzAgBttdW2GgAAAED/bJr9dthRBrrEAAC9UUu9nQoAMM0MANBW8+YnG22iAwAAAPTMMEMPkNIpBgDojVLrbVQAgGnmFQC0+XrRawAAAACgd0pyaxXoEgMA9GgFL7cUAQCmV112mQi0lwEAAAAA6J3q/hEdYwCAfizeey3aIMkOSgDANLvkQg1or60MAAAAAEDflGRPFegSAwD0wsTG43v4vAPADDAAQJs5AQAAAAB6pyY3r3vtNUcJusINUfrxQR+a3gKAGWEAgBYrBgAAAACgj+Zk4fm7ykBXGACgF+qg8f4WAJgJl1ykAe219SINAAAAoIeGg+pBUjrDAAC9UGoxAAAAM6A6AYA2XzMu2kEEAAAA6KFSPUhKdxgAoC8s3AAwEy65MKlVB9pp2+2TsXEdAAAAoGdq8SAp3WEAgO4v2vssXpBkRyUAYAZMTCRXLNOBdhof9xoAAAAA6KFSPUhKdxgAoPMmxsf2SDKmBADMEK8BoM0b/u12FAEAAAB6pia716VxLCCdYACA7n/Ix4amtgBgJjdMBgBos8U7aQAAAAD9MzfZcVcZ6AIDAHRerd7bAgAzygAALVYW7SACAAAA9NCwmXQ/iU4wAEDneW8LAMywSy7SgPbyCgAAAADopVLKnirQBQYA6LxaDAAAwIxyAgBt3uwbAAAAAIBeqnE/iW4wAEC3F+ulO84vyc5KAMAMfv8aAKDNFm2fDGyTAAAAoG+KAQA6wi9bdNpEJm6RZEwJAJhBF5yjAe01Z26yzRIdAAAAoGdqsntdmnElaDsDAHT7A94U01oAMNPOPUsDWq3sfAsRAAAAoH/mpSzaRQbazgAAnVYHBgAAYMa/f8/9hwi02y57aAAAAAA9NGwG7ivRegYA6LRSva8FAGbcuWcltepAe68hnQAAAAAAvVRK2VMF2s4AAJ1WEws1AMy0FVcll12sA+3d7BsAAAAAgF6qHiylAwwA0N1F+gG7zivJzkoAwCx8D597lgi013Y7JPMX6AAAAAA9U2IAgPYzAEB3Xb5ilyTjQgDALDj3HxrQ4l3SWMoOu+kAAAAAPVOTm1f3T2k5H2A6azhe/WoLALPFCQC03S57aAAAAAD9syBLt1skA21mAIDOKsPsqgIAzI56nhMAaPm15M63EAEAAAB6aDLF/SVazQAAnVVLdlEBAGaJVwDQdjs7AQAAAAD6qMQDprSbAQC6zAINALPFKwBo+2Z/99skA9slAAAA6JvaeMCUdvOLFl1mgQaA2doonWcAgJZbuGGyvctJAAAA6JtSih8EaDUDAHRS3WuvOUm2VwIAZsl5Zye16kC7N/y3vIMIAAAA0DMl1QnTtJoBALppwdk7JRkXAgBmycSK5MLzdKDdG/49bi8CAAAA9ExN2U0F2swAAJ00HBTTWQAw25ulM08RgXa75e00AAAAgP7ZsN5rp61loK0MANBJpcT7WQBgtp35Nw1o9zXlTrsnCxYKAQAAAD0zOdG4z0RrGQCgkxoDAAAw6+qZp4pAy3dLYyk3v7UOAAAA0DMl1UnTtJYBALq5MDexMAPAbDvDKwDogD1vrwEAAAD0TPWgKS1mAICOLswDAwAAMNvfx2caAKD9yh4GAAAAAKBvnABAmxkAoHNqMiipOyoBALPs76clzVAH2r3hv+3eycC2CQAAAHrGAACt5Zcsume/HXZIMk8IAJhlEyuSc87SgXbbeLOUnXbXAQAAAPplNwloKwMAdM7koHovCwCMCK8BoBNuf1cNAAAAoF82q3fffjMZaCMDAHTwQ+29LAAwMs78mwa0XjEAAAAAAL0zMeZ+E+1kAIDOaZo4AQAARkQ1AEAHlNvdJRmMCQEAAAA9MkgMANDWzy50SykWZAAYGWcYAKADFm6UsvutdQAAAIAeKQYAaCkDAFiQAYBpU888RQS6wWsAAAAAoFdqceI07WQAgG4txkmpyc5KAMCIOPvvyfIrdaD1yh3uJgIAAAD0SeOBU9rJAADdsu8O2yTZQAgAGJWN0jD1b3/SgdYrt7pjMmeuEAAAANAXTgCgpQwA0CkTY5M7qAAAI+bk32tA+81fkHLbvXUAAACA/ti6PmDXeTLQNgYA6NYHuo4tUQEARks9+Q8i0AnlrvcWAQAAAPqj5LIV28lA2xgAoGMrcTUAAACj5q9OAKAj15p3u68IAAAA0COTcxr3nWgdAwB0SlNjIQaAEVNP+UNSqxC039bbpey0uw4AAADQE6UZbK8CbWMAgG7pn/RkAACAAElEQVQtxCkGAABg1Cy7PPnHGTrQDV4DAAAAAL3h5GnayAAAHVuJLcQAMIrqyV4DQEcuNw0AAAAAQG9UJ0/TQgYA6BpHsQDAKG6WTv6DCHRC2eP2yeZbCQEAAAC94MFT2scAAN1Zgvfcc26SmykBACPor04AoCs7qEHK3vvrAAAAAD1QildP0z4GAOiOLS7fzmcaAEaTVwDQqc2/1wAAAABAL1QnT9NCbpbSGZNpTGEBwKg6+8zk8kt1oBPK3vsnCzcSAgAAALpv03q3Lf0IQKsYAKAzyqCawgKAUVVr6il/1IFumDsv5W730QEAAAD6YLCBB1Bp10dWArqi1IEFGABG2R9/rQHdufa810NEAAAAgB6YHK/uP9EqBgDojBoLMACM9Hf1SSeIQGeUO+6bbLaFEAAAAND13wCq+0+0iwEAOsQCDAAj/U1tAIAuGRtP2fcBOgAAAEDHVSdQ0zIGAOiMkmIBBoBRdv45yXn/0IHuXH/e68EiAAAAQNf3/x5ApWUMANAZNbEAA8Cof1+fdKIIdOcHgFvfOdlqWyEAAACgy2rdXgTaxAAA3Vh791q0QZLNlQCAEf/O9hoAOrWbGqTsf4AOAAAA0GG1OIGadjEAQDdsNNf0FQC0gRMA6Jhy34NFAAAAgC7v/ZMlNSlK0BYGAOiEydqYvgKAFqh/+V2y4ioh6M6PALvumXLzWwsBAAAA3bUgSxdtIQNtYQCATii1GgAAgDaYWLFyCAC6dC16wKEiAAAAQIdNNHPch6I1DADQCaXUxSoAQEt4DQBduxa9z78kG2woBAAAAHTUIE6ipk2fV+iAWsoiFQCgJd/bvzcAQMcsWJiy9EE6AAAAQEeVlG1VoC0MANANNTcTAQBa8rX9u1+IQPd+CDjgkSIAAABAZzf+zdYi0BYGAOiIauEFgLY4/5zknL/rQLd+B7jlHVJ2voUQAAAA0EG1FA+i0hoGAOiIYgAAANq0afrl8SLQvSvSBzkFAAAAADqpehCV9jAAQFdYeAGgTXumE34kAp1T7ntwMn+BEAAAANC9Xb8TAGgNAwC0Xt1n8YIkGyoBAC36/j7xh0mtQtAtG22Scr+H6QAAAAAdU51ETYsYAKD95oxtIwIAtMwF5yann6wD3dtgHfLEZGCbBQAAAF1S4hUAtIdfpmi9ibGhY1cAoIXqiT8Uge5ZvFPKXe6pAwAAAHTLpvUBu86TgTYwAED7P8RDx64AQBvVE34kAp1UDnmiCAAAANA1V165lQi0gQEA2q84dgUA2qj+6sdJMxSC7l2e3v6uKbvtKQQAAAB0yEQZcz+KVjAAQOuV4gQAAGilyy9N/fPvdKCb16gPcwoAAAAAdMlg2LgfRTs+qxLQdrWWm6kAAC11otcA0E3lXg9JttpWCAAAAOjMZt8DqbSDAQA6wCsAAKC13+K/+IEIdNP4eAYHPUYHAAAA6IjigVRawgAA7VdjAAAA2vo1/rtfJFctF4JOKgc9JtlkcyEAAACgA5rigVTawQAArVctuADQXiuuSj3pBB3opgULM3jY43UAAACADijFCQC0gwEA2r/gxoILAG1Wj/+WCHT3WvXgxycbbSIEAAAAtF31QCrtYACAdq+1e+01J8lmSgBAi7/Pj/+mCHTXwg0zeKhTAAAAAKDtSrySmnYwAEC7bXLOzVauuQBAa511enLqX3Sgs8ohT3QKAAAAALRcTZxITSsYAKDVJibGTFsBQBc2UF4DQJct3Cjl4MfpAAAAAO22ZT0kYzIw6gwA0O4P8GBoAAAAOsBrAOj8devDn5RsuLEQAAAA0F5j+fvWW8jAqDMAQLuVYgAAADqg/v6XycUXCEF3Ldwo5WFP0AEAAABabMX4HPelGHkGAGi1kmypAgB0QDNM/cl3daDbm6//9+Rk862EAAAAgLbu7TNmY08LPqfQYk3NZioAQDfU478lAt22YGEGj3mODgAAANBSZWzovhQjzwAA7V5ok01VAIBuqD//XrLiKiHo9vXrgYcmO+4mBAAAALTR0H0pRp8BANrOQgsAXXHlstRf/VgHOr4DG8vgiS/UAQAAAFqopGyqAqPOAABtX2ottADQIV4DQC+uYO9+v5Rb30kIAAAAaJnGg6m0gAEA2r7UWmgBoEPq8d9KahWCziuHvTQpRQgAAABo037eAAAtYACAVqspm6kAAB1y7lmpv/uFDnReueUdUu7xQCEAAACgTQbuS9GCj6kEtJlJKwDonvqdL4pAPzZjh70smb+BEAAAANAWjZOpGX0GAGg7Cy0AdEz97heT4aQQdN/W22XwyKfqAAAAAK1RNtWAUWcAgNaqe+45N8kCJQCgYy6+IPVXP9GBXiiHPi1ZsosQAAAA0IZ9fPFgKqPPAADttc0V3rMCAB1Vv/MFEeiHOXMzeNardAAAAIAWqIl7U4w8AwC0V3PVpiIAQEc3U9/7SjKxQgh6odxpv5T9HiAEAAAAjL5NJWDUGQCgtSYysMgCQFddfmnqz7+vA/3ZmD3jlcmChUIAAADAaNugPmDXeTIwygwA0FolZVMVAKC7vAaAXrnZogwe/QwdAAAAYNRdctkmIjDKDADQWqV6zwoAdFn90TeT5VcKQX+ubx/+5GSHXYUAAACAUTYY31QERvojKgFtVbxnBQC67cplqT/+tg70x5w5GRzxlmQwpgUAAACMqIk5xQOqjDQDALSYVwAAQNfV735RBPp1hbvH7VMOeYIQAAAAMKp7d/enGHEGAGitpmm8YwUAOq7++FvJJRcKQb82aU98oVcBAAAAwIgqQydUM9oMANDeBdaEFQB038RE6rc+rwP9MmduBi98k1cBAAAAwAgqg3gFACPNAAAtXmFNWAFAH9Qvf0wE+nepu+deKQf9mxAAAAAwerv2TTVglBkAoL2qCSsA6MVX/il/TP3jr4Wgf5u1Jx2RbLejEAAAADBCvKKaUWcAgDbbVAIA6If6lY+LQP/MX5DB849KStECAAAARkQZFA+oMtIMANDeBbZkQxUAoB/qtz+fLL9SCPp3zXv7u6Yc8kQhAAAAYFTUbCQCo8wAAC1eX7OBCgDQE8suTz3uyzrQz03bk16UstueQgAAAMBoWCABo8wAAG1mAAAAesRrAOitOXMzeOW7kwULtQAAAIDZVt2fYrQZAKDFigUWAPq0t/rNz5LTTxaCflq8UwaHvUwHAAAAmG3FAACjzQAALVYdsQIAPdN87ZMi0FvlwY9K2f8AIQAAAGA29+dOqGbEGQCgleqee85NMq4EAPTsGuCrn0omJ4Wgvxu4570+2Xo7IQAAAGCWNIkHVBlpBgBop62Wma4CgD666PzU47+pA/210SYZvOgtycBWDgAAAGaDEwAYdX41op0mhhZXAOip+tkPiUCvlTvcNeVfnyUEAAAAzIrqHhUjzQAA7TTP8SoA0Nst1q9+nHry74Wg3xu5xzwn5c5LhQAAAIAZVwwAMNIMANBKKyZNVwFAn9XPfFAEer6TG2Twsrcn2y7RAgAAAGaWh1QZaQYAaKUy5v0qANBn9Zv/m1x0vhD028abZvCKdyVz5moBAAAAM2esPmDXeTIwqgwA0Eqlmq4CgF6bWJH6pY/pgOviPW6XwTNeKQQAAADMpCsn3adiZBkAoJVK4wQAAOi75vP/nUxOCoFr44f8a8r9DxECAAAAZsrE0H0qRpYBAFr6yR1YWAGg784/J/X7X9EBkgye97qU3fYUAgAAAGbCnOo+FSPLAADt5AQAACBJ/cwHRYAkmTsvg1f9Z7LxZloAAADANFsxdJ+K0WUAgFYqiXerAACpJ52Q+odfCQFJsmiHDF773mTOHC0AAABgGpVx96kYXQYAaOnK6mgVAGCl+lmnAMD/XSbf5s4ZPO/1QgAAAMB07r8b96kYXQYAaKfqaBUA4OrLguO+lJx/thBwtfKAh6c89HFCAAAAwHTtvQfj7lMxsgwA0ErNwNEqAMDVJibSfOp9OsC1N3pPf0XKXe4pBAAAAEwHJwAwwgwA0E5OAAAArn1p8PmPJBdfIAT8305vLIOXvzNlx5trAQAAAFOtelCV0WUAgFYqFlYA4NqWX5Hmf/9LB7i2hRtm8PoPJptsrgUAAABMoTJwAgCjywAALV1ZnQAAAFxX/ewHk2WXCwHXtu2SDF5zbDJ3nhYAAAAwVZxUzQgzAEA7lfgFEwC4rssuSf38h3WA61863+bOGbzy3clgTAwAAACYks12mSsCo8oAAO1Uq18vAYAbaD713uSq5ULA9ZS73SeD57xGCAAAAJgKjftUjC4DALRUsbACADd00fmpX/mEDrCqK+gHPzrl0MOEAAAAgPXeZBsAYHQZAKCtLKwAwCo1HzsmmZgQAla1AXzSESn3f5gQAAAAsB4a79ljhBkAoJ28AgAAWJ1zz0r99ud0gFUpJYPnvzHlTvfQAgAAANZZHdeAUWUAgHYqXgEAAKxe8z/vTppGCFiV8fEMjjwmZbc9tQAAAIB14RUAjDADALSVySoAYPXOODn1uC/pAKuzcMMM3vjhZMkuWgAAAMDaajyoyugyAEBLWVgBgJvYh33gLclwUghYnc22zNhbP5psu0QLAAAAWBsl7lMxsgwA0FKOVgEAbsKZf0v92qd1gBuz1bYZe8tHky231gIAAADWUElxUjUjywAA7VRNVgEAN6354FuTq5YLATdm0Q4ZO/rjyWZbagEAAABrxIOqjC4DALSTo1UAgDVx/tmpX/wfHeCmLNklgzd/JNloEy0AAADgprhPxQgzAEBbOVoFAFgjzYffkVxxuRBwE8out8zgqA8lCxaKAQAAADfOfSpGlgEAWqk4WgUAWFOXXJj66ffrAGtynb3nXhm85thk7jwxAAAAYHW8qpoRZgCAlioWVgBgjTWfODa59CIhYE2utO+4bwb//v5k3nwxAAAAYJU8qMroMgBAW1lYAYA1t+yyNB/7Tx1gDZU77WcIAAAAAFa/c3afipFlAIBWakxWAQBrqX7mA8l5/xAC1lC5474ZvPHDyfwNxAAAAIDrGpeAUWUAgJYyWQUArKUVV6X5yDt1gLW56r7t3hm84b+SBQvFAAAAgGtU96kYXQYAaKVisgoAWJe92Zc/lpx+shCwNtfet9175esA5i8QAwAAAJKkOKma0WUAgLaysAIAa29yMs27X6MDrKVyh7uufB2AkwAAAAAgcZ+KEWYAAAsrANAr9SffSf3ZcULAWiq3uXMGR30w2WBDMQAAAOg7J1UzsgwA0FYGAACAdda869XJ5KQQsJbKbe+Swds+kWyyuRgAAAD0mftUjCwDAFhYAYD+Oe2vqV/4sA6wDsrNb52xt3862XIbMQAAAOinWt2nYmQZAAAAoJeaD741ufQiIWBd7LBrxt752WTRDloAAAAAjBADALTVUAIAYL1cdkma/3qbDrCutlmcsXd8JmXnW2gBAABAv5TiPhUjywAAbWVhBQDWW/3ch1P/9ichYF1tcbMM3vbJlD1urwUAAAB94j4VI8sAABZWAKDHVxSTqe98lQ6wPjbeNIM3fyTl1nfSAgAAgL6YlIBRZQCAtjIAAABMiXrCD1N/+l0hYH0s3CiDt34s5R4P1AIAAIA+cJ+KkWUAgFaqJqsAgCnUvOvVycSEELA+5szN4JXvSjngUC0AAADotloMADCyDADQ1pXVwgoATJ3TT079xHt0gPXeYY5l8PyjMnjyi7UAAACgu4r7VIwuAwC09INrsgoAmFrNh9+enHWaEDAFyqGHZXDEW5KxcTEAAADoIidVM7IMANBWBgAAgKl11fI0R79UB5gi5f6HZPCaY5P5C8QAAACgY5wAwOgyAICFFQDgmiuMn38/9TtfFAKmSLnrvTM4+hPJpluIAQAAQJd2vO5TMbIMANBK1cIKAEyT5p1HJpdfKgRMkbLH7TL2jk8n2y4RAwAAgI5sdp1UzegyAEBbebcKADA9LjwvzfveqANMpSW7ZOw9X0q5zZ21AAAAoAvcp2JkGQCgnarJKgBgGi81vvCR1JNOEAKm0sabZfCWj6bc5yAtAAAAaDf3qRhhBgBoJ0erAADTqWlS3/LiZNIwN0ypOXMzeMnbMnjsc5NS9AAAAKClvKqa0WUAAAsrAMAq1FP+mPqZDwgBU34pX1Ie+9wMXv6OZO48PQAAAGidmuqpEUaWAQDaurQaAAAApl3zoaOTc/4uBEyDcs8HZ/DG/0423lQMAAAA2sUrABhhBgBoK5NVAMD0u3JZmjc8P6lVC5gG5Xb7ZOyYLyRLdhEDAACA9hh4UJUR/nhKQCtVCysAMEOXHSf+KPVLHxMCpst2O2bsXZ9Nud0+WgAAANAO1auqGV0GAGinYmEFAGZO865XJ2edJgRMl403y+At/5Ny6GFaAAAA0ALFSdWMLAMAtJUBAABg5iy/Is2bX+RVADCdxsYzePKLMzj8qGTOHD0AAAAYWYM07lMxwp9PaCWvAAAAZvjq48TjU7/wESFgmpUDD83g6E8km20pBgAAAKPJKwAYYQYAaCevAAAAZkFzzL8nfz9VCJjuy/1b3TFjx3455ea3FgMAAIDRM3CfihH+eEpAK9VcJQIAMOOWX5HmTV4FADNiq20zePunUvZ7oBYAAACMllpXiMCoMgBASxfWXCECADArlyG/+nHq5/5LCJgJ8zfI4FXHZPDY5yal6AEAAMBoKO5TMboMANBK1cIKAMyi5j2vT878mxAwE0pJeexzM3j9B5ONNtEDAACAWVeb4j4VI8sAAO1UcqUIAMCsWX5lmje9MGkaLWCmtgB3uWfGjvlCyk67iwEAAMDsGnhQlVH+eEIbP7iNAQAAYHbVX/809RPvEQJm0uKdMvjPL6bc/2FaAAAAMHtKcZ+KkWUAgJYurCarAIDZ17zvTal/+KUQMJPmzc/giLdmcPhRyfi4HgAAAMy42ky6T8XIMgBAS1dW71YBAEbAcDLNa56VLLtcC5hh5cBDM3jLx5LNtxIDAACAGVUH7lMxugwA0M6FNV4BAACMiLNOS/OOV+oAs6Dcdu+MHfvllFveQQwAAABmTJ10n4rRZQCAtn5yTVYBAKOz6fvap1K//XkhYDZsuU0G//HJlAc/SgsAAABmxNwx96kYXQYAaKemsbACAKN1efLWlyT/OEMImA1z5mbwvNdn8NL/SBYs1AMAAIDpNeEVAIwuAwC0UnUCAAAwapZdlubVT08mJ7WAWVLuc1DGjv1Sys63EAMAAIDpM2fMfSpGlgEAWqkW71YBAEbwGuUPv0rz4bcLAbNpyS4ZHPOFlAc9QgsAAACmx4Jx96kYWQYAaKU6dAIAADCi1ykffnvqL48XAmbTvPkZvOCNGbzkbcn8BXoAAAAwlYblq3+9SgZGlQEAWmnuuHerAAAjqmnSvP55yWWXaAGzrNz34Aze/plk0Q5iAAAAMFW7TfeoGGkGAGiniYHFFQAYXeeeleZ1z0lq1QJmWbn5rTJ27JdT7n4/MQAAAJgCjeP/GWkGAGinsWJxBQBGWv3xt1P/511CwCjYcOMMXvveDA4/KpkzVw8AAADWgxMAGG0GAGin8xZaXAGAkdd84M2pP/++EDAiyoGHZvCuzyWLdxIDAACAdVIT96gYaQYAaKVy0kkrkkwqAQCMtKZJ87pnJ+efrQWMyl7imlcC3OcgMQAAAFhrg8Qp1Yz6ZxTaymsAAIAWuOiCNK94ajIxoQWMig02zOCl/5HBS96WzN9ADwAAANaYEwAYdQYAaPMSa4EFANpx1fL7E9O853VCwIgp9z145WkAu9xSDAAAANZMNQDAaDMAQJtZYAGA9uwNP/3+1OO+LASMmu13yeCYz6c87PFaAAAAcNOK+1OMNgMAtHh9tcACAO3SvPEFyRknCwGjZu68DJ5xZAavfHey4cZ6AAAAcGO8opqRZgCA1qopl6oAALTKFZdn+JInJldcrgWMoLL/ARl7/9dTbru3GAAAAKzOJRIwygwA0GL1Yg0AgNY54+Q0R79UBxhVW2+XwdEfz+Cxz03GxvUAAADgOmpysQqMMgMAtJkFFgBo50bxm/+b+vH/FAJGdqc8lvLY52bwzs8mi3bQAwAAgH9uGWtxAgCj/RmVgBa7WAIAoK2aY49K/fG3hYARVva4Xcbe+9WU+xwsBgAAAFdvFnORCIwyAwC0liNWAIBWa5o0r3lm6ql/1gJG2cINM3jp2zI48phkw431AAAA6Lla3Z9itBkAoL0fXkesAABtd8XlaV78uOSSC7WAEVeWPihj7/tayq3uKAYAAECP1dSLVWCUGQCgvRyxAgB0wT/OSPOaZybDSS1g1G2zOIO3fTLlX5+VjI3rAQAA0EO1GgBgtBkAoMULrCNWAICOXNf84gdpjvl3IaANxsczeMLzM3jnZ5MlO+sBAADQM3M8oMqIMwBAazliBQDo1LXNp9+f+sWPCgEtUfa43cpXAjzs8UkpggAAAPRFnbxYBEaZAQDau746YgUA6JjmP16W+uufCAFtMW9+Bs84MoM3fjjZchs9AAAA+uDCLS4RgVFmAIDWmmMAAADomsnJNK94avKPM7SAFil32i9jH/pWyn0OEgMAAKDblpWTTlohA6PMAADt1ThiBQDooEsuTPOyJyVXXK4FtMmGG2fw0v/I4KVvSxZupAcAAEA3XSQBo84AAO11yZYXiwAAdFE9+fdpjnxaMpwUA1qm3OfgjH3gGyl3uKsYAAAAXdvzJRerwKgzAEB7F9mVR6xcoQQA0EX1Z8eleetLhIA22nq7DN7ysQwOPyqZv0APAACAjqgGAGgBAwC0naNWAIDubiq//PHUj7xTCGijUlIOPDRj7/lyys1vrQcAAEAn1Is1YNQZAKDVHLUCAHRd8/43pX7js0JAW+2wawbHfD6DJ784GR/XAwAAoN08mMrIMwBAq9VqAAAA6P4FT/PG56ee+CMtoK3GxlMOPSyDd3wmWbKzHgAAAK01uFgDRv5TKgHt5qgVAKAHJifTvPzJqaf8UQtosbLH7TP2vq+lPOzxSSmCAAAAtEx1X4oWMABAyz/BJq0AgJ5Ydlmalzw+ufA8LaDN5s3P4BlHZvDG/0623EYPAACAFhl4NTXt+JxCm5m0AgB65Owz07z4ccnyK7SAlit3ukfG3v+1lP0eKAYAAEBLeDU1bWAAgHYvtCatAIC+Xf/86TdpXv2MpBmKAW23yeYZvPo/M3jZ25ONN9UDAABg5HkwldFnAIC2f4AttABA/7aax38rzVGHJ7WKAR1Q7v0vGfuv76Tc/X5iAAAAjLCasYtVYNQZAKDdC21TzlUBAOjlddA3PpvmHUcKAV2x2ZYZvPa9GRx5jNMAAAAARlQzVs9RgVFnAIBWqxZaAKDP10Kf/WDqR48RAjqkLH1Qxj707ZS73lsMAACAETN3coUHUxl5BgBotTocWGgBgF5r3ntU6pc+KgR0yeZbZfC6D2Rw5DHJRpvoAQAAMBqG+cHZF8jAqDMAQKvNGTZOAAAA+q3WNG99aepxX9YCOqYsfVDG3ve1lDvcTQwAAIDZd15JGhkYdQYAaLc5Z5wbiy0A0HfNMM2/Pyv159/TArpm6+0yeMtHMzj8qGTBQj0AAABmSUk8lEorGACg3YvtcZlMcpESAEDvTUykefmTU393ghbQuY1PSTnw0Ix98Jspt7+rHgAAALOgJl5LTSsYAKALC66JKwCAJFl+ZZqXPD459S9aQBdtsziDt35s5WkA8zfQAwAAYEYV96NoBQMAtH+5NXEFAPBPl16U4fMflZx9phbQyQ3Q1acBfOAbKbfdWw8AAIAZUks1AEArGACg/YoTAAAAruP8szN8waOTC8xJQmct2j6Doz+ewVNfksydpwcAAMA0G9Tqhxba8VmVgLar1cQVAMANnHFKhs/5f8mF52kBnd3Rj6U84qkZO/YrKbe4rR4AAADTqNaB+1G0ggEAOvAh9s4VAIBVOuPkNM9/VHLpRVpAl+24Wwbv+t8MnvziZM5cPQAAAKZBHTTuR9EKBgBo/4JbHLkCALDaa6VT/pjmeYcml14sBnTZ2HjKoYdl8N6vpNz81noAAABMsToccz+KVjAAQAdWXEeuAADc6OXSX09K8/xDk8suEQM6rux48wyO+fzVpwHMEQQAAGCKzJkzdD+KVjAAQOs1jSNXAABuSv3z79Ic8djkisvFgK675jSA93w5Zbc99QAAAFh/Nedscp4MtIEBAFpvzpw5BgAAANZkp3rSCWle9Jhk+RViQA+UnW+RwTFfXHkawPi4IAAAAOvuonLSSStkoA0MANB+V0545woAwBqqv/15mpc+MVlxlRjQB+PXnAbwpZRdbqkHAADAOqip7kXRGgYAaL3y4zOvTMplSgAArOGm9YQfrhwCmDC4Dr3ZN+1yywyO+XzKoYclgzFBAAAA1mZPVYvTqGkNAwB0RLXwAgCszdXTz7+X5sinJRMTYkBfzJ2XwZNfnMHbP50s2VkPAACANVXiPhStYQCAbqgWXgCAtb6E+tE30rzM6wCgb8qt9srY+7529WkAfhYAAAC4STVeAUBr2OnTDSavAADWbf/60++ufB3AVcvFgD6ZN//q0wA+kyzeSQ8AAIAbUQbuQ9EeBgDoCgsvAMA6qj//XpoX/mty5TIxoGfKrfbK2Pu/7jQAAACAG1OLEwBoDbt7OqGknq0CAMB67GN//dM0L/y35IrLxYC+ueY0gP/4VLLdjnoAAABcT63uQ9EeBgDoxsKbcoYKAADreU3125+vHAJYZggA+qjc+k4ZO/YrKQcempQiCAAAwNWaQXO6CrSFAQA6oRYDAAAAU3Jd9btfpHnu/0suvVgM6KOFG2Zw+FEZvPHDyc0W6QEAAJBkzljch6I1DADQCeNl0sILADBF6p9/m+bwRyaXXiQG9FS5034Z++A3V54GAAAA0G9XlG///QIZaAsDAHTDpSavAACmUv3LSWmed2hyyYViQF8t3GjlaQBv+K9ky230AAAAeslrqGkbAwB0QjnhrCuSmL4CAJjKDe5fT0rz3EckF50vBvR5v7X3/hn7wDdS7vUQMQAAgP7tiVJPV4E2MQBAhxZgE1gAAFOtnvLHDJ/2kOSs08SAPtt40wxe/o4MjvpQsuXWegAAAH3i/hOtYgCAzqipFmAAgOnwjzMyfOZDU0/5oxbQc+Uu98zYB7+Vcp+DxQAAAHqhFg+g0i4GAOiOEkewAABMlwvOTfOch6f+/kQtoO822iSDl74tgyOPSTbZXA8AAKDTStMYAKBVDADQoQXYBBYAwLS69OI0hz8q9YQfagGkLH1Qxj70rZR97y8GAADQWdUrqGkZAwB0aAE2gQUAMO2uXJbmiMemfv+rWgDJZltm8JpjMzjymGTjzfQAAAA6Z3ww5gRqWsUAAJ3hHSwAADNkYkWaI5+W+tVPagEkudZpAHe7rxgAAEDHLDtTA9rEAACdMV7GDAAAAMyUZpjmjS9I/fT7tQBW2nyrDP79fRkceUyy0SZ6AAAAXXBhOe68y2WgTQwA0B2XbfH3JEMhAABmSK1p3vmqNMe+Xgvg/6w8DeDbKfvcSwwAAKDd+5vEw6e0jgEAurMIn3DCRJJzlAAAmFn1o8ekefdrklrFAFba4mYZvO4DGTzvdcmChXoAAACtVFMNANA6BgDo2kpsIQYAmI3LsE++N82RhyUrrhIDWKmUlAc/OmMf/GbKHe6qBwAA0MaNzeka0DYGAOjYOmwSCwBgttTvfSXNEY9Jll0mBvBP2yzO4C0fy+Dwo5wGAAAAtEopxX0nWscAAJ1STWIBAMzu9diJx6d5xsHJef8QA/inUlIOPDRjH/hGyu320QMAAGiF2jQGAGgdAwB06wNtEgsAYPY3x3/7U4bPfGhy+sliANe17ZIMjv74ytMA5m+gBwAAMNJq3HeifQwA0K2FuJjEAgAYCWefmeEzDkr97c+1AK7r/04D+HrKbe6sBwAAMLLGM3DfidYxAECnNJOxEAMAjIpLL07zvEemfu8rWgA3tGiHDN72yQye+apkzlw9AACAUdPkgg3/LgNtYwCATpmTMQMAAACjZGJFmlc9PfULH9ECuKHBIOWhj8vgvV9J2f02egAAAKPknHLSSStkoHVbbQnolB+cdnaSZUIAAIyQZpjmrS9Jc+zrk1r1AG6g7HjzDN79uQye/OJkzhxBAACAUXCyBLSRAQA6pSS1JKcoAQAweupHj0nz5hclw0kxgBsaG0859LAMjvlCyi631AMAAJhtf5WANjIAQOdUE1kAAKN7rfblj6d54b8lyy4TA1ilsuueGRz7JacBAAAAs7s3Ke430U4GAOicWk1kAQCM9PXaCT9M8/SDkrPPFANYtWtOA/jPL6XsuqceAADAjKvVAADtZACA7n2oBxZkAICR30Sf+ucMn3JA6u9+IQawWmWXPTL4zy9m8NjnJoMxQQAAgBnTeAUALWUAgA4uyMWCDADQBpdcmOZ5j0z9zhe0AFZvfDzlsc/N4F2fTbbfRQ8AAGBGzBm630Q7GQCgc8YzsCADALTFiqvSvOaZqR86WgvgRpU9bp+x930t5dDDnAYAAABMtwvKD0+/SAbayAAA3XPcqacnuUoIAICWqDXNh45O88YXJJOTegCrN3deBk9+cQbv+HSyZGc9AACA6VEd/097GQCgc0rS1JRTlQAAaNne+iufSPOif0suv1QM4Mb3fXvuda3TAPy0AQAATPWmIyeLQFvZJdPNdbk2JrMAAFqonvDDNM84ODn7TDGAGzdv/srTAN7+6WS7HfUAAACmTE1xn4nWMgBANxfmgaNZAABaey136p8zfNpDUv/wSzGAm1RudceMvfcrKQ9+VFKKIAAAwPrvM6oTAGgvAwB084NtYQYAaLcLz0vzrENSv/4ZLYCbtsGGGTzv9Rm86SPJ1tvpAQAArBcnANBmBgDo6MLsBAAAgNabWJHm9c9N884jk6bRA7hJ5Y77ZuwD30w58FCnAQAAAOtsfHK5+0y0lgEAOmmsGgAAAOiK+ukPpHnx45Jll4kB3LSFG2Zw+FEZvPG/k6221QMAAFhL5bJy/Dnn6kBbGQCgo5/sM/+WZFIIAIBuqD/9bppnHJz84wwxgDVS7nSPjH3gGyn3/hcxAACANd9LpPGQKa1mAIBuLs7HZTLJ6UoAAHRH/dufMnzKAaknHi8GsGY22iTZdnsdAACANVZTDADQagYA6DILNABA11x6UZoXPDr1sx/UArhJ9a8npX7s3UIAAABrvo9wf4mWMwBAl1mgAQC6aDiZ5u2vTPOWI5JJb30CVmNiIvV1z7VOAAAAa6XUerIKtJkBALq7QCcWaACADqtf/Giawx+ZXHyBGMANNP91dOopfxQCAABYK3XMA6a0mwEAurtAVws0AEDnr/l+/dMMn3FwcppLP+Baa8OffpP6sf8UAgAAWGvjxf0l2s0AAJ01VosFGgCgD878W4ZPPTD1+1/RAkgmVqS+4fnJ0NH/AADAWrsy3znzLBloMwMAdNeFG/01iV98AAB6sT1fluaVh6U59vVJ0+gBPdZ88K2O/gcAANZJSflTSaoStJkBALq7SJ900oqacrISAAA9UWvqR49J8+LHJZddogf0cRn48+9SP3msEAAAwLrtKVJ/rwJtZwCATisWagCA/m3Wf/rdla8E8AQw9MvEitTXPzeZdBAcAACwbkqN+0q0ngEAOq3WnKQCAEAP/f3UNE8/KPW4L2sBPdF84C2pf/uTEAAAwDqrA/eVaD8DAHRaKSa1AAB668plaY48LM1bjkiGngiGLqt/+GXqJxz9DwAArJ+xycZ9JVrPAACd1gws1AAAfVe/+NE0zzs0ueh8MaCLJlakvuEFSTPUAgAAWB9XZfzvp8hA2xkAoNPm1Dl/SuJXIACAnqu//kmGTzkg9U+/EQM6pnnfm1JP/bMQAADAeinJn8pxcYQgrWcAgG4v1sedurwmprUAAEjOPSvNsw9J/dbntICOqL8/MfVT7xMCAABY//1FcpIKdIEBADqvWLABALjG8ivTvPZZad5yRDIxoQe02cSKNG909D8AADA1SonXStMJBgDovBoLNgAA17tG/OJH0zz9X5J/nCEGtFTz3jckp/5FCAAAYErUprqfRCcYAKDzSrVgAwCwio39n3+b4VMOSP3ZcWJA2/5+Tzoh9dMfEAIAAJgyY2ONE6XpBAMAdF6TMQMAAACs2qUXpXnRY9Ic+3rHiENbLL8yzVGH+5sFAACm0orUs06WgS4wAEDnzRmUPyTxyxAAAKtWa+pHj0lz+KOSi87XA0Zc8743JmecIgQAADBlSvKnclwmlaALDADQ/UX7uFOXJ/mbEgAA3Jj6y+MzfPKDUk86QQwY1b/Tk05I/eyHhAAAAKZ2r5E4/p/OMABAX3gNAAAAN+28f6R51iGpHz1GCxg1y69M8/rnOfofAACYcsV9JDrEAAC9UGu1cAMAsGaGk2mOfX2alz85WXaZHjAimvcelZzpcDcAAGDq1YH7SHSHAQB6oZSBhRsAgLXb/P/gaxk+/V+SU/8iBsz23+Nvfpb6v/8lBAAAMC3G6rhXANAZBgDohWbg6BYAANbBqX/J8CkPSv3MB7WA2bL8yjRvfEHSNFoAAADTYSKXbXGyDHSFAQB6Yc6lk39I4tciAADW3lXL07zjlWle95zkymV6wAxr3vN6R/8DAADTpiR/KiecMKEEXWEAgH4s3iecdUWSU5UAAGBd1W98NsMnH5B68h/EgJn6u/vdL1I//99CAAAA07fvKHH8P51iAIA+LeFeAwAAwPo54+Q0hz3YKwFgJiy/Is3rn+fofwAAYFqV6v4R3WIAgN6oKb9RAQCA9bbiqpWvBHjFU5Nll+kB06T5z9clfz9VCAAAYFrV5Lcq0CUGAOiNUsovVQAAYKrU738lw6cemHqyBwVgyv++fnl86uc/LAQAADDtxsbmnKgCXWIAgP4s4INqAAAAgKl1xilpDnuIVwLAVFp+RZo3vSipVQsAAGC6XZTv/O10GegSAwD0x3fOOCXJJUIAADCl/u+VAE9JLr9UD1hPzbtfm5x1mhAAAMAMqL8sieljOsUAAL1x9QL+ayUAAJgO9ftfXflKgD//TgxY17+jE3+U+sX/EQIAAJiZPYjXR9NBBgDo2ULuNQAAAEyjM/+W5rAHp37o6KRp9IC1sfyKNG8+wtH/AADAjCmN+0Z0jwEAeraQDyzkAABMr+Fkmg8dneYFj04uOFcPWEPNu17t6H8AAGBGjVX3jegeAwD0yjDNiSoAADAT6gk/zPCJ90v9yXfEgJv6eznx+NQvfUwIAABgJl2ZsdP/LANdYwCAXpk7OPMPSZYrAQDAjLjogjQvflyadx6ZTEzoAauy7PI0bzjc0f8AAMBM+205LpMy0DUGAOiVqxfy3ykBAMCMqTX10x9I8/R/Sc78mx5wPc27X5Oc83chAACAmVXi+H86yQAAfVzRLegAAMy4+uffZvjkB6V+8aNiwDV/Fyf+KPUrHxcCAACYcaVxv4huMgBA/xb0VAs6AACz44rL07zliDRHHpZcfqke9Nuyy9O84fmO/gcAAGbFsDbuF9FJBgDo34JeLOgAAMyuetyXM3zi/VN/d4IY9Fbzrlc5+h8AAJgtwzlXNF4ZTScZAKB35lxWf5NkqAQAALPq7DPTvPaZyXBSC3qn/uy41K9+UggAAGBWlOSP5YSzrlCCLjIAQP8W9RPOuqImf1YCAIBZ35A957XJ2LgQ9Muyy9K8+QhH/wMAALOmpjgtms4yAEAvlVJOVAEAgFm9Jn3g/0u5yz2FoHeadxyZnHuWEAAAwOztyVMNANBZBgDo58LeWNgBAJhFW26TwWEv04Heqb/4QerXPy0EAAAwq5o07hPRWQYA6OnCPrCwAwAwO0rJ4AVvSDbaRAv6Zdllad74Akf/AwAAs62Oryi/loGuMgBAL42vPAHAr04AAMy4csAjU/beXwh6p3n7Kxz9DwAAjILTyo/PvFAGusoAAL1Ufnj6RUk9XQkAAGbUlttk8JSX6EDv1J98J/XrnxECAAAYBU6JptMMANBjxQIPAMAMXn6WDF70pmTDjbWgXy6/NM1bXqwDAAAwGttzAwB0nAEA+rvA1/xCBQAAZuz688GPTrnTPYSgd5r/eEVy3j+EAAAARkJNdX+ITjMAQG81Y+UnKgAAMCO2WZzBUzwBTf/UH3879ZufFQIAABiZbcrYeP2ZDHSZAQB6a3zFFT9LMlQCAIBpVUoGz39DssGGWtAvjv4HAABGTE35c/n23y9Qgi4zAEBvlR+df1lJ/qAEAADTet150GNT7rivEPRO87aXJeefLQQAADA6e/RSnQ5N5xkAoNdqvAYAAIBptO2SDJ70Qh3o317r+G+lfutzQgAAACOl1PxUBbrOAAA9X+kbCz0AANO02xpkcMRbkgULtaBfLr0ozZtfpAMAADByhs3AfSE6zwAAPV/oTXoBADA9ykMfn3LbuwhB7zRve3ly4XlCAAAAo+aKOWOn/UYGus4AAL029/tnnpTkUiUAAJhSi7bP4AnP14HeqT/6Zup3viAEAAAwin5RjsukDHSdAQB6rSRNUn+hBAAAU7fLGmRwxFuT+RtoQb9ccqGj/wEAgJFVU36iAn1gAAALvgUfAIApVA55Uspt7iwEvdO87WXJRecLAQAAjOZ+vTZeC00vGADAgl9jwQcAYGos2SWDxx+uA71Tf/SN1O9+SQgAAGBkjY27H0Q/GADAgj+5wgkAAABMwe5qkMEL35jMm68F/XLJhWnefIQOAADAKDujfOfMv8tAHxgAoPfK8eecm+RvSgAAsF7XlY94asqt7yQEvdMc/VJH/wMAAKPOw6D0hgEAsPADALC+dtg1g8c+Vwd6p373S6nHfVkIAABgpHkdNH1iAACSlFos/AAArJux8QxefHQyd54W9MslF6Z5+8t1AAAARl4zVjwISm8YAIAkw8HQAAAAAOukHHpYyi1uKwS907z1JclFFwgBAACMuonxSyd/KQN9YQAAksxZsOCXSa5SAgCAtbLjbhn867N0oHfqd76Q+r2vCAEAALTBr8sJZ10hA31hAACSlK/+9arU/EoJAADWmKP/6auLL0jzjlfqAAAAtEON4//pFQMAcM36P6i+AAAAWGPlX5+ZsvtthKB3mre+1NH/AABAewyq10DTr4+8BLBSqcUXAAAAa3btuMstM3jUM4Sgd+q3Ppf6fUf/AwAA7TEWJwDQLwYA4JovgDrwBQAAwBpcOI6nvOhNyZw5WtAvF1+Q5p2v0gEAAGiTC3LcmSfLQJ8YAICrle+f9rckZygBAMCNbqIe8+yUm99aCHqneetLkosd/Q8AALTKD0pSZaBPDADAdf1QAgAAVqfstmfKoU8Xgt6p3/xs6ve/KgQAANCufXzyfRXoGwMAcO0vguKLAACA1ZgzJ+XFRyfj41rQLxecm+YdR+oAAAC0znBQ3PehdwwAwLX/IJrB91QAAGCV14qPeW7KzrcQgt5p3vay5NKLhQAAANrm0jlbnv4rGegbAwBwbd8/7Y9JPVcIAACurdz8VimPeKoQ9E79+mdSf/A1IQAAgDbu5n9YPpWhDvSNAQC49ldBUlMHP1ACAID/M2euo//ppwvOTfOuV+kAAAC0Uilxv4deMgAAN/xC8D4YAAD+uWl6/OEpO+0uBL3THP1SR/8DAADt3dPUodc+00sGAOB6hgNfCAAArFRueYeU//dkIeid+rVPpf7w60IAAABtdcX4+ZueIAN9ZAAArmfOd//+2yQXKgEA0PcLw7kZvPBNyWBMC/rl/HPSvOvVOgAAAO1V64/LSSetEII+MgAA11OSJsmPlAAA6Plm6UkvSnbcTQh6p3nTC5PLLhECAABoLa97ps8MAIAvBgAArn89uOdeKQ97vBD0Tv3KJ1J/+l0hAACAVmsG8bpnessAAKzCsPpiAADorfkLMjjiLY7+p3/OPzvNMa/VAQAAaLurxpfnZzLQVwYAYBXmlDN+mZTLlAAA6OEm6YkvSpbsLAS907zpRY7+BwAAuuBn5cdnXikDfWUAAFahHJfJ1Hq8EgAAPbsOvNUdUw5+rBD0Tv3yxxz9DwAAdGN/4zXP9JwBAFiN4gsCAKBf5i/I4MVvTQa2SfTM+WenOebfdQAAALqhcX+HfvPLFqzu+6EUXxAAAH3aHD3lJcl2OwpBv9Sa5o0vTC6/VAsAAKALJseHV/5YBvrMAACsxvh5G/0syRVKAAD8f/bu+0+vss7/+Oc6554JTWwUF0jE1XXXRdddy9eGJNj7uu6i2EDFgoqItFBUwAIkdEGKiAgIgrGgiCgCmZkQEDEoClZKMjMJRIqUhJSZ+1zfH9hioaRMuc99ns8/4fV4zJxzzf2e6+5+6d9eHOnNuwhB4+Tvfz3yT/uEAAAAuuSQEwvS/DvvF4ImMwCAh5FuvHF1RLpGCQCALrfBRlHsNysiJS1olqWLozr1czoAAABdI7vdGQwA4JEfFL4nBgCg6w9FH/lUxFZPFoKGHXZyVEcfELF8mRYAAEDXSD7XAQMAeESVpRgAQDdLz3lxpDe+QwgaJ190buRr+4UAAAC6SVVGcaUMNJ0BADyC1kj76ohYqQQAQBfaeJMoZh7j6n+a5/bhqE49XAcAAKCrpIhfpL6F9yhB0xkAwCM9LK4eXhE5z1cCAKALD0Mf+VTEllsLQbPkHNUxB0Q84Op/AACgu1Qp/1gFMACAR5Wi8MAAAOi2d7znbh/pdTsLQePk754T+VrfdAYAAHTjYd/nORBhAACPqp2TBwYAQDfZ+DFRzDza1f80z+3DUX3pSB0AAIButKK1srpKBjAAgEfVM2/RzyPyH5UAAOiSQ9DHDo3YYishaJacozp6pqv/AQCALj3zxEC6eniFEGAAAI8qReSIdIUSAABd8G73wpdFes1OQtA4+cKzIv9snhAAAEB3nvcj3OYM/80AANZE9uAAAKi9TTaNYp8jdKB5bhuK6kuzdAAAALrWaM4+x4H/ZgAAa6AsqktVAACo+eHn45+J2PzvhKBZqiqqI/eJWLFcCwAAoFst7Z03/CsZ4EEGALAGUt/i4Rz5t0oAANT0fe7Fr4j0yrcIQePk75wV+fqfCAEAAHTzqf/HD36dMxBhAABr/viIwvUxAAB1tOnjo9jX9ec00G1DUX15tg4AAEB38zXO8BcMAGDNeYAAANTx0PPxz0Q8YXMhaJaqiurIvV39DwAAdLtc5uTzG/gzBgCwhsrRB/oiYkQJAID6SC95VaSX/7sQNE7+9pmRr79GCAAAoLvP/RE3pnmLblMC/o8BAKzpQ2T+nfdHhC/PBACoi8c+IYp9j9SB5lkyGNUZR+sAAAB0vcrtzfA3DABgLSQPEgCA+hx2PvH5iMdvJgTN4up/AACgQVJkn9vAXzEAgLXQTpUHCQBAHf4A8LI3RprxeiFonPzNMyL/8qdCAAAATbC6nDIyIAP8JQMAWAs9my++NiLuVgIAoIM99glRfOwwHWieoZujOuMoHQAAgIZI89OlS11/Bn/FAADW5lEyJ9oR0acEAEAHH3L2PtzV/zRPVUU1e/+IVSu1AAAAGsHXNsNDMwCAtX2gJA8UAICOfVd7xZsjTX+dEDROnnN65F9dKwQAANAY7SIuVQH+lgEArO0PTWEAAADQkR73xCj2OEQHmmfo5qi+cowOAABAk9zVM3fw5zLA3zIAgLWUrhi6OSJuUQIAoMMON3sfHvG4JwpBs7j6HwAAaKIUl6WISgj4WwYAsC6ya2UAADrq3P/q/4y0w2uFoHlHkwtOc/U/AADQPFV2WzM8DAMAWBcp/UAEAIAOsdmWUXzU1f800ODNUX31OB0AAICmyWUrfigDPDQDAFgH5erqsoh4QAkAgA441Oz1uYhNHycEzVK1ozriE67+BwAAmmhBumJ4sQzw0AwAYB2kq4dXRM5zlQAAmOT3ste+NdL2rxaCxsnnnxb5N78QAgAAaN55KKWLVYCHZwAA6ygV6fsqAABMos22jOIjn9KB5ll0k6v/AQCAxsopLlIBHp4BAKzrD89IfC8ishIAAJP0Prbf7IjHPFYImqU9+uDV/6tXaQEAADTRbT1zB6+TAR6eAQCsozR/aEmKdL0SAACT8C72hndEesGOQtA4+eunRv6tYwgAANDYvwh8P/nnTHhEBgCwHqqcfQ0AAMBE2+xJUex+kA40z6Kbojr7BB0AAIDmKvLFIsCj/JhIAOsulwYAAAATKqUoZh4VscmmWtAsrv4HAABYVeaVl8sAj8wAANZDz9zhayPidiUAACZGetO7Ij1/uhA0Tj7vZFf/AwAATXdF6rtjmQzwyAwAYD2kiCoiLlECAGACPGmbKD50oA40z8I/RHXOiToAAACNliLcygxrwAAA1vunyPfNAACM/yk/RbHvrIiNNtGCZnH1PwAAQEREFKn8gQqwBj8rEsD6KfOqH0WEv8YBAIyj9OZdIz3vpULQOPlrJ0X+3S+FAAAAGi1F/DL1LVyoBDw6AwBY34fOg983M6AEAMA4+bupUXxwpg40Tr7511F9zdX/AAAAlev/YY0ZAMAYSJE8eAAAxuXEUkRxwDERG26sBc3SHo08a7+IkREtAAAAcuHrmGENGQDAWPwg5XSRCgAAYy+95b2Rnv1CIWic6pwTI//+V0IAAABE3NXactE1MsCaMQCAMZAGFt2aI36tBADAGNpqWhS77asDjZNv/nXkc08SAgAA4EEXpznRlgHWjAEAjBlfAwAAMHYnlSKKA4519T/N0x6NPGtfV/8DAAD8L5+/wNowAIAxkz2AAADG6mi/0wci/cv/E4LGqc46IfLvbxACAADgQSNlKn4sA6w5AwAYI60thq6KiLuUAABYT1OfGsX79tGBxsk33Rj5vC8KAQAA8L8HpTyQ+hbeIwSsOQMAGCNpTrQjpR8qAQCwPieUIor9Z0dM2UALmmVkJPLhn4gYHdUCAADgv6WULlYB1o4BAIzpk6j6jggAAOvxOrXzhyI96/lC0DjV2cdHvuW3QgAAAPyZop2+qwKs5c+NBDB2yvuqSyJiuRIAAOtg2lOjeM/eOtA4+Q83Rv76KUIAAAD8mRSxIF05eIsSsHYMAGAsH0YLljwQET9SAgBgLZWtKA48LqJ3ihY0y8jqyEe4+h8AAOBvpW9pAGvPAADGWs4eSAAAa3ukf8eHIz3jX4WgcaqvHufqfwAAgIdQpMLXLsO6/OxIAGOrbK+8KCJWKgEAsIa2/Yco3r2nDjRO/v0NkS84TQgAAIC/kiJ+lfoWWkvDOjAAgLF+KM2/8/7I+XIlAADWgKv/aSpX/wMAADw8ty3DOjMAgPGQfC8NAMAavTa9+2OR/vFfhKBxqjOPiXzr74QAAAB4CKOFz1lgXRkAwDgoW9X3IsK/8gAAPIL01H+O4p17CEHj5N/8PPL5XxICAADgoc5MEX+Y0jd0gxKwbgwAYBykyxffFRF9SgAAPIyyFWnmURE9PVrQLCOrI8/aL6JqawEAAPDQ5kgA684AAMZJSuF6GgCAhzuI7LJnpKc/Swgapzrj6MgLfy8EAADAw8hV4fMVWA8GADBeP1xl6zsR4d96AAD+SnradpFc/U8D5V9fF/kbpwsBAADw8Bb2zFv0cxlg3RkAwDhJl9+6NCKuUgIA4M/09EQ66LiIVksLmmVkdVSzXf0PAADwSHKKb6WIrASsOwMAGEcpJ9fUAAD8+QFk109E+vt/EoLGqb48O2LhH4QAAAB4JLnyuQqsJwMAGM8fsKL9rbBUAwCIiIj09GdG2nl3IWicfOOCyHPOEAIAAOCRLW71L75GBlg/BgAwjlLf4uGIuFYJAKDxenojHejqfxpo9aqojtrf1f8AAACPKn07RVQ6wPoxAIDxflxFdl0NAODg8b59Ij3lH4WgcarTZ7n6HwAAYA3kwvX/MBYMAGC8f8hyOUcFAKDJ0jP+LdLbPigEjZNvXBD5W2cKAQAA8OjubOXh+TLA+jMAgHGWBhbdmiL9QgkAoJF6eiPNPCqiKLWgWVauiOqIvV39DwAAsEbyt1NfjOoA688AACZC8jUAAEBDDxzv3z/Stk8XgsapvjwrYvhWIQAAANZAzsnnKDBGDABgIn7QqsKDCwBonLTdcyPttJsQNE6+YUHkb58lBAAAwJq5u7V8i7kywNgwAIAJkAYW/SZF/FIJAKAxNtgwigOOcfU/zbNyRVRHuvofAABgzaVvpQULRnSAsWEAABMlp/NEAAAac9B4/8yIqX8vBI1TfelIV/8DAACshZwqn5/AGDIAgAn7YRs9LyIqJQCAbpee+bxIb3mPEDROvuFnkS909T8AAMBaWNLafHieDDB2DABggqSBJUMRMV8JAKCrbbBhFAceG1E4atAwK1dEdcTeEZXNLwAAwJrKOc5Lc8J3qMEY8lc5mEAp4usqAABdfcD40IERW28rBI1TnXZ4xOKFQgAAAKyFnAufm8AYMwCAifyBW50viIjVSgAA3Sj924sjvXlXIWic/POrIl94thAAAABrc5aK/NveeYuuUwLGlgEATKB09fDdkfOPlQAAus4GG0Wx36yIlLSgWVY+ENVRMyNy1gIAAGAtFG5NhvH62QIm2HkSAABdd7D4yCcjtnqyEDROdcrnI5YsEgIAAGAtFe18vgowDj9bEsDEKpdXF0bEMiUAgG6RnvPiSG98pxA0Tr7uqsjf+5oQAAAAa++n6crFv5cBxp4BAEywtGDJAxHxPSUAgK6w8SZRzDzG1f80z8oHojra1f8AAADrIuXktmQYJwYAMClPtuR7bQCA7jhQfORTEVtuLQSNU538WVf/AwAArOORqmjnOTLA+DAAgElQ3r/5jyLiTiUAgDpLz90+0ut2FoLGydddFfki/6wCAACwji5P84eWyADjwwAAJkFasGAkcnxTCQCgtjZ+TBT7H+Xqf5pn+bKoZu3j6n8AAIB155ZkGEcGADBJcgr/MgQA1Pcgscchrv6nkapTPhexdLEQAAAA62ZlmcrvyADjxwAAJkmrf+jKiFioBABQN+mFL4v02rcKQePk6+ZHvtg/qgAAAKz7wSpdnPoW3iMEjB8DAJgkKSLnlC9QAgColY0fE8U+R+hA8yxfFtWsfV39DwAAsD7KyqoaxpkBAEyinLIHHQBQrwPExz8bsfnfCUHjVCd/xtX/AAAA6+e+cmX8QAYYXwYAMIl65y6+PkXcoAQAUAfpxa+I9Kq3CEHj5AVXRv6By7sAAADW07fS1cMrZIDxZQAAk88tAABA59tk0yj2PlwHmmf5/a7+BwAAGAM5pfNUgPFnAACT/UOYyvMiolICAOjod5ZPfD5isycJQeNUJx0W8cclQgAAAKyf21qbD86VAcafAQBMstS3cGFE6lcCAOjY95WXvDLSy/9dCBon/2xe5B/OEQIAAGB9z1cpn53mRFsJGH8GANAZzpQAAOhIj31CFPvO0oHmWX5/VLP3c/U/AADAGGhV5VkqwMQwAIAOUK6uvhkR9ygBAHTcgWGvz0U8fjMhaJzqxENc/Q8AADAm8lVpYNFvdICJYQAAHSBdPbwiIrlbFADorHeU7V8dacc3CEHj5J9cEfmH3xQCAABgLCS3IMNEMgCADpGj7QEIAHSOxz4hin2O0IHmWX5/VMccqAMAAMDYWFFGy8IaJpABAHSInv7FV+cIV+AAAJ1xUNj7cFf/00jVCZ+KuOM2IQAAAMbGnNS38B4ZYOIYAEBH/UDmr6oAAEy29Io3R5r+OiFonHz15ZEv/bYQAAAAY3XOStntxzDBDACgk34gWz1nRcSoEgDApHncE6PY4xAdaJ5l97n6HwAAYGzd2uobHpABJpYBAHSQdPmtSyPnHykBAEzaAWHvwyMe90QhaJzqhE9F3Hm7EAAAAGMkRZyZIiolYGIZAECnKcN1OADA5BzMX/WWSDu8VggaJ191WeQff0cIAACAsVMVZetsGWDiGQBAhyn/+NiLIuIOJQCACfXELaLY41AdaJ77/hTV0TN1AAAAGFuXpytuXSQDTDwDAOgw6cYbV+eUz1MCAJjQg8EnPh+x6eOEoHGqEz4dcbf9LQAAwBhz2zFMEgMA6EBVFWeoAABMlPTat0ba/tVC0Dh5/o8jX/5dIQAAAMbWveWytsMWTBIDAOhAUwaGf5UirlMCABh3m20ZxUc+pQPN4+p/AACA8XJeWrDkARlgchgAQKdK2fU4AMD4Hwj2mx3xmMcKQeNUx38y4k93CgEAADDW5y3X/8OkMgCATv3hXBXnRcQqJQCA8ZLe8I5IL9hRCBonz7808hUXCQEAADDGUsSNvf1D1yoBk8cAADr1IXn18N0R4TtyAIDxsdmTotj9IB1onnvvjuroA3QAAAAYD9l//8NkMwCATn5O+hoAAGA8pBTF/rMjNtlUCxqnOu5gV/8DAACMj9GiKM+VASaXAQB0sNbmwz+OiGElAICxlN74zkj/b4YQNE6+8keR+y4WAgAAYFwOXXFx6lt4uxAwuQwAoIOlOdHOkb6iBAAwZp60jav/aaZ7747qGFf/AwAAjJuyOF0EmHwGANDhWql9ekSMKgEArLeUotjnyIiNNtGCxqmOPSjiT3cJAQAAMD4Gy80W/VAGmHwGANDhUt/i4cjhnlIAYP3fK968a6Tn7yAEjZOv+F7k/h8IAQAAME5SpFPTnGgrAZPPAABqIJdxigoAwHr5u6lRfHCmDjTPPXdFdeIhOgAAAIyfkaJKX5UBOoMBANRAa+7QpTniD0oAAOv21l9EccAxERturAWNUx17sKv/AQAAxlOKb6d5i24TAjqDAQDU4tkZuYj8ZSUAgHV6l3jLeyI9+4VC0Dj5sgsjD7j6HwAAYFzPXpFPVQE6hwEA1OWHNVVfiYiVSgAAa2WraVHstp8ONM89d0V10mE6AAAAjKMc+betvuF+JaBzGABATaS+JXdGxLeVAADW/G2/iGKmq/9ppurYgyLucfU/AADAeCpycWqKyEpAB/1cSgD1kVM6RQUAYE2lnd4f6dkvEILmvTf/+NuRBy4RAgAAYHytKEaqc2SAzmIAADXS0zd4ZYr4lRIAwKOa+tQo3revDjTPXX+M6sRDdQAAABh/X09XD98tA3QWAwComxyniQAAPPJbfhHF/rMjpmygBY1THf/JiPvuEQIAAGC8z18Rp6oAnccAAOr2Q9tecXZEul8JAODhpJ0/FOlZzxeCxsk/+lbkeT8UAgAAYJylSL/o7R+6VgnoPAYAULeH6vw774+ovq4EAPCQpj01ivfsrQPNc9cfo/riYToAAABMgJyqL6oAnckAAGqoKvLJKgAAf6NsRXHgcRG9U7Sgee/Ixx3s6n8AAICJcW/ZO+IfFaFDGQBADfXOXXx95LhGCQDgz6W37x7pGf8qBI2Tfzgn8pU/EgIAAGBCDmFxTrp06XIhoDMZAEB9f3pPFQEA+F9PfloUu3xcB5rnzqVRffEzOgAAAEyQdhGnqQCdywAAaqpclS+IiLuVAABc/U+TVUfPjLj/XiEAAAAmxsCUvqEbZIDOZQAANZWuHl6RI85SAgBI79oj0j89WwgaJ//ggsg/uUIIAACAieN2YuhwBgBQY62UT46IrAQANFd66j9H8a6PCUHz3Lk0qlM+pwMAAMAEnsTKjaZ8WwbobAYAUGOpb/imiLhMCQBoqLIVaeZRET09WtA41VH7u/ofAABgAuWI09MlN61SAjqbAQDU/qe4OEEEAGjoa8Aue0Z6+rOEoHHyxV+PfM1cIQAAACbOSCtVJ8sAnc8AAGqunLvoBznyb5UAgGZJT9su0jv3EILmufP2qE75vA4AAAATKaVvpL7Fw0JA5zMAgLo/cyNykdNJSgBAg/T0RDrouIhWSwuaJeeoZu8fsew+LQAAACZQ1a6+oALUgwEAdMMP8vL2mRFxtxIA0JBn/y57Rfr7fxKCxsnf/3rkn/YJAQAAMKGHsZjfO2/4p0JAPRgAQBdIC5Y8kCOdoQQANOC5/w/bRXr7h4Wgee68ParTDtcBAABgoqV0gghQHwYA0CVa7dGTImJUCQDoYj29kQ463tX/NE/OUc3az9X/AAAAE2+wTIPfkQHqwwAAukS6cslgRHgIA0A3v7y/d59IT/lHIWicfNG5ka/tFwIAAGCCpcgnpT7/fAh1YgAAXSQXruEBgK49cD/j3yLt/EEhaJ6li6M61dX/AAAAk+CBYnX4+mGoGQMA6CI9cwfnR8RPlQCAbnvI90aaeVREUWpBs+Qc1dEzIx5YpgUAAMBES3Fmunr4biGgXgwAoOseyPlEEQCgy17a379/pG2fLgSNk797TuRrB4QAAACYhCNZGeVJMkD9GABAlynv3/KCiBhWAgC6Q9ruuZF22k0Imuf24ai+dKQOAAAAkyJfnPoW/lYHqB8DAOgyacGCkZTiNCUAoAtssGEUBxzj6n+ax9X/AAAAk3ssS8UJKkA9GQBAV/5gt0+NiBVKAEDNn+nv3z9i6t8LQePkC8+K/LN5QgAAAEyCFHFjq2/wciWgngwAoBsfzn1L7oxI5yoBADV+nj/zuZHe8h4haJ7bhqL60iwdAAAAJklO+fgUkZWAejIAgC7VLuL48IAGgHraYMMoDjjW1f80T1VFdeQ+ESuWawEAADA57ixXhX8whBozAIAuNWXu4I0R4YoeAKjjS/qHDozY5ilC0Dj5O2dFvv4nQgAAAEzWuSzHqenqYV8xDDVmAADdLKUTRACAmj2+/+3Fkd68qxA0z21DUX15tg4AAACTZ6RVVKfJAPVmAABdrOwbvDhH+p0SAFATG2wUxX6zIlLSgmZx9T8AAEAHSBekvsXDOkC9GQBANz+qI3IR2S0AAFCXl/OPfDJiqycLQePkb5/p6n8AAIBJVlXpOBWg/gwAoNt/yFN5ZkTcrgQAdLb0nBdHeuM7haB5lgxGdcbROgAAAEyuS3vnLbpOBqg/AwDocqlv4cqU4yQlAKCDbbBRFPvOdvU/zVNVUc1y9T8AAMBky7mYpQJ0BwMAaMIPem/PSRFxrxIA0KHP6j0+HbHVNCFonPzNMyJff40QAAAAk+vanoFFV8gA3cEAABogXXbLvTnH6UoAQAc+p5+7faTXv10ImmfolqjOOEoHAACAyVZk//0P3fQjLQE0Q6uVj4+I1UoAQAfZ+DFR7H+Uq/9pnqqK6qj9I1at1AIAAGBy3VxuNnyhDNA9DACgIdIVw4sjxTlKAEAHvYzvcUjEllsLQePkOadH/uVPhQAAAJhsKR+Z5kRbCOgeBgDQIGVqHxURlRIA0AHn6+e9NNJrdhKC5hm6OaqvHKMDAADA5Lu9jNbXZIDuYgAADZLmLvldRFyoBABMso0fE8XMo139T/NUVVSzXf0PAADQCVLkY1PfQgc06DIGANAwVcSRKgDAJL+E7/mZiM3/TggaJ19wWuRfXSsEAADA5Luv6On9kgzQfQwAoGF6+4eujUhzlQCAyZFe9PJIr/5PIWiewZuj+upxOgAAAHSAHHFSuuyWe5WA7mMAAE18sBd5lgoAMAk22TSKfY7Qgeapqqhm7+fqfwAAgM6wqlUVJ8kA3ckAABqoZ+7Qj1LEdUoAwAS/fO/1uYjNniQEjZPPPzXyDT8TAgAAoDN8Jc1bdJsM0J0MAKChcoqjVACAiZNe8spIr3izEDSPq/8BAAA6SbtM+VgZoHsZAEBDlZsPzYmIm5QAgAnw2CdEsa9v4KGB2qNRHfGJiNWrtAAAAOgMc1LfsM8GoIsZAEBDpTnRThFWfgAwES/de30u4vGbCUHj5K+fGvk3vxACAACgQ1RV4XZg6HIGANDkXwCpPDMifM8PAIyjtP2rI+34BiFonkU3RXX2CToAAAB0ihw/6p236DohoLsZAECDpb6FK1PESUoAwDh57BOi2OcIHWgeV/8DAAB0nJwq308IDWAAAE3/JZDKkyPS/UoAwDg8Z/c+3NX/NFI+7+TIv71eCAAAgM5xbU//4rkyQPczAICGS30L78m5+qISADDGz9iX/3uk6a8TguZZ+IeozjlRBwAAgE5SxOdFgKb8uAON1+rJR7sFAADG0OOeGMUeh+hA87j6HwAAoOOkSL8o5w59TwloBgMAINLli+/KEacoAQBj9JLt6n8aKn/tpMi/+6UQAAAAnXRWS/mwFJGVgGYwAAAiIqKVRo+KiGVKAMD6Sa96S6QdXisEjZNv/k1UX3P1PwAAQCdJETeUff77H5rEAAB48CWgb8mdOcepSgDAenjiFlHscagONE97NPKsfSNGRrQAAADoIDnyp1NEpQQ0hwEA8L9aRXtWuAUAANb95foTn4/Y9HFC0Dj5nBMj//5XQgAAAHSQFHFj2T/8XSWgWQwAgP97GehbcmdOcZoSALAOz9HX7BRp+1cLQePkm38d1bknCQEAANBp57UiH+K//6F5DACAv9AqW0dFxANKAMBa2GzLKD76aR1onvZo5Fn7ufofAACgw6SIG8u5w99RAprHAAD4y5eCy29dmsMtAACwVi/V+82OeMxjhaBxqrO/4Op/AACADpRTOtR//0MzGQAAf6OVytnhFgAAWCPp9W+P9IIdhaBx8k03Rnb1PwAAQOed1yJ+XfYNflsJaCYDAOBvpL6Ft+ccX1ICAB7FZk+K4sMH60DzjIxEPmLviNFRLQAAADpMyukw//0PzWUAADykVlHOiogVSgDAw52mUxT7z47YZFMtaJzq7BMi3/wbIQAAADpMjvh1OTD4TSWguQwAgIeU+hbeniOfrgQAPMyz8o3vjPT/ZghB4+Q/3Bj56ycLAQAA0IFSjs/4739oNgMA4GG1qvLIcAsAAPytJ20Txe4H6UDzjIxEPuITrv4HAADoQDniN+XA0BwloNkMAICHleYtui1ynKEEAPz5AzJFsc+RERttogWNU511XORbfisEAABAB0rJf/8DBgDAoyhzcXi4BQAA/u8w/eZdIj1/ByFonPyHGyOff6oQAAAAnXhmi/hDubn//gcMAIBHkeYtui1SfEUJAIiIv5saxQdm6kDzjKyOfPherv4HAADoUCnnQ9OcaCsBGAAAj6qM6siIWKUEAM1+cy6iOOAYV//TSNWZx0a+9XdCAAAAdKAc8Ydyy+ELlAAiDACANZD6Fg9Hii8rAUCjn4dveU+kZ79QCBon//6GyN/4khAAAAAdKuV8mP/+B/6HAQCwRsp28fmIWK4EAI201bQodttPB5rH1f8AAAAdLUX8qhwY/roSwP8wAADW7CVi3qLbcs4nKgFA896YiyhmHhOx4cZa0DjVV46JvPD3QgAAAHSonNJBKaJSAvgfBgDAGmsVrVkRcbcSADRJ2un9kZ79AiFonPybn0e+wNX/AAAAHeynZd/gxTIAf84AAFhjqW/hPSnS0UoA0BhTnxrF+/bVgeYZWR151n4Rla+QBAAA6FQ5qgNSRFYC+HMGAMDa/dJYXR0fEYuVAKD7H3pFFPvPjpiygRY0TvXlo1z9DwAA0Nl+2NO/eK4MwF8zAADWSrp6eEXKcYQSAHT9M+9tH4r0rOcLQePkX18Xec6XhQAAAOjgo1tVFQfLADwUAwBg7X9xLN/iSxFxsxIAdK1pT43iPZ/QgeYZWR3VbFf/AwAAdLg5vfMWXScD8FAMAIC1lhYsGIlIhykBQFcqW1EceJyr/2mk6vRZEQv/IAQAAEDnape5OFQG4OEYAADrpOwfPDdFXK8EAN0mvX33SM/4VyFonHzjgsjf/IoQAAAAHS2dmQYW/UYH4OEYAADr9ooRUeUcn1YCgK7y5KdFscvHdaB5Vq6I6sh9XP0PAADQ4ae3Mo9+RgbgkRgAAOusNTD0vYh8lRIAdIX/ufq/d4oWNE715dkRQ7cIAQAA0MFyxMlpYMmQEsAjMQAA1vOFIx2gAgDdIL3zo5H+6dlC0Lz3uRsWRP72V4UAAADobMtaI6tnyQA8GgMAYL309A/Ni4hLlQCgztJTnxHFu/cUguZZuSKqI/d29T8AAECHSzkfna5a+kclgEdjAACst6pIB0VEVgKAWipbkWYeHdHTowXNe487/ciI4VuFAAAA6Gx3Fqs2OE4GYE0YAADrrXfu4IKI/C0lAKjlC/G7Pxbp6c8SgsbJN/ws8nfOEgIAAKDDpYjD0zU33acEsCYMAIAxUbbzwRExqgQAtTpAP227SO/6mBA0z8oVUR2xd0RVaQEAANDZFher86kyAGvKAAAYE+nKxb+PiLOVAKA2enoiHXhsRKulBY1TnXZExOKFQgAAAHS6nA9JVw+vEAJYUwYAwJgp2+3DImKlEgDU4kV4l70iPfUZQtA4+RdXR77Q1f8AAAAdf36L9LuyGHaAA9aKAQAwZtKVSwZzpC8oAUDHP7P+YbtIb/+wEDTPygeiOmpmRM5aAAAAdLhU5Jmpz1fvAmvHAAAYU63RBz4XEUuVAKBj9fRGOuh4V//TSNWph7v6HwAAoA5y9LfmDn1XCGBtGQAAYyrNv/P+lOOzSgDQsS/A790n0lP+UQgaJ//8qsjfPUcIAACAzldVRewrA7AuDACAsf/FUgydliJuVAKATpOe8W+Rdv6gEDSPq/8BAADq5Gu9fUM/kwFYFwYAwJhLfTGaUzpACQA6Sk9vpJlHRRSlFjROdfLnIpYsEgIAAKDzrSjb7U/JAKwrAwBgXLT6Br8fET9WAoCOefF9/36Rtn26EDROvu6qyBedKwQAAEAdznARR6crlwwqAawrAwBg3FRFtV9EVEoAMNnSds+NtNP7haB5Vj4Q1dH7u/ofAACgFvIfWyunHK0DsD4MAIBx0zt38fURcbYSAEzuA2lKFPvNdvU/jVR98TMR/nEEAACgHlIcnK656T4hgPVhAACMq3I0Do6I5UoAMGkvvB88IGLbfxCCxsnXzY/8/a8LAQAAUIczXMSvyxj+qhLA+jIAAMZVmj+0JEc6RgkAJuU59MznRnrLe4SgeZYvi2rWvq7+BwAAqIsi9k59MSoEsP6/TgDGWSutOCoiblMCgAm1wYZRHHCsq/9ppOrkz0YsXSwEAABAPVzSM3foRzIAY8EAABh3qe+OZZHzp5QAYEJfdD94QMQ2TxGCxskLroz8g/OFAAAAqId2O8X+MgBjxQAAmBDlwPCZKeI6JQCYCOmZz4v05l2FoHmWL4tq9n6u/gcAAKiLFF+e0jd0gxDAWDEAACboHSaqKhf7KQHAuNtgoygOPDai8KpL81RfPMzV/wAAAPWxrIzyUBmAseSvosCE6RlYdEVEXKIEAOP6gvvhgyO23lYIGif/bF7kS74hBAAAQE2kiCNS38LblQDGkgEAMKHKXOwTEaNKADAuB+fnvDjSm94lBM2z/H5X/wMAANTLcLGsfbwMwFgzAAAmVBpY9JtIcYYSAIy5DTaKYt/ZESlpQeNUJx4a8cclQgAAANRFzgekBUseEAIYawYAwIQry9YhEXGfEgCM6YvtHp+O2GqaEDRO/skVkX84RwgAAID6+Fk5MPx1GYDxYAAATLh0+a1LU4rPKgHAmD1bnvOSSK9/uxA0z/L7ozrmQB0AAADqI+eIvVNEJQUwHgwAgEn65TN0fIq4QQkA1tvGm0Qx82hX/9NI1Rc+HXHHbUIAAADUx1k9/UPzZADGiwEAMClSX4xWRdpLCQDW+4X2o4dEbLm1EDROvvryyD/6lhAAAAC1ke4vq+IgHYDxZAAATJqeuYOXR8R3lABgnY/Nz3tppNe+VQiaZ9l9UR3rb0YAAAB1kiIfkuYtco0bMK4MAIBJVbbbe0XEciUAWGsbPyaK/Y9y9T+NVJ3g6n8AAIA6yRG/LpZtcZISwHgzAAAmVbpyyWDK+SglAFjrF9k9PxOxxVZC0Dj5qssi//jbQgAAANRJEXunBQtGhADG/9cNwGT/IhqJ2RFxqxIArKn0opdHevV/CkHz3PenqI6eqQMAAECt5G/2zB36kQ7ARDAAACZdunp4RUTeRwkA1sgmm0axzxE60EjVFw6JuPsOIQAAAOpjRZla+8kATBQDAKAjtPqHvxMRlygBwKO+wO71uYjNniQEjZPn/zjyZRcKAQAAUCMpxeGpb+FCJYCJYgAAdIwy549HxColAHjYQ/NLXhnpFW8Wgua5709RHXOADgAAAPVySxHl0TIAE8kAAOgYaWD4DznSF5QA4CFt+vgo9jlSBxqpOv5Trv4HAAComxyfSH0LVwoBTCQDAKCjtEYf+GxELFECgL95cd3rcxFP2FwIGifPvzTyFd8TAgAAoF5+3BoYcpgDJpwBANBR0vw774+UZyoBwF88H17yqkgve6MQNM+9d0d1tKv/AQAAamZ1WbQ/JgMwGQwAgI5T9g2fGzn6lQAgIiIe+4Qo9nX1P81UHf/JiD/dKQQAAECN5JyPTXOX/E4JYDIYAAAdJ0XkdhF7RMSoGgAUex8e8fjNhKBx8vxLI8/9vhAAAAD1cntr1QZHyABMFgMAoCNN6Ru6ISJOVwKg2dLL/z3S9NcJQfO4+h8AAKCu9k7X3HSfDMBkMQAAOlbZTgdHhDtvAZrqcU+MYo9DdKCRquMOdvU/AABA/VxZ9g+dLwMwmQwAgI6Vrhz8U0Q+SAmAhr6o7v15V//TSPmKiyL3XSwEAABAvYy2q/zRFJGlACaTAQDQ0cr+4TMix3wlAJolvfItkXZw9T8NdO/dUZ34aR0AAABqJkc6bsq84V8qAUw2AwCgo6WIql3E7hExogZAQzxxiyg+dqgONFJ17EERf7pLCAAAgHoZbKUVn5EB6AQGAEDHm9I3dEPO+RglABrygrrX5yI2fZwQNE6+/LuR+38gBAAAQO2kPVLfHct0ADqBAQBQC62R+ExE3KwEQJcfl1+zU6SXvkYImueeu6I66VAdAAAA6mdOq3/wIhmATmEAANRCunp4RS7io0oAdLHNtozio777nGaqjj3Y1f8AAAD1c19Z5k/IAHQSAwCgNnrmDv0oUlygBECXvpjuNzviMY8VgsbJP/5O5AFX/wMAANRNynFQumJ4sRJAJzEAAGqljHKviPiTEgBddmB+/dsjvWBHIWieu++I6sRDdAAAAKifa4sth06VAeg0BgBAraS+hbeniIOVAOgimz0pig/71U4zVcd/MuK+e4QAAACol9EqFx9Kc6ItBdBpDACA+v3i6h86LSJfpQRAF0gpiv1nR2yyqRY0Tr7025EHLhECAACgbue5SMf1Diz6uRJAJzIAAGonRVTtlD4UESNqANT8d/ob3xHp/80Qgua5649RnXSoDgAAAPUz2EorPiMD0KkMAIBamtI3dEOOdJwSADW25dZR7O7qf5rJ1f8AAAA1leNjqe+OZUIAncoAAKit1rLRwyLiFiUAaiilKPadFbHRJlrQOPmH34w874dCAAAA1O9E983WwND3dAA6mQEAUFtpwZIHcsofVQKghr/D37xLpOfvIATNc9cfo/riYToAAADUz31lGXvJAHQ6AwCg1nr6hn8YEXOUAKiRv5saxQdm6kAjVccdHHH/vUIAAADUTEr54HTF8GIlgE5nAADUXpnKPSPiHiUA6vD2WURxwDGu/qeR8iXfiHzlj4QAAACon2uLzYdPkQGoAwMAoPZS38LbU45PKgFQg9/Z/7FrpGe/UAia586lUZ38WR0AAADqZ7TKxYfSnGhLAdSBAQDQHb/MBoZOiRzXKAHQwf5uahTv318HGqk6an9X/wMAANRQTnFC78CinysB1IUBANAVUkRVRvHeiFipBkAnvnUWURxwbMSGG2tB4+SLz498zVwhAAAA6ufWVqw8VAagTgwAgK6RBhb9JkUcrgRAB/6O/q/dIj37BULQPHfeHtWpn9cBAACgfnJO6YOp745lUgB1YgAAdNcvtTR0RIpYoARAB5n61Ch2208HmifnqI6a6ep/AACAejqlp2/wMhmAujEAALpK6ovRdlHtFhEjagB0wttmEcX+syOmbKAFjZMv/rqr/wEAAOppsBxdcYAMQB0ZAABdp3fu4utzjllKAEy+9LYPRXrW84Wgee68PapTfTMRAABAHeWUP5Tm33m/EkAdGQAAXal116afTRE3KAEwiaY9NYr3fEIHmifnqGbvH7HsPi0AAADqJsUZPX3DPxQCqCsDAKA739FuvHF1Oxe7RMSoGgCT8ZZZRnHgca7+p5HyRedF/mmfEAAAAPVzWzma9pMBqDMDAKBr9Q4s+nmOdJwSABMvvX33SM/4VyFonqWLozr18zoAAADUUYqPpCsH/yQEUGcGAEBXa23U+6kc8WslACbQk58Wxa576UDz5BzV0QdEPLBMCwAAgNpJX2v1DV2oA1B3BgBAd7+yXXLTqojq/RHRVgNgApStB6/+752iBY2Tv/e1yNf2CwEAAFA/d5TV6r1lALqBAQDQ9Xr6F1+dUz5JCYDxl9750Uj/9GwhaJ7bh6M67QgdAAAA6qjIH07zbr9DCKArfqVJADRB6/7qoIi4SQmA8ZOe+owo3r2nEDRPzlEd4+p/AACAmprTmjv8LRmAbmEAADRCWrDkgZzyByIiqwEwDspWpJlHR/T0aEHj5AvPjnztgBAAAAD1c1fZan1MBqCbGAAAjdHTN9wXOU5TAmAcXirf/bFIT3+WEDTP7cNRnT5LBwAAgDrKec90+a1LhQC6iQEA0CjlBqv3jYhblAAYO+mp/xzpXcbyNFBVRXXkPq7+BwAAqKOcL24NDJ8nBNBtDACARkmXLl2ei/TB8FUAAGOjpyfSQcdFtFpa0Dj5wrMi/+JqIQAAAOrn3rLIu8sAdCMDAKBxeuYOXh4RZyoBMAYvk7t8PNJTnyEEzXPbUFSnz9YBAACgnj6R+hYPywB0IwMAoJHKVO4TEYNKAKy79A/bRXr7R4Sgef7n6v8Vy7UAAAConfSDsn/oqzoA3coAAGjmK17fwntyxLsiolIDYB309EY60NX/NFP+9lcjX/8TIQAAAOrnzjIVuyVfEQt0MQMAoLF6+ofm5YgTlABYh5fI9+4d6e//SQia57ahqM44SgcAAIBaSh9JfQtv1wHoZgYAQKO1NppyYIr4lRIAa3FUfvozI731g0LQPFUV1ZF7u/ofAACgnr7a6h+cIwPQ7QwAgEZLl9y0qp2LXSNitRoAa6CnN9JBx7v6n0bK3/pK5OuvEQIAAKB+hst22lsGoAkMAIDG6x1Y9PMUcZgSAGvw8vj+/SJt+3QhaJ4lg1GdcbQOAAAA9VPlqHZJVw7+SQqgCQwAACKi6B86MiIGlAB4eOmfnxNpp/cLQfP8z9X/Kx/QAgAAoGZypGN6+hfPVQJoCgMAgIhIEVWZi/dEpPvVAHgIvVOi2P+oiKLUgsbJc74c+Zc/FQIAAKBu57mIX7dS8WklgCYxAAD4b2lg0a0pYl8lAB7ipfEDMyO2/QchaJ6hm6P6iqv/AQAAamhVLqp3pL6FK6UAmsQAAODPlP2DX4rI31cC4P+kZz430n++Vwiap6qimr1/xCp/KwIAAKibFPnTvXMXX68E0DQGAAB/paxG3xcRS5UAiIgNNozigGNd/U8j5W98KfKvrhUCAACgdge6mF9sMXyMEEATGQAA/JU07/Y7oogPKQEQUXzwgIhtniIEzTN0c1RnHqsDAABA/Swri/yeNCfaUgBNZAAA8BBac4e+GynOUgJosvTM50V6865C0Dyu/gcAAKizPVPf8E0yAE1lAADwMMoVU/aMiIVKAI20wUZRHHhsROF1kebJ55/m6n8AAIBaHujiu63+oTOFAJrMX3QBHka65qb7ckrvjnBVFNDAl8QPHxyx9bZC0DyDN0f1VVf/AwAA1NAdZU/LV7sCjWcAAPAIevoGr8w5jlMCaJL0nBdHetO7hKB52qNRHfGJiNWrtAAAAKidtFu6/NalOgBNZwAA8ChaG0/5ZIr4pRJAI2ywURT7zopISQsaJ59/WuTf/EIIAACA2kmnt/oHL9IBwAAA4NFfHS+5adVokd4RESvUALr+5fCjn47Y6slC0DyLborqrON1AAAAqJ+bytEH9pEB4EEGAABrYMrcwRtTxL5KAN0sPeclkd7wdiFoHlf/AwAA1NWqKhdvTfPvvF8KgAcZAACsobJ/6ORIcYESQFfaeJMoZh7t6n8aKZ93SuTfXi8EAABAzaScZvYOLPq5EgD/xwAAYC2UUe4ekRcpAXTdS+FHD4nYcmshaJ5FN0V1zhd0AAAAqJ9LioFBBzqAv2IAALAWUt/Ce3Kkd0dEWw2ga363Pe+lkV77ViFoHlf/AwAA1NXSstV6b4rIUgD8JQMAgLXU0z80L+X8WSWArrDxY6LY/yhX/9NI+dwvuvofAACgfqqc0rvS5bculQLgbxkAAKzLL8+B4c9G5CuUAGr/++xjh0VssZUQNE6++Teu/gcAAKjjeS7FET19g5cpAfDQDAAA1kGKqMqUd42Iu9QAavu77EUvj/Sa/xKC5mmPRp69X8TIiBYAAAD18tPW/VscJgPAwzMAAFhHqW/xcBTFruF7poA62mTTKPY+XAcaKZ9zYuTf/VIIAACAermnzMXOacECa26AR2AAALAeWnMXXRwpTlYCqN1L4Mc/G7H53wlB4+Sbfx3VuScJAQAAUD8fSQOLbpUB4JEZAACsp3LDKfukSL9QAqiL9JJXRnrlfwhB87RHI89y9T8AAED9pNNb/UNf1wHg0bUkAFjPV89LblqVXzrtne0iro2IjRQBOtqmj49inyN1oJGqc06M/PtfCQHU0wPLIpYM6kB9tUc1AGCd5Ihft5aN7qUEwJpJEgCMjdHp23wgIn1JCaCjX/7e8ZFIM14vBM1z59KoPv3BiFEfPgAAANTIqqqoXtA7d/H1UgCsGQMAgDE0On3qeRHxdiUAAAAAANZPivho2T90shIAa66QAGDslD09H46IW5UAAAAAAFgPOV9c9A+dIgTA2jEAABhD6bJb7q0i3hYRI2oAAAAAAKyT4bIn75oishQAa8cAAGCM9fYPXZtS+rQSAAAAAABrbTRHvCNdvvguKQDWngEAwHj8cu0bnBURFyoBAAAAALDmUuSDe/qH5ikBsG4MAADG5SU1ctlO74uIW9UAAAAAAFgT+ftF//BROgCsOwMAgHGSrhz8U5Wqt0TECjUAAAAAAB5JXlS28ntSRNYCYN0ZAACMo96+xb9IEfsoAQAAAADwsFZWRfGf6fLFd0kBsH4MAADGWdk/dEpEnK0EAAAAAMBDyXv2zh1coAPA+jMAAJgA5ZTVH0kRNyoBAAAAAPAXzmv1D58uA8DYMAAAmADp0qXLi3b1loi4Tw0AAAAAgIgUcUO5rP0BJQDGjgEAwES9zF65+PeRk5dZAAAAAICIZUUu3poWLHlACoCxYwAAMIFaA4PfiBwnKQEAAAAANFt6XxpY9BsdAMaWAQDABCuXb7F3RL5KCQAAAACgiXLEca3+wTlKAIw9AwCACZYWLBgpc7VzRNypBgAAAADQKDmuad256QFCAIwPAwCASZAGlgzlIu0cEW01AAAAAICGuLtstd6WbrxxtRQA48MAAGCS9MwdvDxHHK4EAAAAANAAVS7iHemKWxdJATB+kgQAkydHFO3pUy+JiFepAQAAAAB0qxT5kLJ/+DNKAIwvNwAATOpLb1TlyOp3R8SwGgAAAABAV8r58mKL4c8LATD+DAAAJlm6aukfc5F2jogRNQAAAACALjNYFtXOaU60pQAYfwYAAB2gZ+7g/JTjE0oAAAAAAF1kZRXxX6lvyZ1SAEwMAwCADlEODH0xIp2uBAAAAADQJT7S2z90rQwAE8cAAKCDlMs2/2hEzFMCAAAAAKizHHFsq3/oTCUAJlaSAKDDXoxnbPukdm7/LCK2VgMAAAAAqJ2cLy+L4dekvhgVA2BiuQEAoMOkvoW3V6n6r4hYpQYAAAAAUC95UZlH3+7Df4DJYQAA0IF6+xb/JHL6kBIAAAAAQI2sqIriP9O82++QAmByGAAAdKjWwOBZEXGKEgAAAABADeRI8b7euYMLpACYPAYAAB2sXLbFxyNHvxIAAAAAQCfLOc9q9Q2drwTA5DIAAOhgacGCkbKn9baIGFIDAAAAAOhQP25tOfxJGQAmX5IAoPOt3uHJ/1ak6sqI2EgNAAAAAKCD3Fq2quenyxffJQXA5HMDAEAN9A4s+nmk/CElAAAAAIAOsqyd4k0+/AfoHAYAADXR6hv+Ws5xvBIAAAAAQAfIEel9U/qGbpACoHMYAADUSGvLoX0jx4+UAAAAAAAmU07pM63+wTlKAHSWJAFAzV6sX7TNE9q96acR8VQ1AAAAAIBJ8L2yf+g/UkQlBUBncQMAQM2kq4fvblf5LRGxXA0AAAAAYCLlSL8re3p28eE/QGcyAACooSnzhn8ZOXaLiKwGAAAAADBB7m0Vo/+eLrvlXikAOpMBAEBNtQaGLsgRn1MCAAAAAJgA7UjpXWnukt9JAdC5kgQA9ZUjUnv61K9FxDvUAAAAAADGS8qxRzkw9EUlADqbGwAA6vzSHZHLVO4Wka5WAwAAAAAYDznlE3z4D1APBgAANZf6Fq4s0+ibIuIWNQAAAACAMfbDVgzvKwNAPRgAAHSB1LfkzrJKb4yIe9UAAAAAAMZCjvh12dOzc+qLUTUA6sEAAKBLpHmDv84p7xzhZRwAAAAAWG93tsp4U7rsFv90BFAjBgAAXaSnb/iHKaX9lAAAAAAA1sPKHNWb0hVDN0sBUC8GAABdpuwbPD4iTlYCAAAAAFgHOXJ+f0//4qulAKgfAwCALlRuMbRn5HyxEgAAAADA2kiRD20NDJ+rBEBdf48D0JXyC562abXBqvk54plqAAAAAABr4Btl/9DOKSJLAVBPbgAA6FLpmpvuK1L5xoj8RzUAAAAAgEeWrypTuasP/wHqzQ0AAF1uZMdpL0lVvjwipqgBAAAAADyEheXI6hekq5b6ZyKAmnMDAECX65k7OD9y7BqWuwAAAADA30j3t3N+kw//AbqDAQBAA7QGhi7IKQ5XAgAAAAD4M+1I8Y4pA8O/kgKgO/gKAICGyBGpPX3quRHxdjUAAAAAgJRjj3Jg6ItKAHQPNwAANOVlPiKXq/NukeMaNQAAAACg2XLKJ/jwH6D7GAAANEi6enhF2VO9Pkf6nRoAAAAA0Fjfa20+vI8MAN3HVwAANFDe4clPaafq6ojYUg0AAAAAaJAc15TL2y9LC5Y8IAZA93EDAEADpYFFt1ZFen1ELFMDAAAAAJohR/ymHMmv8+E/QPcyAABoqN65gwsi8lsjYlQNAAAAAOh6t7XK1mvT1cN3SwHQvQwAABqs1T98SaT83ojIagAAAABAt0r3V7l4fbri1kVaAHQ3AwCAhmv1DX8t5XyYEgAAAADQlUZyzv/VO7Do51IAdD8DAACiHBg+LCJOVgIAAAAAukqOnD7QMzB0qRQAzWAAAEBERJRbDO0ZERcqAQAAAADdIeV0YGtg8CwlABr0u18CAP5HftE2G7Z7i8sj8ovUAAAAAIAaS3Faq29odyEAmsUNAAD835ng6uEVZRp9U474vRoAAAAAUFf5++XmQx/VAaB53AAAwN8eD7af9vftMl8VEVuqAQAAAAC18tNyyuqXpUuXLpcCoHkMAAB4SKtnTH1ekaMvIjZWAwAAAABq4aZyZPVL0lVL/ygFQDP5CgAAHlJv39DPoijeFhGjagAAAABAx7ujTPm1PvwHaDYDAAAeVmvuoosj5Q8rAQAAAACdLN1fVcVrUt/wTVoANJsBAACPqNU3/OUc8VklAAAAAKAjjeQi79Q7b9F1UgCQJABgjU4RO0w9LqXYSwkAAAAA6BhVpHhnq2/ofCkAiHADAABrqDUwtHdEfFUJAAAAAOgMKae9ffgPwJ8zAABgzQ4TEblctsUHI+eL1QAAAACAyZUiHVQODJ6gBAB/+XwAgLWQX7TNhu3e9MOI2EENAAAAAJh4OfIXevqHP64EAH/NAACAtT9gvOBpm1YbrLoiRzxXDQAAAACYUGeX/UPvSRFZCgD+mq8AAGCtpWtuuq+oRl6bI/9WDQAAAACYMBeWaWg3H/4D8HAMAABYJ2ne7Xe0Un5lRF6kBgAAAACMs5wvLzeasnPqi1ExAHg4vgIAgPU7d+ywzT+0U5oXEVuqAQAAAADjIMc1ZbHyFanvjmViAPBI3AAAwHpJA8N/qIrq1RFxjxoAAAAAMLZSxA3lSH6dD/8BWBMGAACst965i6/PuXh9RCxXAwAAAADGzM1FVbwqXT18txQArAkDAADGRM/Aoqsi0tsjYkQNAAAAAFhvS8pcvDLNW3SbFACsKQMAAMZMq3/wosj5vRFRqQEAAAAA6+yeKlWvTwOLbpUCgLVhAADAmGoNDJ+bIj6mBAAAAACskwdykd7Q27f4F1IAsLYMAAAYc2X/0Mkp8iFKAAAAAMBaWZ2LeEvP3MH5UgCwLpIEAIyXkR2mHpdS7KUEAAAAADyq0cj5ba2B4W9LAcC6cgMAAOOmNTC0d0ScrAQAAAAAPKJ2pPxeH/4DsL4MAAAYNykil/1De0SK09QAAAAAgIeUI/KHW33DX5MCgPXlKwAAmIgTTNGevs1XI9K71QAAAACA/5VTio+UfUOnSgHAWHADAADjLkVU5RbD742UzlUDAAAAACIiIqccH/PhPwBjyQAAgAmR5kS73Hxw14g4Xw0AAAAAmi5FPqAcGPqiEgCMJQMAACbuUDMn2uWyLXaJHN9VAwAAAICmSpEOKvuHZysBwNg/YwBgguXttuttb3bvtyLSG9QAAAAAoElSik+VfUOfUwKAcXnOSADAZHhwBHD/dyLy69QAAAAAoAlyjqN7Bob2UwKA8WIAAMDkHXhetM2G7d74fkR6mRoAAAAAdLMccVxP/9DeSgAwngwAAJjcg89zt9qovUl5cUTMUAMAAACAbpRTPqGnb3gvJQAYb4UEAEymtGDJA+WU1W+IiHlqAAAAANB90pdbfcOf0AGAiWAAAMDkH4EuXbq87Ol5Y0T8VA0AAAAAusiZZf/gh1JElgKAieArAADoGHnGto9r5/aPI+J5agAAAABQaynOKvuG3pciKjEAmChuAACgc85EfQvvKdvpVSniOjUAAAAAqLE5ZQy934f/AEw0NwAA0HHyi7fcourpvTxHPFMNAAAAAGolxQVlDL0r9cWoGABMNDcAANB5Z6Srlv6xaKcdIuJnagAAAABQI+f78B+AyWQAAEBHSlcO/qlM5Ssj4qdqAAAAANDxUjq33MKH/wBM8uNIAgA6WX7F3z+2PTLyw4h4oRoAAAAAdKZ0etk/uHuKqLQAYFKfSBIA0Onyq7bcuL2q9/sRMUMNAAAAADpKjlPLgaGPpIgsBgCTzVcAANDx0qVLl5dTVr8hIl+hBgAAAACdIqc4xof/AHQSNwAAUJ8D1XO32qi9SXlhRLxSDQAAAAAmU440u6d/cKYSAHQSNwAAUBtpwZIHyo2mvDEivqcGAAAAAJMlpzzLh/8AdCI3AABQvwPWdtv1tje774KIeLMaAAAAAEykFPmQsn/4M0oA0IncAABA/Q5ZN964uly2xVsj4ttqAAAAADBRUo5P+vAfgI5+VkkAQF3lnaJs/3HaVyPyu9QAAAAAYBzllNLeZd/g8VIA0MkMAACo98lrpyjbd0w9I3LsqgYAAAAA4yCnyB8v+4dPlAKATmcAAED9T2ARRXv61NMj4n1qAAAAADCGcorYo+wfOlkKAOrAAACA7jiJRaT2DlO/ECn2UAMAAACAMdCOnHZrDQyeJQUAdWEAAEDXMAIAAAAAYIyMRIpdWn1D50sBQJ0UEgDQLVJEbg0MfSzldIAaAAAAAKyjVZHzzj78B6CO3AAAQFdqT9/mYznS8WHsBgAAAMCaW5ZT+o+evsHLpACgjgwAAOhao9OnvTsifyUiWmoAAAAA8Cjuror8ut65w9dIAUBdGQAA0NVGd5j6pkhxQURsoAYAAAAAD+O2dopXTekbukEKAOrMAACArjcyfesdU5TfjciPUQMAAACAv3JL2U6vTFcO3iIFAHVnAABAI6yePvX5RcQPImIzNQAAAACIiEgRNxSj8eo0f2iJGgB0g0ICAJqgt3/o2rJK0yNisRoAAAAARMS8oqdnex/+A9BN3AAAQKPkGdtu287tH0fE09QAAAAAaKr0g3LZ6E5pwZIHtACgm7gBAIBmHe36Fi4sU/nSFHG9GgAAAACNdH65bPM3+/AfgG7kBgAAGilvP+3x7bL6fkR6sRoAAAAADZHj1HJg6KMpohIDgG7kBgAAGildOfincsrIqyLHj9QAAAAA6H455VmtgaEP+/AfgG7mBgAAmn3w22673vZm930tInZSAwAAAKAr5RR5Ztk/fJQUAHQ7AwAAnAB3irL9x2mnRuT3qwEAAADQVdoR+cOt/uHTpQCgCQwAACAickQa3WHq7JRiXzUAAAAAusKqKPI7W3OHvyUFAE1hAAAAf6a9w7SP55SPjYhCDQAAAIDauicX+c09c4f7pQCgSQwAAOCvjE7f5j8i0rkRsaEaAAAAALWzpCqq1/XOXXy9FAA0jQEAADyEkelbvyhF8b2I2EwNAAAAgHpIETcUuf26NLBkSA0Amsj1xgDwEHr6F19dVml6RAyqAQAAAFAHaW7R07O9D/8BaDIDAAB4uCPjvMFfl1XxwhT552oAAAAAdLL8zTIVr0uX3XKvFgA0ma8AAIBHOz7O2HyTdt5gTkS8Rg0AAACAzpIjf6HVP/yJFFGpAUDTuQEAAB5F6rtjWXnnpv8eKZ2rBgAAAEDHaKcce/T0D3/ch/8A8CA3AADAGsoRaXTGtENSzoeoAQAAADCpVkVOu7QGBr8hBQD8HwMAAFhL7Rnb7JFzOiHcpAMAAAAwGf6UI/69p39onhQA8JcMAABgHYzOmPrmyHFeRGyoBgAAAMCEWVim8rWpb+FvpQCAv2UAAADraPWMrV9Y5OKiiNhMDQAAAIDxlSJ+VaTqdalv8bAaAPDQXF0MAOuot2/xT8qUXxQRN6kBAAAAMI5yvrxYOWV7H/4DwCMzAACA9ZD6hm8qU/nSFHGdGgAAAADj4uxy+ZavTdfcdJ8UAPDIfAUAAIyB/JLNHtNubXhBRLxWDQAAAIAxkXOkz7b6Bw9NEVkOAHh0bgAAgDGQ5t95f7nF0BtzyrPUAAAAAFhvqyLSrj39g4f48B8A1pwbAABgjLWnT/tgjnxSRPSoAQAAALDW7so53tIzMDQgBQCsHQMAABgHI9OnvTJF/kZEPE4NAAAAgDWTIm4scvHGNLDoVjUAYJ2epQDAeMjbb/300bL4for4BzUAAAAAHtWPy1S+NfUtvEcKAFg3hQQAMD7SlYt/32pVL4oI19UBAAAAPKL8pXLZFq/34T8ArB83AADAeB9fX/u0Ke0HVp4ekd6tBgAAAMBfaKecDi4HBmdJAQDrzwAAACZAjkjVDtP2zykfHm7gAQAAAIiIWBaR3tHqH7xICgAYGwYAADCBRmdM+6/I+ayI2EgNAAAAoMGGq1y8qXdg0c+lAICxYwAAABNs9Y7bvKCo0oUR8SQ1AAAAgAb6SdlqvTldfutSKQBgbBkAAMAkyC/bZuuqHRflSP+mBgAAANAgc8rVedd09fAKKQBg7BkAAMAkyTM236SdNzgvIt6oBgAAANDlck55dqtv+KAUUckBAOOjkAAAJkfqu2NZucXQf+SUZ6kBAAAAdLFVEWnXnr7hA3z4DwDjyw0AANAB2jOm7p5zfCEietQAAAAAusjtOaq39PQvvloKABh/BgAA0CFGdpz2klTlb0bEk9QAAAAA6i5FXFe02/+RrlwyqAYATAxfAQAAHaJn7uD8sszPi4ifqgEAAADUWkrnFqvz9j78B4AJfgRLAACdJb/2aVPaD6w6JSLeqwYAAABQM6Mpp0+WA4OzpACAiWcAAAAdqj192gdz5JMiokcNAAAAoAbuykV6W8/cwculAIDJYQAAAB1sZIepO6SU50SkLdQAAAAAOlWK9CZ5uLMAACYESURBVIsiFf+R+hYuVAMAJvOZDAB0tLzDVlPbqfx2RDxPDQAAAKADnV8ua++WFix5QAoAmFwGAABQA3nGthu0c/u0iNhFDQAAAKBDtFNOB5cDg7OkAIDOYAAAAHU6Ve8w7eM55WMiolQDAAAAmER350g79/QP/lgKAOgcBgAAUDMjO059dari6xHxeDUAAACAiZYiflW005vTlYO3qAEAHfecBgDqJs/Y5mlVTt/JEc9UAwAAAJhAF5Urp7wrXXPTfVIAQOcxAACAmsozNt+kXW341Uj5P9UAAAAAxlnOKc9u9Q0flCIqOQCgMxkAAECdT94Rqdph2v455cMjolAEAAAAGHvp/ijyu1tzh76rBQB0+FNbAgCov9Hp094Ykc+OiMepAQAAAIyVFPGrol39V7py8e/VAIDO5z8FAaALtPoHLyrb7WdHxE/VAAAAAMZG+loxZfWLfPgPADV6eksAAN0jv/ZpU0YfWDk7RdpTDQAAAGAdrUo5zSwHBk+QAgDqxQAAALrQ6Ixt3hU5nRoRG6sBAAAArIXBqshv7Z07fI0UAFA/BgAA0KXyjG3/aTS3v5Ui/lkNAAAA4NHl75ftYpd05eCftACAejIAAIBuPra/ZLPHtHs2PD1yvE0NAAAA4GG0c0qfa/UNfiZFVHIAQH0ZAABAE07x06d9MEc+MSJ61QAAAAD+zB05pXf09A1eJgUA1J8BAAA0xOoZU59X5JgTEduqAQAAAETEQDkab0/zh5ZIAQDdoZAAAJqht2/oZ2VqPz9y/EgNAAAAaLScI3+hXLbFK3z4DwDdxQ0AANC0E35EqnaYtn9O+fAwBgQAAICmuS+K/L7W3OFvSQEA3ccAAAAaamT61jumKL4eEVuqAQAAAN0vRf55Uaad0hVDN6sBAN36vAcAGivP2Hqbdi6/EZFfpAYAAAB09V8BzimXVbunBUse0AIAupcBAAA0/fi/3Xa97c3uPzoif0wNAAAA6DoPRE4fbg0Mni0FAHQ/AwAAICIiRnec+u9RxRkR8UQ1AAAAoP5yxK+rnHeeMjD8KzUAoBkMAACA//XgVwIU50bEDmoAAABArU/5rvwHgAYyAAAA/kLeKcpq6bR9c8qfjYgeRQAAAKBW7o2cPtgaGPyGFADQPAYAAMBDWj1j6xcWuTgvIp6iBgAAANRAjv6yqN6V+hYPiwEAzVRIAAA8lN6+xT8pe3r+LVJcoAYAAAB0tHZO6bByy6GX+/AfAJrNDQAAwKMa3WHaLpHyKRGxkRoAAADQUYZyxDt7+ofmSQEAGAAAAGskv3TaP1dFPj9HPEsNAAAA6AgXlqvzbunq4bulAAAiDAAAgLWQZ2y7wWgenZUi7akGAAAATJqVKacDyoHBE6QAAP6cAQAAsNZGd9jmLZHSlyPi8WoAAADAxMkRv8lF9fbeuYuvVwMA+GsGAADAOsnbbzWtXZbnRsT2agAAAMCEnMbPKaeMfDhdunS5FgDAQzEAAADWWZ4RrdGY9smU8ycjolQEAAAAxsV9keJDrb6h86UAAB6JAQAAsN5Gdpz28lTlsyNiKzUAAABgDOWYX7Za70xX3LpIDADg0RQSAADrq2fu4OVlKreLlM5VAwAAAMbEaE55Vrl8ix19+A8ArCk3AAAAY2p0+rSdIvKpEfEENQAAAGDt5Yjf5CK9u3fu4AI1AIC1YQAAAIy5vP1W09plcWZEepkaAAAAsOZH6oh8ejllZO906dLlcgAAa8sAAAAYFzkiVdOnfSBHPi4iNlIEAAAAHtHtkfNurYHhH0gBAKwrAwAAYFzll07756rI5+SI56gBAAAAD2lOuTrvnq4evlsKAGB9GAAAAOMuz4jWaEz7ZMr5kxFRKgIAAAAREXFvpLxHq2/4a1IAAGPBAAAAmDCrd9zmBalK56SIf1ADAACAhrusTNV7U9/iYSkAgLFiAAAATKj8om02HO2NI1Okj3kXAQAAoIFWpJwOKwYGj0oRlRwAwFjyR3cAYFKM7Dj11amKr0TEVmoAAADQENeWqdwl9S38rRQAwHgoJAAAJkPP3KEfldXIv0bEd9QAAACgy43mlGeVd266vQ//AYDx5AYAAGDSjU6ftlNEPi0iHq8GAAAAXeaWnNKuPX2DV0oBAIw3AwAAoCPkGdtu287tMyNihhoAAAB0w1E3Upxc3t/ePy1Y8oAcAMBEMAAAADpGjkjV9GkfyBFHR+THKAIAAEBN3ZJz8YGegUVXSAEATCQDAACg4+SXTN2q3YpTIuJNagAAAFAjVUT+cplW7ZP67lgmBwAw0QwAAICONTp92k4R+dSIeIIaAAAAdLibcpHf3zN3uF8KAGCyFBIAAJ2q1T84p0zldhHxHTUAAADoUKM55VllKp/lw38AYLK5AQAAqIX/vg3g5IjYTA0AAAA6QYq4oR3xvt7+oWvVAAA6gRsAAIBaaPUPzilHVm8XEXPUAAAAYJKN5pRnFRtNeZ4P/wGATuIGAACgdkanT3tjRD41IrZSAwAAgImUIq5vV8X7euctuk4NAKDTuAEAAKidVv/gRWUqt4vIX1IDAACACTKSU55VLNvi+T78BwA6lRsAAIBaG91hm9dFSqdFxDZqAAAAME5+UubifWlg0W+kAAA6mRsAAIBaaw0M/6Ds6Xnmf98GkBUBAABgDK1IOR1QbjG0vQ//AYA6cAMAANA1RmZs85qU02kRMU0NAAAA1tNAmfJuqW/4JikAgLowAAAAukp+7lYbjT6m+HTKaZ+IaCkCAADAWron5XRoMTB4Yoqo5AAA6sQAAADoSqt33PrZRbs4LVK8QA0AAADW0JxyZPUe6aqlf5QCAKgjAwAAoGvliKKaPu39OfJREbGpIgAAADyMm3MRH+2ZO/QjKQCAOiskAAC6VYqoyv7BL5VV8U8R+RxFAAAA+CsjOeVZZSqf6cN/AKAbuAEAAGiM0RnT3hC5OikiPVkNAACAxruyXaTdp8wdvFEKAKBbGAAAAI2Sn7vVRqOPae2fcj4wInoVAQAAaJw/pZwOKwYGT0wRlRwAQDcxAAAAGmnVS7f5l7JIp0XEC9UAAABojDnlyOo90lVL/ygFANCNDAAAgMbKEUU1fdr7c+SjImJTRQAAALrWzTnHR3oGhi6VAgDoZoUEAEBTpYiq7B/8UlkV/xSRz1EEAACg64zklGeVqXymD/8BgCZwAwAAwH8b3fHJr4+qOikitlUDAACg9uaVVdo9zRv8tRQAQFMYAAAA/Jn8qi03Hl3Ze2hK8fGI6FEEAACgdu6MiP3L/qGvpogsBwDQJAYAAAAPIW+/9dPbZXFCRLxGDQAAgFqoIvK5ZTW6T5p3+x1yAABNZAAAAPAIRqdPe2NE/kL4WgAAAIBOdm1V5T165w3/VAoAoMkMAAAAHkV+0TYbjk4pZqacZ0bEBooAAAB0jNsipwPKgcFzXPcPAGAAAACwxvLLpj613Y4jImInNQAAACbVSI58SmvlBp9K19x0nxwAAA8yAAAAWEsjO057eVT5Cynin9UAAACYaPmKdlHsOWXu4I1aAAD8JQMAAIB1kJ/73J5q4zs+klN8NiI/RhEAAIBxNxw5HdwaGDxbCgCAh2YAAACwHvJLpm7VbuUjI9K7vFsBAACMixU55S+0YtXnUt8dy+QAAHh4/kgNADAGRnaYukOR4sQc8S9qAAAAjJX8/TKXe6aBRbdqAQDw6AwAAADGSI4o2jtMe1ekfExEbKYIAADAOp+v/pAif7zVP3yJGgAAa66QAABgbKSIqjUweHa5Ov9jjvyFiGirAgAAsFaW55QOa2005Vk+/AcAWHtuAAAAGCerp099fhFxTES8VA0AAIBHVEXEV8uq+GSat+g2OQAA1o0BAADAOBudPu2NEfnYiHiaGgAAAH8tX1GlvE9v3+JfaAEAsH4MAAAAJkB+7nN7qk3ueG+O/LmI2FwRAACg8eekSL9LEZ9q9Q/OUQMAYGwYAAAATKC8/bTHj7aqmSmnvSJiiiIAAEAD3ZVy+mxRDH4x9cWoHAAAY8cAAABgEuTtt5rWLovPRaR3eScDAAAaYnWOfGqrp/fT6bJb7pUDAGDs+WMzAMAkWr3jNi8o2umYSPESNQAAgC6VI+KbZS5mpoFFt8oBADB+DAAAACZZjkjt6dP+KyLPioinKAIAAHTRgeeaXKZ9euYOzhcDAGD8GQAAAHSIvN12vdUT7/9wTvmwiHisIgAAQI0NRk6fKgcGz0kP3gAAAMAEMAAAAOgw+eVbP3F0NH06RfpIRLQUAQAAauRPKadZxca9x6dLblolBwDAxDIAAADoUHnHrf6xXZWfjYid1AAAADrcSEQ+s6xGP5nm3X6HHAAAk8MAAACgw43MmPaKlPMREfE8NQAAgA6TI2JOmfMn08DwH+QAAJhcBgAAADUxMmPaK4qcj8kR/6IGAADQAS6rinRA79zBBVIAAHQGAwAAgBrJEUV7+rT/jMhHRsTfKwIAAEyCn+SoDurpXzxXCgCAzmIAAABQQ3m77Xqrze5/T458WEQ8SREAAGC8pYgbc6TDyv7Bb6YHr/4HAKDz3tkAAKir/KotN65WTtkjp3xARDxOEQAAYBxOHotSFIcXWwyekeZEWw8AgM5lAAAA0AXyi7Z5wuiU2D/ltGdEbKgIAAAwBu5IOR1TbNx7fLrkplVyAAB0PgMAAIAukl+2zdaj7dg/Rdo9InoVAQAA1sHdKafZxUj1hXT18Ao5AADqwwAAAKAL5RnbbtvOowdGpN0iolQEAABYA8tzyie1onVk6lt4jxwAAPVjAAAA0MVW7Thtu7LKh0TETmoAAAAPYyQin1lW5aFp3qLb5AAAqC8DAACABhiZMW37lPMREbG9GgAAwH9rR8Q5Zdk6NF1x6yI5AADqzwAAAKBBHhwCxGci8o5qAABAY1UR8a0ylZ9OfQt/KwcAQPcwAAAAaKAHhwDVYRHpZWoAAEBjPPjBf9H+VJq75HdyAAB0HwMAAIAGG5kxbftUVYdGSi9XAwAAupYP/gEAGsIAAAAAQwAAAOhOD37w364+ma5c/Hs5AAC6nwEAAAD/67+/GmBmRHqDGgAAUN9X+4h8fpnjs2lg+A9yAAA0hwEAAAB/Y2THaS9JVXWAIQAAANTrVd4H/wAAzWYAAADAwzIEAACAery6R+TzyxSfSX3DN8kBANBcBgAAADyqkR2e/OKU2gcaAgAAQGe9qvvgHwCAP2cAAADAGhuZvvWLUqSDDAEAAGByX80j8vllmQ5LVwzdLAcAAP/DAAAAgLW2esdtXlBU6YCIeFNEFIoAAMCEWJ5znN6K9rFpYMmQHAAA/DUDAAAA1ll+2dSnjrbzninSByNiA0UAAGBc3JlT+mKrbJ+YLl98lxwAADwcAwAAANZbfvlTthxttz+cct4rIh6rCAAAjMmb9qKUi+OKDVZ9OV26dLkeAAA8GgMAAADGTH7B0zatpqx+b055ZkT8nSIAALD2UsQNOaejyuWbfz0tWDCiCAAAa/EuCQAAYyu/9mlT2stXvy2nfHCKeLoiAACwJi/SMT9SmlX2D34/RWRBAABYWwYAAACMmxxRtKdPe31E/nREPE8RAAB4qNfmfHEuiiN75g7OlwMAgPVhAAAAwIQYmTFt+5SrmRHpDWoAAECMROTz20Uxa8rcwRvlAABgLBgAAAAwoVa/9MnPKYr2XhHpHRFRKgIAQMMsz5HPaLWrY9KVSwblAABgLBkAAAAwKfIOT35GO1X7R8Q7IqJXEQAAutydKeeTip58Urp88V1yAAAwHgwAAACYVPnlT9lytN3+cMr5oxGxmSIAAHTV+27EH4qcvlhssOrL6dKlyxUBAGA8GQAAANAR8mufNqW9fPXbUsr75ohnKQIAQL1fcGN+pDSr7B/8forIggAAMBEMAAAA6DgjM6Ztn3LeMyLeEhGlIgAA1MSqiPyNdlHMmjJ38EY5AACYaAYAAAB0rPyyqU8dbec9U6T3RcQmigAA0KFuzymd1irbJ6bLF98lBwAAk8UAAACAjpdf8LRNqymr35tT9YmI9GRFAADoBCliQc7pC+Xyzb+eFiwYUQQAgA54RwUAgHrIEUV7+rTXR+Q9I+IVigAAMAmqiPyDnIoTevoGL5MDAIBOYgAAAEAtrX7pk59TFO0PRaRdImIDRQAAGGf35chfbbWrY9KVSwblAACgExkAAABQa3nGtk8ajWr3lPNHI2IzRQAAGGM3pZxOKjZY9eV06dLlcgAA0MkMAAAA6Ar5Rdts2O6Jd0RKu0fE8xQBAGA9tCPH93MZp7TmDl2aIrIkAADUgQEAAABdZ/WO055bVNUHI9I7I2JjRQAAWEO355TPakXr1NS3cKEcAADUjQEAAABdK7/gaZtWG6zeOSJ/NEf8iyIAADz0i2PMj5ROKJdtfmFasGBEEAAA6soAAACARvizWwHeHREbKgIA0Hj3RORvtIviC1PmDt4oBwAA3cAAAACARsnbT3t8VcQuOeU9I+LvFQEAaJb/3979/thV2Hce/3zPnRljDAGnmJ/GEIdkW7zbJp2tFGJITKCJaGGVbkrUSg1q+2CfrNR/Z7XRSttNuhtpva3Shoa2MsEQO5SoA31Q07T1OvFgoGAS88t2PDP3fPvAJoImaQix8fx4vZ5Yc+V58rbke+65n3NOJQtJfX54feWPauG5U4oAALDOjncBAGDj6WRY2bPjE9X9X5L8RpIZVQAA1qt6LRm/NFb/t7n9z/6tHgAArNsjXwkAANjoeveN14+T+lxX/9ckNyoCALBOjvOSvx+6/tcw5vN1YPGEIgAArHcGAAAAcE7fn8n0xR2/lvQfJLnL8TIAwJp0JsmfddXnZ/cv7pMDAICNxAlNAAD4Efpj2z+wUvV7lTyQ5AZFAABWt0qeTPoPh6X873r82PcUAQBggx4XAwAAP04nw8qeHZ+oHh9I6jNJLlUFAGDVeDnp/zuOk/8+9/WjT8oBAMBGZwAAAABvU++5+cqxx8929wOp7FYEAOCiGJN8LV1fnCyPe+vxY6clAQCAswwAAADgHeg7dty6MhkfqM7vJXW1IgAAF/j4K/nHVH1pZpj8z/rat48qAgAAP8wAAAAAfga9a9fc9KrXPpX055J8OsmsKgAA582rSf9p1/CFmf2LD1fSkgAAwI9nAAAAAOdJ33HTdWP1Z1P9+538oiIAAO9MJQtJfX6o0/+n9h9/XREAAHjbx9IAAMD5tnTnjvkaxwcq9TtJ3qsIAMBP9GxX/9FM8j9q/7HDcgAAwE/PAAAAAC6gnr/+0umWmd9M9eeS3JlkogoAwA+8ntSXO/nCzKOLD1cySgIAAO+cAQAAALxL+q4bfm5cmXymux9I5aOOxwGADWqa5JF0fXEynP4Tt/gHAIDzxwlHAAC4CPoT77tpXJn+1ljj71bq5xUBANa5MZ3HK7V3WDnzpfrGCy9KAgAA558BAAAAXGRn7tyxa+jcX90PJHmfIgDAetHJ06naO7OSL9SBxSOKAADAhWUAAAAAq0Qnw8qeHR9Nj/dX6reTbFMFAFiDFjv95e7JH849dvQpOQAA4N1jAAAAAKtQ33PLpumppU8m4/1J/UaSy1QBAFax7yX9/7qGL87sXzxYSUsCAADvPgMAAABY5fq27Zunc8O9yfhAUp9KMqsKALAKnE7yYFJfnLy+7S9qYWFZEgAAuLgMAAAAYA3pj15z9Tg3+9ke6zdTuT3JRBUA4F10MslXk9o7WRofrMePnZYEAABWDwMAAABYo/quG35uujz59dR4f1KfTDKnCgBwAZxK+mvpYe9kOP0ntf/465IAAMDqZAAAAADrQN++Y+t0yH2pvjfJryXZogoA8DM4kfSDybB3cuncX9VDh89IAgAAq58BAAAArDM9f/2l08tm7krG+5Ph00lfrgoA8DZ8N+mvJsPeyUuX/2UdOrQkCQAArC0GAAAAsI71bds3T+eGu8+OAeo/JblCFQDgTY6d+9L/wUktPlT7syIJAACsXQYAAACwQfQ9t2xaOb10R3q8r5LfSupqVQBgQx4VHO3kT1PD3pn9iwcraU0AAGB9MAAAAIANqOfnZ1e2vHhnVX8myaeNAQBgnb/3p7+Vqj/ucfjjuceOPqUIAACsTwYAAACwwXUyLN+548PVuW/ovreTX/ZZAQDWvGk6f12pr0wn2Tf3yOKCJAAAsP45qQcAALxF3/W+a6bL00+l+t4k9yS5TBUAWBO+l+ThdD04GYY/q/3feVkSAADYWAwAAACAH6tv2755ZdOwOz3eV6n/nGS7KgCwqhzp9IOp4Sszr217tBYWliUBAICNywAAAAB4287cuWPXzDT3dvq+VG5LMqgCAO+qlXSeqNRXhsnKl+uR5/5BEgAA4A0GAAAAwDvSd1y7bVpz95x7VMCnkrxHFQC4II4n/RfJ8JXJ9+f+sp44/KokAADAj2IAAAAA/Mx6z82XrNT049W5L51fT3KzKgDwzt9aK3lyTP15px+cffSZv6mkZQEAAH4SAwAAAOC869t37BwnubvTdyf51SRXqgIA/+a754tJPVqpfUNNv1r7nz2mCQAA8NMyAAAAAC6ovj+T5Zd2fGgyzd1dfXeSjyeZVQaADe5Ukm9U177pJPtmH1l80lX+AADAz8oAAAAAeFf1nm2XrWTzR5Lx7qHr7k7mVQFgAxgreWqs3pcM+2Y2z329Hjp8RhYAAOB8MgAAAAAuqr7jpuum1b+a6nuT3JXkvaoAsE48n+RAuh6czE7/vB5+9ruSAAAAF5IBAAAAsGp0MizfuePDb3pcwB1JNikDwBpxMsnjb9zWf+6RxQVJAACAd5MBAAAAsGr1nm2XTevSj/c43jUkH+vkQ0kmygCwSpxK+q8reXTsyb6Z4eg3a39WZAEAAC4WAwAAAGDN6D3bLlvJ5o8kub26d8cdAgB4d51M8nhXHUxyYGbz3NfrocNnZAEAAFYLAwAAAGDN6vnrL125fOaXhzG7zz0yYHeSzcoAcH7Ua0k/UV37xiEHZ45f/s06dGhJFwAAYNV+ipEAAABYL3pPZpZrxy9Nprm7a7w9qduTXKkMAG/zneTFJN+sHg5MJ9k3+8jiU5WMugAAAGuFAQAAALBu9f2ZLL+040OTaW7v6t1J7kryXmUAOOf5JAeq6+B0kgOzjyw+WUnLAgAArFUGAAAAwIbRybC854ZfnPTkY52+LclHktysDMCGMK3kUKeeSOfgJPVYPXb027IAAADriQEAAACwofWem6+d9vgrXZmvHueT2p1kqzIAa97LSf6mqw5WZ2EyzYE6sHhCFgAAYD0zAAAAAHiTvj+TpZd2/PxkmvmucX5I7e7kw0kGdQBWrZVO/rHSB9LDwekkC3OPLD7tdv4AAMBGYwAAAADwE/Tuqy5fmb30l4Yx8129O+mPJ3W1MgAXzfNJL1QPB8YhB2fOjAv1+LHTsgAAABudAQAAAMA70LtvvH46U7s74+3VNZ/Kf0yySRmA8+5kOn/b1QuV4cBkZvJYPfztF2QBAAD4YQYAAAAA50HPz88uvef4B994dMC5UcCHkmxRB+BteyWdv+vqhephYTrJwtxVi9+qvZlKAwAA8JMZAAAAAFxA5+4UMN+V+epxPqlfSXKNMgBnb+PflUM1Dk9PJ1mYe2Tx6UpaGgAAgHfGAAAAAOBd9sYooDq3do27OjVfyS/4jAasU9MkR5N+umtYqM7CZPnME/WNF16UBgAA4PxycgkAAGAV6Lt3XrGysvIfhvHsIwTOjQL+XZKJOsAastzJP1XO3sJ/HLIwM3fmqfqrF05KAwAAcOEZAAAAAKxSvWvX3NLVr31gMubWruyq7ls72WUYAKwC577oz6GuPlLj8PQ4yaHZS+b+rh46fEYeAACAi8MAAAAAYI3p+fnZpfcc/+BkzK3V2dk17qrUrZ38+ySbFALOo6VODp/9or+ers6h6ZCn565a/FbtzVQeAACA1cUAAAAAYJ3o+fnZbD5+43SSXdW59U3DgF1JLlEI+Df4oh8AAGAdMAAAAABY53rXrrmlba9+cDLWrZXxF3oYPpCxb0nl/UmuUgg2zn8HSZ5Ncjipw9U53JWnJ9McyoHF71QySgQAALC2GQAAAABsYL3n5kuWanz/mx4nsDOpnUl2Jrk5yaASrDnPJzmU9JHq4UhXjoxDjsz26X+o/cdflwcAAGD9MgAAAADgR+p7btmU15ZuWJnJzqGzc8zZRwrk7DjgpiQTleCiWE7yTJIjP/Ql/6srf18Lz52SCAAAYGMyAAAAAOCn1vfcsiknl3dOq2+pyvvHjDdX141Jtie5Mcm1PnPCO7ac9HNJPZNksaufGVLfGbv+/0zX4VxzdLH2ZioTAAAA/5qTMQAAAJx3vWvXXK589arlubpuGLOzOtePw3hdde2sZGcn18dIgI3rRCfPV/LcD67gT57vIc/NrORIZhYXa39WZAIAAOCn5UQLAAAAF0V/8potOb3pppWZvrGmvb2H4cbqvinJ9k7dWOntSbYoxRpzopJnu/toUs9UcqyrFnsYF2eqjmXTpmP10OEzMgEAAHAhGAAAAACwavWemy/J8vS9S3O1dehcV2Our2Tr2bsJ5PokWyt13bk7ClydZKIaF8DZK/Y7J1J5rtPPp4YTw5gTXXmuK8+PlRNzS6cW6+BLr8kFAADAxWIAAAAAwLrQ8/OzueKFq5dXJlcPNb02PWyrGq8ZU9dWelu6rq7KdZ1cmdTWpC9XbcM6keTlJN9N9wupOt7d/zwMwws9jsd7Mvzz2P3C3GTmeB7+9vFKRskAAABYCwwAAAAA2LD6tu2bM9TWc3cY2FqdrelsPXuXgWxNj1sr2Zpka7q2duWNny/J2T+5OL6fs1flnzh7VX6fSOp00t/v5MQPrs5PTqRyoisnzl6h3ycy+8yLtT8rEgIAALAeGQAAAADAO9D33LIpp1e2JrlyuaeXV9UVNY5zqWFLqrdU11wyXpEMM2ONV6RrrtJbkuHSpDcluSLpmUpdkWSuky1JLk2yKcl7srYfZ7CU5GSSU0nOVOrVTi8neSWppaRPpnIq3We669WkV4YML6d6KamTXeOp9HCmh341qZVOXp7t8ZVkfDl57mVf4AMAAMCPZgAAAAAAq1Anldt3XPnWV1cuT2Zm3vzK0mw219k7Erzpl6ezlcllb3lt7KGqrvhXZwW6z94K/62/3v1KhnrLbe9neziZlXHpLX9xbjyTpeHUD36+ZGasfUde8a8HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACwEf0LhMJo57TaaG8AAAAldEVYdGRhdGU6Y3JlYXRlADIwMjQtMDctMDhUMTU6NTA6NTMrMDA6MDDhbwsoAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI0LTA3LTA4VDE1OjUwOjUzKzAwOjAwkDKzlAAAAABJRU5ErkJggg==",
    gm: "data:image/jpeg;base64,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",
    tg: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="64" height="64" rx="18" fill="#27A7E7"/><path d="M49.8 17.6 14.7 31.1c-2.4 1-2.3 2.4-.4 3l9 2.8 3.4 10.6c.4 1.2.2 1.7 1.4 1.7.9 0 1.3-.4 1.8-.9l4.4-4.3 9.1 6.7c1.7.9 2.9.4 3.3-1.6l6-28.2c.6-2.4-.9-3.5-2.9-2.6zM25.8 36.2l20.8-13.1c1-.6 1.8-.3 1.1.4L30.6 39.1l-.7 7.6-4.1-10.5z" fill="#fff"/></svg>`,
  };

function brandIconHtml(taskOrType, sizePx = 38) {
    const tRaw = (typeof taskOrType === "string") ? taskOrType : (taskOrType && (taskOrType.type || taskOrType.platform));
    const t = String(tRaw || "").toLowerCase();
    const key = (t === "ya" || t === "yandex") ? "ya" : (t === "gm" || t === "google") ? "gm" : "tg";
    const s = Number(sizePx) || 38;
    const icon = BRAND_ICON_SVG[key] || BRAND_ICON_SVG.tg;
    const alt = (key === "ya") ? "Яндекс" : (key === "gm") ? "Google" : "Telegram";
    if (key === "ya" || key === "gm") {
      return `<span class="brand-svg" role="img" aria-label="${alt}" style="width:${s}px;height:${s}px;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;border-radius:999px;"><img src="${icon}" alt="${alt}" style="width:100%;height:100%;object-fit:cover;display:block;"/></span>`;
    }
    return `<span class="brand-svg" role="img" aria-label="${alt}" style="width:${s}px;height:${s}px;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;">${icon}</span>`;
  }

  function initPlatformFilterIcons() {
    const nodes = document.querySelectorAll("[data-pf-ico]");
    nodes.forEach(n => {
      const k = String(n.getAttribute("data-pf-ico") || "").toLowerCase();
      if (k === "ya" || k === "gm" || k === "tg") n.innerHTML = brandIconHtml(k, 20);
    });
  }


  function taskIcon(t) {
    const type = String(t.type || "");
    if (type === "tg") return "✈️";
    if (type === "ya") return "📍";
    if (type === "gm") return "🌍";
    return "✅";
  }

  function taskTypeLabel(t) {
    const type = String(t.type || "");
    if (type === "tg") return "Telegram";
    if (type === "ya") return "Яндекс";
    if (type === "gm") return "Google";
    return type.toUpperCase();
  }

  function renderTasks() {
    const box = $("tasks-list");
    if (!box) return;

    const uid = state.user ? state.user.user_id : null;
    const isMy = state.filter === "my" && uid;
    let list = state.tasks.slice();

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
        box.innerHTML = `<div class="card" style="text-align:center; color:var(--text-dim);">По текущему фильтру заданий нет.<br><br><button class="btn" onclick="setPlatformFilter('all')">Показать все задания</button></div>`;
      } else {
        box.innerHTML = `<div class="card" style="text-align:center; color:var(--text-dim);">${isMy ? "У вас пока нет созданных заданий." : "Пока нет активных заданий."}</div>`;
      }
      return;
    }

    box.innerHTML = "";

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
                  ${topActive ? `<span style="font-size:11px;font-weight:800;padding:4px 8px;border-radius:999px;background:rgba(255,180,0,.14);color:#ffd36b;">🔥 В топе</span>` : ``}
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
                  <div style="font-weight:900; font-size:14px; line-height:1.2;">${safeText(t.title || "Задание")}</div>
                  <div style="font-size:12px; color:var(--text-dim);">${safeText(subtypeText)}</div>
                </div>
              </div>
            </div>
            <div style="font-weight:900; color:var(--accent-green); white-space:nowrap;">+${fmtRub(reward)}</div>
          </div>`;
        card.addEventListener("click", () => openTaskDetails(t));
      }

      box.appendChild(card);
    });
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

    // proof blocks
    const isAuto = String(task.check_type || "") === "auto" && String(task.type || "") === "tg";
    const manual = $("proof-manual");
    const auto = $("proof-auto");
    if (manual) manual.classList.toggle("hidden", isAuto);
    if (auto) auto.classList.toggle("hidden", !isAuto);

    // set nickname label + placeholder for reviews
    const nickInput = $("p-username");
    const fileInput = $("p-file");
    if (nickInput) {
      const t = String(task.type || "");
      const isReview = (t === "ya" || t === "gm");
      const label = manual ? manual.querySelector("label.input-label") : null;
      if (label) label.textContent = isReview ? "Никнейм автора отзыва (как в сервисе)" : "Ваш Никнейм / Имя";

      nickInput.placeholder = isReview ? "Например: Я.К." : "Пример: Alex99";

      // Prefill: use last saved for this platform, else Telegram name
      let key = "rc_last_nick_generic";
      if (t === "ya") key = "rc_last_nick_ya";
      if (t === "gm") key = "rc_last_nick_gm";
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
        btn.disabled = false;
        btn.style.opacity = "1";
        if (isAuto) {
          btn.textContent = "✅ Проверить и получить награду";
          btn.onclick = () => submitTaskAuto(task);
        } else {
          btn.textContent = "📤 Отправить отчёт";
          btn.onclick = () => submitTaskManual(task);
        }
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
      .replace(/(^|\n)\s*TG_SUBTYPE\s*:\s*[a-z0-9_\-]+\s*(?=\n|$)/ig, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return map[subtype] || cleaned || "Выполните задание и нажмите кнопку проверки.";
  }

  function getTaskReviewTexts(task) {
    const arr = Array.isArray(task && task.custom_review_texts) ? task.custom_review_texts : [];
    return arr.map(x => String(x || "").trim()).filter(Boolean);
  }

  function renderTaskInstructionHtml(task) {
    const baseText = safeText(getTaskInstructionText(task)).replace(/\n/g, "<br>");
    const base = baseText ? `<div class="task-info-card"><div class="task-info-title">Что нужно сделать</div><div>${baseText}</div></div>` : "";
    const reviewTexts = getTaskReviewTexts(task);
    const mode = String((task && task.custom_review_mode) || "none");
    if (!reviewTexts.length || !["single", "per_item"].includes(mode)) return base || safeText(getTaskInstructionText(task)).replace(/\n/g, "<br>");
    const heading = mode === "per_item" ? "Текст отзыва для этого выполнения" : "Текст отзыва от заказчика";
    const items = reviewTexts.map((text) => `<div class="review-text-item"><span class="review-text-index">★</span><span>${safeText(text)}</span></div>`).join("");
    const reviewCard = `<div class="review-text-card"><div class="review-text-title">${heading}</div>${items}</div>`;
    return `${base}${reviewCard}`;
  }

  window.copyLink = function () {
    const el = $("td-link");
    const text = el ? el.textContent : "";
    copyText(text);
  };

  async function copyText(text) {
    const s = String(text || "");
    if (!s) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(s);
      } else {
        throw new Error("clipboard_unavailable");
      }
      tgHaptic("success");
      tgAlert("Скопировано ✅");
    } catch (e) {
      try {
        const ta = document.createElement("textarea");
        ta.value = s;
        ta.setAttribute("readonly", "readonly");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        ta.style.pointerEvents = "none";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        document.execCommand("copy");
        ta.remove();
        tgHaptic("success");
        tgAlert("Скопировано ✅");
      } catch (err) {
        tgHaptic("error");
        tgAlert("Не удалось скопировать. Зажмите номер и скопируйте вручную.", "error", "Ошибка копирования");
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
    const mode = getCustomReviewMode();
    if (wrap) wrap.classList.toggle("hidden", !(type === "ya" || type === "gm"));
    if (!helper || !(type === "ya" || type === "gm")) return;
    const qty = clamp(Number(($("t-qty") && $("t-qty").value) || 1), 1, 1000000);
    if (mode === "single") {
      helper.textContent = "Один и тот же текст увидят все исполнители. Выбирай этот режим, только если специально хочешь одинаковый отзыв для всех.";
    } else if (mode === "per_item") {
      helper.textContent = `Каждая строка — отдельный текст для одного исполнения. Сейчас заказано ${qty} шт., поэтому добавь минимум ${qty} разных строк.`;
    } else {
      helper.textContent = "По умолчанию можно не задавать текст. Но если нужны отзывы, лучше выбрать режим с отдельным текстом на каждую штуку.";
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
    if (rawL.match(/^@?[a-z0-9_]+bot/i)) return true;

    // Links to bots
    if (rawL.includes("t.me/") && rawL.match(/t\.me\/(?:s\/)?[a-z0-9_]+bot/i)) return true;

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

  function recalc() {
    const type = currentCreateType();
    const qty = clamp(Number(($("t-qty") && $("t-qty").value) || 1), 1, 1000000);
    const taskTextLabel = document.querySelector('label[for="t-text"]') || document.getElementById("t-text-label");
    const taskTextInput = $("t-text");
    if (taskTextLabel) taskTextLabel.textContent = (type === "ya" || type === "gm") ? "Комментарий / условия к отзыву" : "Текст задания / комментарий";
    if (taskTextInput) taskTextInput.placeholder = (type === "ya" || type === "gm") ? "Например: отзыв должен быть естественным, без мата, со скрином после публикации." : "Например: выполните задание и отправьте отчёт.";
    const cur = $("t-cur") ? $("t-cur").value : "rub";

    const tgWrap = $("tg-subtype-wrapper");
    const tgOpt = $("tg-options");
    const retentionWrap = $("retention-config");
    if (tgWrap) tgWrap.classList.toggle("hidden", type !== "tg");
    if (tgOpt) tgOpt.classList.toggle("hidden", type !== "tg");
    if (retentionWrap) retentionWrap.classList.toggle("hidden", type !== "tg");

    let total = 0;
    let reward = 0;
    let costPer = 0;
    let baseTotal = 0;

    if (type === "ya") {
      reward = YA.reward;
      costPer = YA.costPer;
      total = costPer * qty;
      baseTotal = total;
    } else if (type === "gm") {
      reward = GM.reward;
      costPer = GM.costPer;
      total = costPer * qty;
      baseTotal = total;
    } else {
      const sid = currentTgSubtype();
      const conf = TG_TASK_TYPES.find(x => x.id === sid) || TG_TASK_TYPES[0];
      const retentionExtra = currentRetentionExtraDays();
      reward = Number(conf.reward || 0) + (retentionExtra * TG_EXTRA_RETENTION_REWARD_PER_DAY);
      costPer = Number(conf.cost || Math.max(12, reward * 2)) + (retentionExtra * TG_EXTRA_RETENTION_COST_PER_DAY);
      total = costPer * qty;
      baseTotal = total;
      const descEl = $("tg-subtype-desc");
      if (descEl) descEl.textContent = `${conf.desc} • Удержание: ${tgTotalRetentionDays(sid, retentionExtra)} дн. • Исполнитель получит ${reward}₽ • Цена за 1 шт: ${costPer}₽`;
    }

    updateTgHint();
    syncReviewTextsHint();
    const perOneEl = $("t-per-one");
    if (perOneEl) perOneEl.textContent = fmtRub(costPer || 0);

    const minWarn = $("t-min-budget-warning");
    if (minWarn) {
      if (baseTotal > 0 && baseTotal < TASK_MIN_BUDGET_RUB) {
        minWarn.textContent = `Минимальный бюджет задания — ${TASK_MIN_BUDGET_RUB} ₽.`;
        minWarn.style.display = "block";
      } else {
        minWarn.style.display = "none";
      }
    }

    if (isTopWanted()) total += TOP_FIXED_PRICE_RUB;
    updateTopUi();

    const totalEl = $("t-total");
    if (totalEl) totalEl.textContent = cur === "star" ? (rubToStars(total) + " ⭐") : fmtRub(total);

    const s = $("t-target-status");
    if (s) s.textContent = "";
  }
  window.recalc = recalc;

  async function createTask() {
    const type = currentCreateType();
    const qty = clamp(Number(($("t-qty") && $("t-qty").value) || 1), 1, 1000000);
    const taskTextLabel = document.querySelector('label[for="t-text"]') || document.getElementById("t-text-label");
    const taskTextInput = $("t-text");
    if (taskTextLabel) taskTextLabel.textContent = (type === "ya" || type === "gm") ? "Комментарий / условия к отзыву" : "Текст задания / комментарий";
    if (taskTextInput) taskTextInput.placeholder = (type === "ya" || type === "gm") ? "Например: отзыв должен быть естественным, без мата, со скрином после публикации." : "Например: выполните задание и отправьте отчёт.";
    const target = String(($("t-target") && $("t-target").value) || "").trim();
    const txt = String(($("t-text") && $("t-text").value) || "").trim();
    const reviewMode = getCustomReviewMode();
    const reviewTexts = getCustomReviewTexts();

    if (!target) {
      if (type === "tg") {
        const sid = currentTgSubtype();
        if (tgNeedsChat(sid)) return tgAlert("Укажи @канал или @группу (пример: @MyChannel)", "error", "Нужно указать чат");
      } else {
        return tgAlert("Укажи ссылку на карточку места (Яндекс/Google)", "error", "Нужна ссылка");
      }
    }

    // При создании задания допускаются только ссылки и @юзернеймы
    if (type === "tg") {
      const sid = currentTgSubtype();
      if (tgNeedsChat(sid)) {
        const tgChatTry = normalizeTgChatInput(target);
        if (!tgChatTry) {
          tgAlert("Можно только @юзернейм или ссылка t.me.\nПример: @MyChannel или https://t.me/MyChannel", "error", "Некорректный Telegram");
          scheduleTgCheck();
          return;
        }
      }
    } else {
      if (!isProbablyUrl(target)) {
        tgAlert("Можно только рабочая ссылка. Просто текст нельзя.", "error", "Некорректная ссылка");
        return;
      }
      if (type === "ya" && !isYandexMapsUrl(target)) {
        tgAlert("Ссылка не похожа на Яндекс Карты. Вставь ссылку на место/организацию в Яндекс Картах.", "error", "Неподходящая ссылка");
        return;
      }
      if (type === "gm" && !isGoogleMapsUrl(target)) {
        tgAlert("Ссылка не похожа на Google Maps. Вставь ссылку на место/организацию в Google Maps.", "error", "Неподходящая ссылка");
        return;
      }
    }
    if (qty <= 0) return tgAlert("Некорректное количество");
    if ((type === "ya" || type === "gm") && reviewMode !== "none" && reviewTexts.length === 0) {
      return tgAlert("Добавьте текст отзыва для выбранного режима.", "error", "Нужен текст отзыва");
    }
    if ((type === "ya" || type === "gm") && reviewMode === "per_item" && reviewTexts.length < qty) {
      return tgAlert(`Для ${qty} отзывов добавьте минимум ${qty} отдельных строк текста.`, "error", "Не хватает вариантов");
    }

    let title = "";
    let reward = 0;
    let cost = 0;
    const wantTop = isTopWanted();
    let checkType = "manual";
    let tgChat = null;
    let tgKind = null;
    let subType = null;
    const payCurrency = $("t-cur") ? String($("t-cur").value || "rub").toLowerCase() : "rub";

    if (type === "ya") {
      title = YA.title;
      reward = YA.reward;
      cost = YA.costPer * qty;
    } else if (type === "gm") {
      title = GM.title;
      reward = GM.reward;
      cost = GM.costPer * qty;
    } else {
      const sid = currentTgSubtype();
      const conf = TG_TASK_TYPES.find(x => x.id === sid) || TG_TASK_TYPES[0];
      title = "Telegram — " + conf.title;
      const retentionExtra = currentRetentionExtraDays();
      reward = Number(conf.reward || 0) + (retentionExtra * TG_EXTRA_RETENTION_REWARD_PER_DAY);
      const baseCostPer = Number(conf.cost || Math.max(12, reward * 2));
      cost = (baseCostPer + retentionExtra * TG_EXTRA_RETENTION_COST_PER_DAY) * qty;
      subType = conf.id;

      tgChat = normalizeTgChatInput(target);
      tgKind = tgNeedsChat(subType) ? (tgIsBotTarget(target, tgChat) ? "bot" : "chat") : "bot";
      const manualOnly = (tgKind === "bot" && tgNeedsChat(subType)) || TG_MANUAL_ONLY.has(subType);
      checkType = manualOnly ? "manual" : (tgAutoPossible(subType, tgKind) ? "auto" : "manual");
    }

    // Nice TG validation before sending request (so user doesn't see raw 400)
    if (type === "tg") {
      if (tgNeedsChat(subType)) {
        if (!tgChat) {
          tgAlert("Для Telegram-задания нужен @юзернейм канала/группы.\nПример: @MyChannel или https://t.me/MyChannel", "error", "Укажи чат");
          scheduleTgCheck();
          return;
        }

        const manualOnly = (tgKind === "bot") || TG_MANUAL_ONLY.has(subType) || !tgAutoPossible(subType, tgKind);
        if (manualOnly) {
          const label = tgKind === "bot" ? `Бот: ${tgChat}` : `TG: ${tgChat}`;
          setTargetStatus("err", label, "Создание невозможно: для TG доступна только авто-проверка.");
          state._tgCheck.valid = false;
          state._tgCheck.chat = tgChat;
          state._tgCheck.forceManual = true;
          updateTgHint();
          tgAlert("Для TG задания доступна только авто-проверка. Укажи канал/группу, где бот может проверить подписку.", "error", "Проверка Telegram");
          return;
        }

        try {
          setTargetStatus("loading", "Проверяем…", "Проверяем доступ бота для авто-проверки");
          const chk = await apiPost("/api/tg/check_chat", { target: tgChat });
          if (chk && chk.ok && chk.valid) {
            const nm = chk.title ? String(chk.title) : tgChat;
            const tp = chk.type ? (String(chk.type) === "channel" ? "Канал" : "Группа") : "Чат";
            setTargetStatus("ok", `${tp}: ${nm}`, "Авто-проверка доступна ✅");
            state._tgCheck.valid = true;
            state._tgCheck.chat = chk.chat || tgChat;
            state._tgCheck.forceManual = false;
            checkType = "auto";
            updateTgHint();
          } else {
            const msg = (chk && (chk.message || chk.error)) ? String(chk.message || chk.error) : "Авто-проверка недоступна";
            setTargetStatus("err", `TG: ${tgChat}`, "Авто-проверка недоступна. Добавь бота в чат/канал и выдай нужные права.");
            updateTgHint();
            tgAlert(msg + "\nСоздание невозможно: для TG доступна только авто-проверка.", "error", "Проверка Telegram");
            return;
          }
        } catch (e) {
          const msg = prettifyErrText(String(e.message || e));
          setTargetStatus("err", `TG: ${tgChat}`, "Авто-проверка недоступна. Добавь бота в чат/канал и выдай нужные права.");
          updateTgHint();
          tgAlert(msg + "\nСоздание невозможно: для TG доступна только авто-проверка.", "error", "Проверка Telegram");
          return;
        }
      } else {
        checkType = "auto";
      }
    }

    if (Number(cost || 0) < TASK_MIN_BUDGET_RUB) {
      return tgAlert(`Минимальный бюджет задания — ${TASK_MIN_BUDGET_RUB} ₽`, "error", "Слишком маленький бюджет");
    }
    const chargedRub = Number(cost || 0) + (wantTop ? TOP_FIXED_PRICE_RUB : 0);
    const neededRub = chargedRub;
    const neededStars = rubToStars(neededRub);
    const bal = state.balance || {};
    if (payCurrency === "star" && !starsPaymentsEnabled()) {
      return tgAlert("Оплата Stars временно отключена администратором", "error", "Stars выключены");
    }
    if (payCurrency === "star") {
      if (Number(bal.stars_balance || 0) < neededStars) {
        return tgAlert(`Недостаточно Stars. Нужно ${neededStars} ⭐`, "error", "Недостаточно баланса");
      }
    } else if (Number(bal.rub_balance || 0) < neededRub) {
      return tgAlert(`Недостаточно RUB. Нужно ${fmtRub(neededRub)}`, "error", "Недостаточно баланса");
    }

    try {
      tgHaptic("impact");
      const res = await apiPost("/api/task/create", {
        type: type,
        title: title,
        target_url: (type === "tg") ? tgTargetToUrl(target) : normalizeUrl(target),
        instructions: txt,
        reward_rub: reward,
        cost_rub: cost,
        want_top: wantTop,
        top_price_rub: wantTop ? TOP_FIXED_PRICE_RUB : 0,
        pay_currency: payCurrency,
        qty_total: qty,
        check_type: checkType,
        tg_chat: tgChat,
        tg_kind: tgKind,
        sub_type: subType,
        target_gender: (($("t-gender") && $("t-gender").value) ? String($("t-gender").value) : "any"),
        retention_extra_days: currentRetentionExtraDays(),
        custom_review_mode: reviewMode,
        custom_review_texts: reviewTexts,
      });

      if (res && res.ok) {
        closeAllOverlays();
        tgHaptic("success");
        const paidText = (res.charged_currency === "star")
          ? `${Number(res.charged_amount || 0)} ⭐`
          : fmtRub(res.charged_amount || chargedRub);
        tgAlert(`Задание создано ✅\nСписано: ${paidText}`);
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

  // --------------------
  // Tabs
  // --------------------
  function showTab(tab) {
    if (tab === "friends") showSection("friends");
    else if (tab === "profile") showSection("profile");
    else showSection("tasks");
    // when user opens tasks tab — refresh immediately
    if (state.currentSection === "tasks") {
      try { syncTasksOnly(true); } catch (e) {}
    }
  }
  window.showTab = showTab;

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
    if (!amount || amount < 1) return tgAlert("Минимум 1 ₽");

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
    if (!amount || amount < 300) return tgAlert("Минимум 300 ₽");

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
    if (!amount || amount < 300) return tgAlert("Минимум 300 ₽");

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

    if (!amount || amount < 300) return tgAlert("Минимум 300 ₽");
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

    if (!amount || amount < 300) return tgAlert("Минимум 300 ₽");
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

  async function loadAdminProofs() {
    const box = $("admin-list");
    if (!box) return;
    box.innerHTML = "";

    const res = await apiPost("/api/admin/proof/list", {});
    let proofs = (res && res.proofs) ? res.proofs : [];
    const seen = new Set();
    proofs = proofs.filter(p => {
      const sig = [p && p.user_id, p && p.task_id, p && p.proof_url, p && p.proof_text].join("|");
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });

    if (!proofs.length) {
      box.innerHTML = `<div class="card" style="opacity:0.7;">Нет отчётов на проверку</div>`;
      return;
    }

    proofs.forEach(p => {
      const t = p.task || {};
      const taskLink = t.target_url ? normalizeUrl(t.target_url) : "";
      const proofUrl = p.proof_url ? normalizeUrl(p.proof_url) : "";
      const imgHtml = proofUrl ? `<img src="${safeText(proofUrl)}" style="width:100%; max-height:240px; object-fit:contain; border-radius:14px; margin-top:10px; background:rgba(255,255,255,0.03);" />` : "";
      const linkHtml = taskLink ? `<a href="${safeText(taskLink)}" target="_blank" class="btn btn-secondary" style="width:100%; margin-top:10px; padding:10px; text-decoration:none; justify-content:center;">🔗 Ссылка на место отзыва</a>` : "";
      const isReview = ["ya", "gm"].includes(String(t.type || "").toLowerCase());

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
      c.querySelector('[data-approve="0"]').onclick = async () => decideProof(p.id, false, c);
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
      const getUid = () => Number((um.querySelector("#admin-user-id")?.value || "").trim() || 0);
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
          if (tu.photo_url) { const im = new Image(); im.decoding = "async"; im.src = tu.photo_url; }
          renderHeader();
          renderProfile();
        }
      } catch (e) {}
    }

    bindOverlayClose();
    initTgSubtypeSelect();
    initTgTargetChecker();
    initPlatformFilterIcons();

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

  document.addEventListener("DOMContentLoaded", bootstrap);

  // Expose some globals required by HTML
  window.showTab = showTab;
  window.copyInviteLink = window.copyInviteLink;
  window.shareInvite = window.shareInvite;
  window.openAdminPanel = window.openAdminPanel;
})();
