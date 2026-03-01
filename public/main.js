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

  const RC_BUILD = "rc_20260225_181352";
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
    return t.trim();
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
  const TG_TASK_TYPES = [
    { id: "sub_channel", title: "Подписка на канал", reward: 5, desc: "Подписка на Telegram-канал" },
    { id: "join_group", title: "Вступление в группу", reward: 3, desc: "Вступление в Telegram-группу" },
    { id: "view_react", title: "Просмотр + реакция", reward: 5, desc: "Просмотр поста и реакция" },
    { id: "poll", title: "Участие в опросе", reward: 3, desc: "Голосование в опросе" },
    { id: "bot_start", title: "Запуск бота /start", reward: 12, desc: "Нажать /start в боте" },
    { id: "bot_msg", title: "Сообщение боту", reward: 4, desc: "Отправить сообщение боту" },
    { id: "open_miniapp", title: "Открыть Mini App", reward: 10, desc: "Открыть приложение" },
    { id: "sub_24h", title: "Подписка + 24ч", reward: 30, desc: "Подписка и не отписываться 24 часа" },
    { id: "invite_friends", title: "Инвайт друзей", reward: 50, desc: "Пригласить друзей" },
  ];

  // Reviews payouts you asked for
  const YA = { costPer: 120, reward: 100, title: "Яндекс Карты — отзыв" };
  const GM = { costPer: 75, reward: 60, title: "Google Maps — отзыв" };

  // --------------------
  // State
  // --------------------
  const state = {
    api: "",
    initData: "",
    startParam: "",
    deviceHash: "",
    user: null,
    balance: { rub_balance: 0, stars_balance: 0, xp: 0, level: 1 },
    tasks: [],
    filter: "all",
    platformFilter: (localStorage.getItem("rc_platform_filter") || "all"),
    currentTask: null,
    isAdmin: false,
    adminCounts: { proofs: 0, withdrawals: 0, tbank: 0 },
    tbankCode: "",
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
    const el = $("perf-mode-label");
    if (!el) return;
    el.textContent = (state.perfMode === "low") ? "Слабое устройство" : "Нормальный";
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
    tgAlert("Режим: " + (state.perfMode === "low" ? "Слабое устройство" : "Нормальный"), "info", "Настройки");
  }
  window.togglePerfMode = togglePerfMode;

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
    return h;
  }

  async function apiPost(path, body) {
if (!state.initData) {
  const err = new Error("Открой мини‑приложение внутри Telegram (нет initData).");
  err.status = 401; err.path = path;
  throw err;
}

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
  }

  function openOverlay(id) {
    const el = $(id);
    if (!el) return;
    el.style.display = "flex";
    document.body.style.overflow = "hidden";

    // small UX hooks
    try {
      if (id === "m-create") {
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

      // keep user/balance fresh too
      const prevBalSig = balanceSignature(state.balance);
      state.user = data.user || state.user;
      state.balance = data.balance || state.balance;
      const newBalSig = balanceSignature(state.balance);
      const balanceChanged = prevBalSig !== newBalSig;
      const newTasks = Array.isArray(data.tasks) ? data.tasks : [];

      migrateCompletedAnonToUser();

      const newSig = tasksSignature(newTasks);
      const changed = newSig !== state._tasksSig;

      if (changed) {
        state.tasks = newTasks;
        state._tasksSig = newSig;
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
    state.tasks = Array.isArray(data.tasks) ? data.tasks : [];

    // If some tasks were completed before user_id was known, migrate from anon bucket
    migrateCompletedAnonToUser();
    state._tasksSig = tasksSignature(state.tasks);

    renderHeader();
    renderProfile();
    renderInvite();
    renderTasks();
    await refreshWithdrawals();
    await refreshOpsSilent();
    await refreshReferrals();
    
  await checkAdmin();
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

  function levelFromXp(xp) {
    const x = Number(xp || 0);
    const lvl = Math.floor(x / 100) + 1;
    const cur = x % 100;
    return { lvl, cur, next: 100 };
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
    if ($("u-lvl-badge")) $("u-lvl-badge").textContent = "LVL " + (b.level || xpInfo.lvl);
    if ($("u-xp-cur")) $("u-xp-cur").textContent = `${Math.round(b.xp || 0)} XP`;
    if ($("u-xp-next")) $("u-xp-next").textContent = `${xpInfo.next} XP`;
    const fill = $("u-xp-fill");
    if (fill) fill.style.width = clamp((xpInfo.cur / xpInfo.next) * 100, 0, 100) + "%";
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
  window.setPlatformFilter = setPlatformFilter;

  // --------------------
  // --------------------
  // Brand icons (tiny inline SVG = fast, no network)
  // --------------------
  
  // --------------------
  // Brand icons (original logos, embedded as tiny WEBP = instant, no network)
  // --------------------
  const BRAND_ICON_URI = {
    ya: "data:image/png;base64,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",
    gm: "data:image/png;base64,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",
    tg: "data:image/png;base64,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",
  };

  function brandIconHtml(taskOrType, sizePx = 38) {
    const tRaw = (typeof taskOrType === "string") ? taskOrType : (taskOrType && (taskOrType.type || taskOrType.platform));
    const t = String(tRaw || "").toLowerCase();
    const key = (t === "ya" || t === "yandex") ? "ya" : (t === "gm" || t === "google") ? "gm" : "tg";
    const s = Number(sizePx) || 38;
    const uri = BRAND_ICON_URI[key] || BRAND_ICON_URI.tg;
    const alt = (key === "ya") ? "Яндекс" : (key === "gm") ? "Google" : "Telegram";

    // IMPORTANT: use rounded-square mask to avoid white edge artifacts on some devices
    return `<img class="brand-img" src="${uri}" alt="${alt}" style="width:${s}px;height:${s}px;" />`;
  }

  function initPlatformFilterIcons() {
    const nodes = document.querySelectorAll("[data-pf-ico]");
    nodes.forEach(n => {
      const k = String(n.getAttribute("data-pf-ico") || "").toLowerCase();
      if (k === "ya" || k === "gm" || k === "tg") n.innerHTML = brandIconHtml(k, 18);
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
    let list = state.tasks.slice();

    // Hide tasks that this user already completed
    list = list.filter(t => !isTaskCompleted(t && t.id));

    // Hide tasks that are fully completed (no slots left)
    list = list.filter(t => Number(t.qty_left || 0) > 0);

    if (state.filter === "my" && uid) {
      list = list.filter(t => Number(t.owner_id) === Number(uid));
    }

    

    if (state.platformFilter && state.platformFilter !== "all") {
      list = list.filter(t => String((t.type || t.platform || "")).toLowerCase() === state.platformFilter);
    }
if (!list.length) {
      box.innerHTML = `<div class="card" style="text-align:center; color:var(--text-dim);">Пока нет активных заданий.</div>`;
      return;
    }

    box.innerHTML = "";
    
    list.forEach(t => {
      const left = Number(t.qty_left || 0);
      const total = Number(t.qty_total || 0);
      const done = Math.max(0, total - left);
      const prog = total > 0 ? Math.round((done / total) * 100) : 0;

      const isOwner = (state.filter === "my" && uid && Number(t.owner_id) === Number(uid));

      const metaLine = isOwner
        ? `${taskTypeLabel(t)} • выполнено ${done}/${total} • осталось ${left}/${total}`
        : `${taskTypeLabel(t)}`;

      const progressHtml = isOwner
        ? `<div class="xp-track" style="height:8px;"><div class="xp-fill" style="width:${clamp(prog, 0, 100)}%"></div></div>`
        : ``;

      const card = document.createElement("div");
      card.className = "card";
      card.style.cursor = "pointer";
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
          <div style="flex:1;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
              <div class="brand-box" style="width:38px; height:38px; font-size:18px;">${brandIconHtml(t, 38)}</div>
              <div>
                <div style="font-weight:900; font-size:14px; line-height:1.2;">${safeText(t.title || "Задание")}</div>
                <div style="font-size:12px; color:var(--text-dim);">${metaLine}</div>
              </div>
            </div>
            ${progressHtml}
          </div>
          <div style="text-align:right; min-width:90px;">
            <div style="font-weight:900; color:var(--accent-green); font-size:16px;">+${fmtRub(t.reward_rub || 0)}</div>
            <div style="font-size:11px; opacity:0.6;">за выполнение</div>
          </div>
        </div>
      `;
      card.addEventListener("click", () => openTaskDetails(t));
      box.appendChild(card);
    });
}

  function normalizeUrl(u) {
    let s = String(u || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    return s;
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
    $("td-text").textContent = (isOwner ? "⚠️ Это ваше задание. Выполнить и получить награду нельзя.\n\n" : "") + (task.instructions || "Выполните задание и отправьте отчёт.");

    const link = normalizeUrl(task.target_url || "");
    const a = $("td-link-btn");
    if (a) a.href = link || "#";

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

  window.copyLink = function () {
    const el = $("td-link");
    const text = el ? el.textContent : "";
    copyText(text);
  };

  function copyText(text) {
    const s = String(text || "");
    if (!s) return;
    try {
      navigator.clipboard.writeText(s);
      tgHaptic("success");
      tgAlert("Скопировано ✅");
    } catch (e) {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = s;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      tgAlert("Скопировано ✅");
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
    if (isTaskOwner(task)) {
      tgHaptic("error");
      return tgAlert("Нельзя выполнять своё задание");
    }
    try {
      tgHaptic("impact");
      const res = await apiPost("/api/task/submit", { task_id: String(task.id) });
      if (res && res.ok) {
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

  async function submitTaskManual(task) {
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
        // Make the task disappear right away for this user
        markTaskCompleted(task.id);
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
    }
  }

  // --------------------
  // Create task + pricing
  // --------------------
  function initTgSubtypeSelect() {
    const sel = $("t-tg-subtype");
    if (!sel) return;
    sel.innerHTML = "";
    TG_TASK_TYPES.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.title} — ${t.reward}₽`;
      opt.dataset.reward = String(t.reward);
      opt.dataset.desc = t.desc;
      sel.appendChild(opt);
    });
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

  const TG_MANUAL_ONLY = new Set(["bot_start", "bot_msg", "open_miniapp", "view_react", "poll"]);

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

  function tgAutoPossible(subType, tgKind) {
    if (tgKind !== "chat") return false;
    return subType === "sub_channel" || subType === "join_group";
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
      textEl.textContent = "Бот сможет проверить выполнение автоматически, если добавлен в чат/канал (для канала — админ).";
      try {
        wrap.style.background = "rgba(0,234,255,0.05)";
        wrap.style.borderColor = "var(--glass-border)";
      } catch (e) {}
    }
  }

  async function runTgCheckNow(rawValue) {
    const type = currentCreateType();
    const value = String(rawValue || "").trim();

    if (type !== "tg") {
      setTargetStatus("", "", "");
      return;
    }

    const sid = currentTgSubtype();
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
        // fallback to manual
        state._tgCheck.valid = true;
        state._tgCheck.chat = chat;
        state._tgCheck.forceManual = true;
        setTargetStatus("ok", `TG: ${chat}`, "Авто недоступно → будет ручная проверка (скрин) ✅");
        updateTgHint();
      }
    } catch (e) {
      if (seq !== _tgCheckSeq) return;
      state._tgCheck.valid = true;
      state._tgCheck.chat = chat;
      state._tgCheck.forceManual = true;
      setTargetStatus("ok", `TG: ${chat}`, "Авто недоступно → будет ручная проверка (скрин) ✅");
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
  }
  function recalc() {
    const type = currentCreateType();
    const qty = clamp(Number(($("t-qty") && $("t-qty").value) || 1), 1, 1000000);
    const cur = $("t-cur") ? $("t-cur").value : "rub";

    const tgWrap = $("tg-subtype-wrapper");
    const tgOpt = $("tg-options");
    if (tgWrap) tgWrap.classList.toggle("hidden", type !== "tg");
    if (tgOpt) tgOpt.classList.toggle("hidden", type !== "tg");

    let total = 0;
    let reward = 0;
    let costPer = 0;

    if (type === "ya") {
      reward = YA.reward;
      costPer = YA.costPer;
      total = costPer * qty;
    } else if (type === "gm") {
      reward = GM.reward;
      costPer = GM.costPer;
      total = costPer * qty;
    } else {
      // tg
      const sid = currentTgSubtype();
      const conf = TG_TASK_TYPES.find(x => x.id === sid) || TG_TASK_TYPES[0];
      reward = conf.reward;
      // customer pays ~2x (like your backend default); total = reward*2*qty
      total = reward * 2 * qty;
      const descEl = $("tg-subtype-desc");
      if (descEl) descEl.textContent = conf.desc + " • Исполнитель получит " + reward + "₽";
    }

    updateTgHint();

    // currency display only (backend charges RUB in this version)
    const totalEl = $("t-total");
    if (totalEl) totalEl.textContent = cur === "star" ? (Math.round(total) + " ⭐") : fmtRub(total);

    // target status reset
    const s = $("t-target-status");
    if (s) s.textContent = "";
  }
  window.recalc = recalc;

  async function createTask() {
    const type = currentCreateType();
    const qty = clamp(Number(($("t-qty") && $("t-qty").value) || 1), 1, 1000000);
    const target = String(($("t-target") && $("t-target").value) || "").trim();
    const txt = String(($("t-text") && $("t-text").value) || "").trim();

    if (!target) {
      if (type === "tg") return tgAlert("Укажи @канал или @группу (пример: @MyChannel)", "error", "Нужно указать чат");
      return tgAlert("Укажи ссылку на карточку места (Яндекс/Google)", "error", "Нужна ссылка");
    }

    // При создании задания допускаются только ссылки и @юзернеймы
    if (type === "tg") {
      const tgChatTry = normalizeTgChatInput(target);
      if (!tgChatTry) {
        tgAlert("Можно только @юзернейм или ссылка t.me.\nПример: @MyChannel или https://t.me/MyChannel", "error", "Некорректный Telegram");
        scheduleTgCheck();
        return;
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

    let title = "";
    let reward = 0;
    let cost = 0;
    let checkType = "manual";
    let tgChat = null;
    let tgKind = null;
    let subType = null;

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
      reward = conf.reward;
      cost = reward * 2 * qty;
      subType = conf.id;

      tgChat = normalizeTgChatInput(target);
      tgKind = tgIsBotTarget(target, tgChat) ? "bot" : "chat";
      const manualOnly = (tgKind === "bot") || TG_MANUAL_ONLY.has(subType);
      checkType = manualOnly ? "manual" : (tgAutoPossible(subType, tgKind) ? "auto" : "manual");
    }


    // Nice TG validation before sending request (so user doesn't see raw 400)
    if (type === "tg") {
      if (!tgChat) {
        tgAlert("Для Telegram-задания нужен @юзернейм канала/группы.\nПример: @MyChannel или https://t.me/MyChannel", "error", "Укажи чат");
        scheduleTgCheck();
        return;
      }
      // If we checked and it failed, we will fallback to manual check (no hard block)

      // TG check:
      // - For bots and manual-only subtypes: no membership check, manual proof.
      // - For membership subtypes: try auto-check; if not possible, fallback to manual (no hard error).
      const manualOnly = (tgKind === "bot") || TG_MANUAL_ONLY.has(subType) || !tgAutoPossible(subType, tgKind);

      if (manualOnly) {
        const label = tgKind === "bot" ? `Бот: ${tgChat}` : `TG: ${tgChat}`;
        setTargetStatus("ok", label, "Ручная проверка (нужен скрин) ✅");
        state._tgCheck.valid = true;
        state._tgCheck.chat = tgChat;
        state._tgCheck.forceManual = true;
        checkType = "manual";
        updateTgHint();
      } else {
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
            checkType = "manual";
            state._tgCheck.forceManual = true;
            setTargetStatus("ok", `TG: ${tgChat}`, "Авто недоступно → будет ручная проверка (скрин) ✅");
            updateTgHint();
            tgAlert(msg + "\nЗадание будет создано с ручной проверкой.", "info", "Проверка Telegram");
          }
        } catch (e) {
          const msg = prettifyErrText(String(e.message || e));
          checkType = "manual";
          state._tgCheck.forceManual = true;
          setTargetStatus("ok", `TG: ${tgChat}`, "Авто недоступно → будет ручная проверка (скрин) ✅");
          updateTgHint();
          tgAlert(msg + "\nЗадание будет создано с ручной проверкой.", "info", "Проверка Telegram");
        }
      }
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
        qty_total: qty,
        check_type: checkType,
        tg_chat: tgChat,
        tg_kind: tgKind,
        sub_type: subType,
      });

      if (res && res.ok) {
        closeAllOverlays();
        tgHaptic("success");
        tgAlert("Задание создано ✅");
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

  function renderWithdrawals(list) {
    const box = $("withdrawals-list");
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<div style="color:var(--text-dim); font-size:13px;">Нет заявок</div>`;
      return;
    }
    box.innerHTML = "";
    list.forEach(w => {
      const st = String(w.status || "pending");
      const stLabel = st === "paid" ? "✅ Выплачено" : (st === "rejected" ? "❌ Отклонено" : "⏳ В обработке");
      const row = document.createElement("div");
      row.className = "card";
      row.style.margin = "0";
      row.style.padding = "12px";
      row.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:900;">${fmtRub(w.amount_rub || 0)}</div>
            <div style="font-size:12px; color:var(--text-dim);">${safeText(w.details || "")}</div>
          </div>
          <div style="font-size:12px; opacity:0.8;">${stLabel}</div>
        </div>
      `;
      box.appendChild(row);
    });
  }

  window.requestWithdraw = async function () {
    const details = String(($("w-details") && $("w-details").value) || "").trim();
    const amount = Number(($("w-amount") && $("w-amount").value) || 0);

    if (!details) return tgAlert("Укажи реквизиты");
    if (!amount || amount < 300) return tgAlert("Минимум 300₽");

    try {
      tgHaptic("impact");
      const res = await apiPost("/api/withdraw/create", { details: details, amount_rub: amount });
      if (res && res.ok) {
        tgHaptic("success");
        tgAlert("Заявка создана ✅");
        $("w-amount").value = "";
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
    if (!list.length) {
      box.innerHTML = `<div class="menu-item" style="margin:0; opacity:0.7;">История пуста</div>`;
      return;
    }
    box.innerHTML = "";
    list.forEach(op => {
      const kind = String(op.kind || "");
      let title = "";
      let sub = "";
      if (kind === "payment") {
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
        <div style="font-weight:900;">${fmtRub(op.amount_rub || 0)}</div>
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

    const amount = Number(($("sum-input") && $("sum-input").value) || 0);
    if (!amount || amount < 300) return tgAlert("Минимум 300 ₽");

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
  };

  window.copyCode = function () {
    copyText(state.tbankCode || "");
  };

  window.confirmTBank = async function () {
    const amountStr = ($("tb-amount-display") && $("tb-amount-display").textContent) || "";
    const amount = Number(String(amountStr).replace(/[^\d.,]/g, "").replace(",", ".")) || Number(($("sum-input") && $("sum-input").value) || 0);
    const sender = String(($("tb-sender") && $("tb-sender").value) || "").trim();

    if (!amount || amount < 300) return tgAlert("Минимум 300 ₽");
    if (!sender) return tgAlert("Укажи имя отправителя");

    try {
      tgHaptic("impact");
      const res = await apiPost("/api/tbank/claim", {
        amount_rub: amount,
        sender: sender,
        code: state.tbankCode,
      });
      if (res && res.ok) {
        tgHaptic("success");
        tgAlert("Заявка отправлена ✅ Ожидай подтверждение админом.");
        closeAllOverlays();
        $("tb-sender").value = "";
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
        renderAdminBadge();
        const apc = $("admin-panel-card");
        if (apc) apc.style.display = "block";
      } else {
        state.isAdmin = false;
        state.isMainAdmin = false;
        const apc2 = $("admin-panel-card");
        if (apc2) apc2.style.display = "none";
      }
    } catch (e) {
      state.isAdmin = false;
        state.isMainAdmin = false;
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
    await switchAdminTab("proofs");
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
    const proofs = (res && res.proofs) ? res.proofs : [];
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
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px;">
          <button class="btn btn-main" data-approve="1">✅ Принять</button>
          <button class="btn btn-secondary" data-approve="0">❌ Отклонить</button>
        </div>
      `);

      c.querySelector('[data-approve="1"]').onclick = async () => decideProof(p.id, true, c);
      c.querySelector('[data-approve="0"]').onclick = async () => decideProof(p.id, false, c);
      box.appendChild(c);
    });
  }

  async function decideProof(proofId, approved, cardEl) {
    try {
      tgHaptic("impact");
      await apiPost("/api/admin/proof/decision", { proof_id: proofId, approved: !!approved });
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
      const c = adminCard(`
        <div style="font-weight:900;">Вывод ${fmtRub(w.amount_rub || 0)}</div>
        <div style="font-size:12px; color:var(--text-dim);">User: ${safeText(w.user_id)} • ${safeText(w.details || "")}</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px;">
          <button class="btn btn-main" data-approve="1">✅ Выплатить</button>
          <button class="btn btn-secondary" data-approve="0">❌ Отклонить</button>
        </div>
      `);
      c.querySelector('[data-approve="1"]').onclick = async () => decideWithdraw(w.id, true, c);
      c.querySelector('[data-approve="0"]').onclick = async () => decideWithdraw(w.id, false, c);
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
      const c = adminCard(`
        <div style="font-weight:900;">T-Bank ${fmtRub(p.amount_rub || 0)}</div>
        <div style="font-size:12px; color:var(--text-dim);">User: ${safeText(p.user_id)} • Code: ${safeText(p.provider_ref || "")}</div>
        <div style="font-size:12px; color:var(--text-dim);">Sender: ${safeText(sender)}</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px;">
          <button class="btn btn-main" data-approve="1">✅ Подтвердить</button>
          <button class="btn btn-secondary" data-approve="0">❌ Отклонить</button>
        </div>
      `);
      c.querySelector('[data-approve="1"]').onclick = async () => decideTbank(p.id, true, c);
      c.querySelector('[data-approve="0"]').onclick = async () => decideTbank(p.id, false, c);
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

  
  async function auditTgTasks() {
    if (!state.isMainAdmin) {
      tgAlert("Только главный админ может запускать проверку.", "error", "Админка");
      return;
    }
    const ok = await tgConfirm("Проверить ВСЕ TG-задания и выставить авто/ручную проверку автоматически?");
    if (!ok) return;
    try {
      tgHaptic("impact");
      const res = await apiPost("/api/admin/task/tg_audit", {});
      const total = Number(res.total_tg || 0);
      const changed = Number(res.changed || 0);
      const a = Number(res.set_auto || 0);
      const m = Number(res.set_manual || 0);
      const p = Number(res.problems || 0);
      tgHaptic("success");
      tgAlert(`Готово ✅\nTG задач: ${total}\nИзменено: ${changed}\nАвто: ${a}\nРучн.: ${m}${p ? `\nПроблем: ${p}` : ""}`, "success", "TG аудит");
      await loadAdminTasks();
    } catch (e) {
      tgHaptic("error");
      tgAlert(String(e.message || e), "error", "TG аудит");
    }
  }

async function loadAdminTasks() {
    const box = $("admin-task-list");
    if (!box) return;
    box.innerHTML = "";
    // Tools (visible to all admins; action available only to main admin)
    if (state.isAdmin) {
      const tools = adminCard(`
        <div style="display:flex; gap:10px;">
          <button class="btn btn-main" data-tg-audit="1" style="flex:1;" ${state.isMainAdmin ? "" : "disabled"}>${state.isMainAdmin ? "🔄 Проверить TG задания" : "🔒 Проверить TG задания"}</button>
        </div>
        <div style="font-size:11px; opacity:0.65; margin-top:8px;">Авто/ручная проверка выставится по доступу бота и типу цели. (Запускать может только главный админ)</div>
      `);
      const b = tools.querySelector('[data-tg-audit="1"]');
      if (b) b.onclick = auditTgTasks;
      box.appendChild(tools);
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
// --- Telegram initData fallback (when tg.initData is empty) ---
function extractTgWebAppDataFromUrl() {
  try {
    // Telegram may pass tgWebAppData in URL hash or query string depending on platform.
    const h = String(location.hash || "");
    const s = String(location.search || "");

    const all = (h.startsWith("#") ? h.slice(1) : h) + (s ? ("&" + s.slice(1)) : "");
    const params = new URLSearchParams(all);

    // IMPORTANT:
    // URLSearchParams already decodes percent-encoding and may convert "+" to spaces.
    // We must NOT decode again; and we must restore "+" if it became spaces.
    let v = params.get("tgWebAppData") || params.get("tgWebAppDataRaw") || "";
    if (!v) return "";

    // restore '+' that may become spaces
    v = v.replace(/ /g, "+");

    return v;
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
    forceInitialView();

    
// initData is required for backend auth. Try Telegram WebApp first, then URL fallback.
state.initData = "";
if (tg) {
try { if (typeof tg.ready === "function") tg.ready(); } catch (e) {}
// Desktop/WebView clients sometimes populate initData only after ready()
await new Promise(r => setTimeout(r, 0));
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
    
// URL fallback even outside Telegram (e.g., if opened via t.me link in browser)
if (!state.initData) {
  const fb = extractTgWebAppDataFromUrl();
  if (fb) state.initData = fb;
}
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
    await syncAll();
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
