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
        tgAlert("Отчёт отправлен ✅ Ожидай проверки модератором." + (res.xp_expected ? ("
После проверки будет +" + Number(res.xp_expected) + " XP") : ""));
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
