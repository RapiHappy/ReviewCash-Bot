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

      // keep user/balance fresh too (so header numbers update)
      state.user = data.user || state.user;
      state.balance = data.balance || state.balance;
      const newTasks = Array.isArray(data.tasks) ? data.tasks : [];

      migrateCompletedAnonToUser();

      const newSig = tasksSignature(newTasks);
      const changed = newSig !== state._tasksSig;

      if (changed) {
        state.tasks = newTasks;
        state._tasksSig = newSig;
      }

      // render only when user is on tasks screen (or when forced)
      if (forceRender || (changed && state.currentSection === "tasks")) {
        renderHeader();
        renderProfile();
        renderTasks();
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
    // --------------------
  // Brand icons (original emblems, embedded as PNG = instant, no network)
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
  state._tgCheck = { value: "", valid: false, chat: null, msg: "" };

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

  function setTargetStatus(kind, title, desc) {
    const box = $("t-target-status");
    if (!box) return;
    const k = String(kind || "");
    box.className = "input-status" + (k ? " is-" + k : "");

    if (!title) {
      box.innerHTML = "";
      return;
    }

    const spinner = k === "loading" ? '<span class="st-spin" aria-hidden="true"></span>' : "";
    const ico = k === "ok" ? "✅" : k === "err" ? "⚠️" : k === "loading" ? "" : "";

    box.innerHTML = `
      <div class="st-row">${spinner}<span class="st-ico">${ico}</span><span class="st-title">${escapeHtml(title)}</span></div>
      ${desc ? `<div class="st-desc">${escapeHtml(desc)}</div>` : ""}
    `;
  }

  async function runTgCheckNow(rawValue) {
    const value = String(rawValue || "").trim();
    const chat = normalizeTgChatInput(value);

    state._tgCheck.value = value;
    state._tgCheck.valid = false;
    state._tgCheck.chat = null;
    state._tgCheck.msg = "";

    if (!value) {
      setTargetStatus("", "", "");
      return;
    }

    if (!chat) {
      setTargetStatus(
        "err",
        "Нужен @юзернейм канала/группы",
        "Пример: @MyChannel или https://t.me/MyChannel"
      );
      return;
    }

    const seq = ++_tgCheckSeq;
    setTargetStatus("loading", "Проверяем…", "Пробуем найти чат и проверить, что бот добавлен");

    try {
      const res = await apiPost("/api/tg/check_chat", { target: chat });
      if (seq !== _tgCheckSeq) return; // outdated

      if (res && res.ok && res.valid) {
        const name = res.title ? String(res.title) : chat;
        const type = res.type ? (String(res.type) === "channel" ? "Канал" : "Группа") : "Чат";
        state._tgCheck.valid = true;
        state._tgCheck.chat = res.chat || chat;
        setTargetStatus("ok", `${type}: ${name}`, "Можно создавать задание ✅");
      } else {
        const msg = (res && (res.message || res.error)) ? String(res.message || res.error) : "Не удалось проверить";
        state._tgCheck.valid = false;
        state._tgCheck.chat = res && res.chat ? res.chat : chat;
        state._tgCheck.msg = msg;
        setTargetStatus("err", "Нельзя создать TG-задание", msg);
      }
    } catch (e) {
      if (seq !== _tgCheckSeq) return;
      state._tgCheck.valid = false;
      const msg = prettifyErrText(String(e.message || e));
      setTargetStatus("err", "Проверка не прошла", msg);
    }
  }

  function scheduleTgCheck() {
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
      checkType = tgChat ? "auto" : "manual";
      tgKind = "member_check";
    }


    // Nice TG validation before sending request (so user doesn't see raw 400)
    if (type === "tg") {
      if (!tgChat) {
        tgAlert("Для Telegram-задания нужен @юзернейм канала/группы.\nПример: @MyChannel или https://t.me/MyChannel", "error", "Укажи чат");
        scheduleTgCheck();
        return;
      }

      // If we already checked this chat and it failed — show the reason
      try {
        if (state._tgCheck && state._tgCheck.chat === tgChat && state._tgCheck.valid === false && state._tgCheck.msg) {
          tgAlert(state._tgCheck.msg, "error", "Нельзя создать TG-задание");
          return;
        }
      } catch (e) {}

      // Quick server check (shows nice animated status)
      try {
        setTargetStatus("loading", "Проверяем…", "Это занимает пару секунд");
        const chk = await apiPost("/api/tg/check_chat", { target: tgChat });
        if (!chk || !chk.valid) {
          const msg = chk && (chk.message || chk.error) ? String(chk.message || chk.error) : "Добавь бота в чат/канал и попробуй снова";
          setTargetStatus("err", "Нельзя создать TG-задание", msg);
          tgAlert(msg, "error", "Проверка Telegram");
          return;
        }
        // ok
        const nm = chk.title ? String(chk.title) : tgChat;
        const tp = chk.type ? (String(chk.type) === "channel" ? "Канал" : "Группа") : "Чат";
        setTargetStatus("ok", `${tp}: ${nm}`, "ОК ✅");
        state._tgCheck.valid = true;
        state._tgCheck.chat = chk.chat || tgChat;
      } catch (e) {
        const msg = prettifyErrText(String(e.message || e));
        setTargetStatus("err", "Проверка не прошла", msg);
        tgAlert(msg, "error", "Проверка Telegram");
        return;
      }
    }
    try {
      tgHaptic("impact");
      const res = await apiPost("/api/task/create", {
        type: type,
        title: title,
        target_url: normalizeUrl(target),
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

  async function loadAdminTasks() {
    const box = $("admin-task-list");
    if (!box) return;
    box.innerHTML = "";

    const res = await apiPost("/api/admin/task/list", {});
    const rawList = (res && res.tasks) ? res.tasks : [];
    const list = rawList.filter(t => String(t && t.status || "active") === "active" && Number(t && t.qty_left || 0) > 0);

    if (!list.length) {
      box.innerHTML = `<div class="card" style="opacity:0.7;">Нет активных заданий</div>`;
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
            <div style="font-size:12px; color:var(--text-dim);">Owner: ${safeText(owner)} • Награда: ${fmtRub(t.reward_rub || 0)} • Осталось: ${safeText(qty)}</div>
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
  // Bootstrap
  // --------------------
  async function bootstrap() {
    state.api = getApiBase();
    initDeviceHash();
    // init performance mode ASAP (affects animations + refresh interval)
    applyPerfMode(getInitialPerfMode());
    forceInitialView();

    if (tg) {
      try {
        tg.ready();
        tg.expand();
      } catch (e) {}
      state.initData = tg.initData || "";
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
