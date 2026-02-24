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
  };

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
      // allow CSS transition to run
      requestAnimationFrame(() => el.classList.add("rc-active"));
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
        const left = String(t && (t.qty_left ?? ""));
        const total = String(t && (t.qty_total ?? ""));
        const st = String(t && (t.status ?? ""));
        return id + ":" + left + "/" + total + ":" + st;
      }).sort();
      return parts.join("|");
    } catch (e) {
      return "";
    }
  }

  function balanceSignature(bal) {
    try {
      const b = bal || {};
      const rub = Math.round(Number(b.rub_balance || 0) * 100) / 100;
      const stars = Math.round(Number(b.stars_balance || 0) * 100) / 100;
      const xp = Math.round(Number(b.xp || 0));
      const lvl = Math.round(Number(b.level || 0));
      return [rub, stars, xp, lvl].join("|");
    } catch (e) {
      return "";
    }
  }

  async function syncTasksOnly(forceRender = false) {
    try {
      const payload = { device_hash: state.deviceHash, device_id: state.deviceHash };
      const ref = state.startParam && /^\d+$/.test(state.startParam) ? Number(state.startParam) : null;
      if (ref) payload.referrer_id = ref;

      const data = await apiPost("/api/sync", payload);
      if (!data || !data.ok) return;

      // keep user/balance fresh too
      state.user = data.user || state.user;

      const newBal = data.balance || state.balance || {};
      const newBalSig = balanceSignature(newBal);
      const balChanged = newBalSig !== (state._balSig || "");
      if (balChanged) {
        state.balance = newBal;
        state._balSig = newBalSig;
      }

      const newTasks = Array.isArray(data.tasks) ? data.tasks : [];
      migrateCompletedAnonToUser();

      const newSig = tasksSignature(newTasks);
      const tasksChanged = newSig !== state._tasksSig;
      if (tasksChanged) {
        state.tasks = newTasks;
        state._tasksSig = newSig;
      }

      // Always refresh header/profile if balance changed (XP/LVL bar must update)
      if (forceRender || balChanged) {
        renderHeader();
        renderProfile();
      }

      // Render tasks only when needed
      if (forceRender || (tasksChanged && state.currentSection === "tasks")) {
        renderTasks();
      }
    } catch (e) {
      // silent
    }
  }

  function startTasksAutoRefresh() {
    try {
      if (state._tasksRefreshTimer) clearInterval(state._tasksRefreshTimer);
    } catch (e) {}

    // refresh every 12s while app is visible
    state._tasksRefreshTimer = setInterval(() => {
      if (document.hidden) return;
      syncTasksOnly(false);
    }, 12000);

    // also refresh when user returns to the app
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) syncTasksOnly(state.currentSection === "tasks");
    });
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
    state._balSig = balanceSignature(state.balance);
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
    ya: 'data:image/png;base64,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',
    gm: 'data:image/png;base64,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',
    tg: 'data:image/png;base64,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',
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

  function openTaskDetails(task) {
    state.currentTask = task;

    $("td-title").textContent = task.title || "Задание";
    $("td-reward").textContent = "+" + fmtRub(task.reward_rub || 0);
    const _ico = $("td-icon");
    if (_ico) { _ico.classList.add("rc-icon"); _ico.innerHTML = brandIconHtml(task, 56); }
    $("td-type-badge").textContent = taskTypeLabel(task);
    $("td-link").textContent = task.target_url || "";
    $("td-text").textContent = task.instructions || "Выполните задание и отправьте отчёт.";

    const link = normalizeUrl(task.target_url || "");
    const a = $("td-link-btn");
    if (a) {
      a.href = link || "#";

      // IMPORTANT: record "Перейти к выполнению" click (backend requires it for manual checks)
      a.onclick = async (e) => {
        try { if (e) e.preventDefault(); } catch (e2) {}

        try { localStorage.setItem("rc_task_clicked:" + String(task.id), String(Date.now())); } catch (e2) {}


        // best-effort: even if this fails, still open the link
        try { await apiPost("/api/task/click", { task_id: String(task.id) }); } catch (e3) {}

        try {
          if (tg) {
            // Telegram links open лучше через openTelegramLink
            if (/^https?:\/\/t\.me\//i.test(link) && tg.openTelegramLink) return tg.openTelegramLink(link);
            if (tg.openLink) return tg.openLink(link);
          }
        } catch (e4) {}

        try { window.open(link, "_blank"); } catch (e5) { window.location.href = link; }
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
      if (isAuto) {
        btn.textContent = "✅ Проверить и получить награду";
        btn.onclick = () => submitTaskAuto(task);
      } else {
        btn.textContent = "📤 Отправить отчёт";
        btn.onclick = () => submitTaskManual(task);
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
        tgAlert("Готово! Начислено: +" + fmtRub(res.earned || task.reward_rub || 0) + (res.xp_added ? (" и +" + Number(res.xp_added) + " XP") : ""));
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

      // If user pressed «Перейти к выполнению», re-touch click (Telegram WebView can drop the first request)
      try {
        const k = "rc_task_clicked:" + String(task.id);
        const ts = Number(localStorage.getItem(k) || "0");
        if (ts && (Date.now() - ts) < (6 * 3600 * 1000)) {
          await apiPost("/api/task/click", { task_id: String(task.id) });
        }
      } catch (e) {}

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
        tgAlert("Отчёт отправлен ✅ Ожидай проверки модератором." + (res.xp_expected ? ("\nПосле проверки будет +" + Number(res.xp_expected) + " XP") : ""));
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
    try { syncTasksOnly(true); } catch (e) {}
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

    // prevent double render (Telegram WebView can trigger double tap / fast tab switches)
    state._adminProofsSeq = (state._adminProofsSeq || 0) + 1;
    const seq = state._adminProofsSeq;

    box.innerHTML = `<div class="card" style="opacity:0.7;">Загрузка...</div>`;

    const res = await apiPost("/api/admin/proof/list", {});
    if (seq !== state._adminProofsSeq) return; // stale response

    const proofsRaw = (res && res.proofs) ? res.proofs : [];
    const seen = new Set();
    const proofs = [];
    proofsRaw.forEach(p => {
      const id = String(p && p.id || "");
      if (!id || seen.has(id)) return;
      seen.add(id);
      proofs.push(p);
    });

    if (!proofs.length) {
      box.innerHTML = `<div class="card" style="opacity:0.7;">Нет отчётов на проверку</div>`;
      return;
    }

    box.innerHTML = "";

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
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-top:12px;">
          <button class="btn btn-main" data-approve="1">✅ Принять</button>
          <button class="btn btn-secondary" data-approve="0">❌ Отклонить</button>
          <button class="btn btn-secondary" data-fake="1" style="border-color:rgba(255,80,80,.55); color:#ff7a7a;">🚫 Фейк</button>
        </div>
      `);

      c.querySelector('[data-approve="1"]').onclick = async () => decideProof(p.id, true, c, false);
      c.querySelector('[data-approve="0"]').onclick = async () => decideProof(p.id, false, c, false);
      const fb = c.querySelector('[data-fake="1"]');
      if (fb) fb.onclick = async () => decideProof(p.id, false, c, true);
      box.appendChild(c);
    });
  }

  async function decideProof(proofId, approved, cardEl, fake) {
    try {
      tgHaptic("impact");
      if (fake) {
        const ok = await tgConfirm("Отметить как фейк? Пользователь получит блокировку на 3 дня.");
        if (!ok) return;
      }
      await apiPost("/api/admin/proof/decision", { proof_id: proofId, approved: !!approved, fake: !!fake });
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
    const list = (res && res.tasks) ? res.tasks : [];

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
    forceInitialView();

    if (tg) {
      try {
        tg.ready();
        tg.expand();
      } catch (e) {}
      state.initData = tg.initData || "";
      try { state.startParam = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) ? String(tg.initDataUnsafe.start_param) : ""; } catch (e) {}
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
