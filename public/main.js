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
    ya: "data:image/webp;base64,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",
    gm: "data:image/webp;base64,UklGRsgFAABXRUJQVlA4WAoAAAAQAAAAfwAAfwAAQUxQSBUAAAABIJO2qX/TU7A7ETEB7Xz8x3/8R3AAVlA4IIwFAACQIACdASqAAIAAPlEgjEQjoiGUjHekOAUEoG9GOtNsfJG7neKv5dlE3K/+b+6rtAeYB+jH+Z6hvmM/ZH9sfeu9GXoAf2T+3dYf6AH7GemN+4/wgftT+5ntaZirao57cZi3tvWWReJPTATTPJvSR9fXKjspjW5Kdy8PUHMQiKiqV+z9tkVwD6myZMZvNJw5CIVwcX4wO08FkN30X8gKvdhSfP6kvvZSuoVaX/913VD21bRHzeDr5uct7lUY5ZFCCZut2Vo85lZ2zn3oJ303Peb9icAzfKnGSzJAnsX23dWy3p4IeOfZAZLRYFB3a2KCqoxO+aC3x6IWnoBv5DNPJTncIjHWisEsiGZu+8pXgAD++VORtWfiP/z53H8uR6788zpfbSbDgcK7YGB7n9hQEd5nle11mvLqef/f6Kv/MBDWWGNUl4GN1dISwBJ135M9Ml8tpP2/0opCNefMFW5r4Fbt+/oEI/U+6xpnG0X3rKKLI5L58cXhzRBE1OM6BgM/qqLYb+D8raV2dFW77NT1KrqD788+oqG5UAShkU/BmBwdafduStnLUUksK1YM7qlRG7au/qjNwvcnFBzOP6fY1xjX0SQSc3fMrwEn1/IdSGxHWtl/0OU17VMj8XBweGI/KpbmLI6g7vTV9C4lcidRLn7vj+CQcz/sS/J0/8CNSzk/PX1KUdNNcLM04Bhro7yD4n6b0P8SGeuqfnaFxnHTY67JNwI1E4/ewx7XfP6TokDC+fVc95s6Q2lAUAAQwX/W0OaqyXqAbCvuohXxIaZvlSyR3t1l5SD7B87y9lgwkgNPQ7EabwcrDL/DPe7w3zp6OFWfs1yNPhMJb1QQ/i5Bfsmad2mZtUMLYDzvxBajOZ5dDBK9CkXSdr4zOAqxLTj8yghWOkzQMWxdBX8e3Nfg1R90374TDgxdR4zyU5UzAqebRSB2yF38VevyaZlxZUPSy9eDpnwcrJgTq827er78k3wRN9PPdXNTtjtsck78PYyWABM+CG+INBLwtjKneKDSU/QWgWLNBKq8tupNgEftKAWqMew9EA9n44iTjCTVFl6i8zWIAIX5Z8U41Ks6r1vPEMqChw9iOO0UkRJn+CZpwFKr60ky7lTsjCv5bT/y1Qg0c68QvDdGY14IVNm9QdBUS+3meA4Knzcm8KQD89+UUJdrGpt1ehvZEvrXRL5Pq+MPZT0PKBZw3QcacwEv1Fccp2B0d7cFrMS7dUk+kk6dfwsjokd5GLiDzZ2c1aUSbeHP0NbAOEpCQE+slkP+GdsXB17q9aEs4vRgJKtzprOiX+e+U9JLP8fgpB90fX6Vehdaw9pf/6k4SH72fCsXh6X1Rcl4DNEdVbONvmHWs5xIXcjYtqovb/kNdLE6L1337xedKXy0oiBk9CZaAOV5CZZ0JqcKfTg++6geB+lnwF056tqAGWav56DhEObBMD9qsRzAe0OSDBokWgyYMEIWcIAqUqlJvLSntGi02+OuBrtOl0XzVvJpL/i0xU63Kge/mndJOnvVzBS8nAFXXpP21Yps4x/keyt0ZCtctiTItijSNMxHhFlyEjf80FEmYB5e8Ng9PM6E7xww5mpJRnBNCC/Q9oKhrhkH+dSlNmmxwGh5w+p8XqhYEJIm3U8aWF6GcHmcUqOIxLO5gGhXol9Z2rXXxBXrOuv9F878/OABHqawZ1Cd9aAK2LIaRk5UIksjIqr0skOP1FZphC1ykTqYq8B/fIR9b1b1Gr2OEDM8m69nyLrvgWbXJ6mrJGHpr9y6SdekgiXzDc684hxjCwZoXtRjsSW+bs5ZKoO48whhnNoCqRfKs3/TqmVHCG2LtZb5tn5rutLJrdG+CBste5TtH12g/9WL/KH57f/i8c9wXU9hJ8ypGXI4A6JV01SsYAAA",
    tg: "data:image/webp;base64,UklGRkYJAABXRUJQVlA4WAoAAAAQAAAAfwAAfwAAQUxQSBYAAAABDzD/ERFCTEPoX1oBry2i/0nOvZIDVlA4IAoJAADwKwCdASqAAIAAPlEgjkSjoiEVSSaAOAUEtABlOxB/ivyA707FPRvxq/L7pvd4+/n4+fEnSOvD/0v/nfdz2i/uW9wD9MP8z1HfMB+sX7Je7v6Cf7v6gH90/6nWK/uH7AH7Femj+73wc/2T/d/uD7Rv/46wD//8Sl/ee1r/Jcsoff/qfMT/IeFu1r/nd8hAB9Rf9P3R3ovpZcZvn7/9P5M+w/6k9GnreHtO1nxdH/foIdKX/hygfXDxPZmeRjd28kUbjinQPT6mBDORRO2a5dSUvq3CwNppGcv34FJPykP3L9PvQw7JepcKpqU8mSBLEkKgH2//oSJ75uwu7pYuVOcuQZLchOXEel8pZKjDvX7EeXadw/EJYXIYQY00ZbfpbVwl9JFf29A7sdF0CS+5em/6sGolCQw9WAnnpRNZ1DpUWkXIoBYOtZfWsaS/2mBSEIldu/gB9MUsvqhklemtFyuEkgOcnCS8P4AA9Tp6209gt9CT5q9G26u2W5/Ws4gYGqqyY9uvgCxyTOX8snit0V1DmyIaxzmEAUKRFKP7JxFdkYh5L8GtUXgwNTQZSXra5yatjoTOu7gJErjzTegAqP7vtmU7bo9Y/EKvKgh1zBiU8w2TLOWGjxt0NZtkYc+XGyNRD5AP9O2GuyTDRgBcg2iZ/V7xFfp1ZLfkn2w6MFrX5k8elT5p799T5MfgK0SkLM2nx3WulHxZCxrZGbhihIjngF4ZqlFWMTvfNMGkcVHsZfIkPw3qh14qo9eLV/UaIbO394NenBDV4tGOIvWB/PIltmWdDbFFUcaEXnll0Ptzj7NO35COK65lrvBI0sQWfdqAAlN/cEYnlwFqRpUJ9eubf9Mk8oQADu3crRjLfdKRIeL2teD+EVrLHI4xiYNOgZ0PI/LGhEfQeDI490HjOnTa/T0aqHcXMm3WPBB8VmEoE7GMuxPAqaWCoE1OZNo/22k3eDzKf8U4GLtCj5/CtpoyE3WbEKZvLcwZm1QdfLxbHNJ82+ibICCDIxPN3G7mBwfXtVYQyzzoZdi1lPRZPXuZXAvsCrMOWkg7J44W+uC4uCmvoWS1xvNEcdZxIk7ydMfur1BvnLZjMjsZxuukAcW2w/jFBlM3uay0qqhafHFAeoS1Okkgm4HdU6L1eW6W3/j8VtGRe2Zp8qNRrvBH3lLZJh9z3p7+jHArek4YyZcHgKj2DD70fnnYnG1rgtuOx8oEaYxcZD9kaBQ2TfC03RoVisKLm+9G+B3AOFwAyPKyv+gSmOy+f04P+Y1ob2LnHWjLdKvHrsZfx15kKP3wZ9p/Ee2RojVplLEC6TkswrwTDS35bjdqxdUddP+uPNHjarp4OeU1mnUUzWcfETu7GnqBdxcMZ9SrS2iEdhJdvUHcFzlBck/5NdY/uDnB3r9/9a2kY53Ue1oi7SCeXBcPXAyCBTdQCbzR2Oko8j4fHFZihMiIcWRMGt/3ZHEmc8oYgZ5XQ+S633s9vKZyrEkzX6ChlZ9pcd4mZ21bYwtZpQrmokFpVkHNK+fnKB9pe7W85umB7xosd6bq7c+2px9aAhV+oT33KpjXGdGhesSvACmLkSBj/6vd4ADpHOu2CvdRmXfxw8+8UpN9weallM9ahW9sD51xGU0X3anhZuerUMhB2Xf1eIvqs79sol6hx3Ohe9rtTWhJBUDzqyqxnsP6ghSkhaf/6+2E46ufIh9zZiFXTzHhXgc1jxnr/4pQd/yQArW8/nAxy/G837dn8osuqwrbRfhsQz69rd9Gz3dty7af9BOciOh66kDPldQlChlZevsAhVP4NVYDvCvaXgkg/ydXtMLpQR3gqs38x7/VtWF2uJAJ5Ax+9MoKRklSOB0lFjWmp01nYAIrtcWlABVgFIRBgJZ+O2kuOhuK1pS+KALVPbhGH8gVMEeSwdxKMkIPNsYIHHdA76pDI4XYYpikd/pnB+OVpe9fST4igiPHwiJmHjZkgPljG1VcYiX4gkWMt6F/v2HdvH9zjMEfGzec3claWE6jonJWltXKHGnm8pxN/v/nlKka3CBSEk6ieajkTT4YkJZXlNa/uzWDzizOVDhdtd/CD7A13u4/cSvALRGru/otSirg8Lm9EYdoAQbl2wXhCNI1kpQ1uh8LHhSe0LBd6mh5kUKcBy4VJfPIfYJOeGM6kc/nCcH15mrw2yL2V+upMJz1/N/VYCIo3Dbm7ZKxSS3el6EdpTPwDV2KOpV2MIJsPXz/N4GjFSR+1HIFGTuQ6zEbvAZCSBlb/TabUmyBGxWc9XhYmXFqzzCwgn+RLM19AmvKXihfJabOPNgxSqzxO/CXehn+Qo4mwMUvxmvWVn/9+MyGt6GI9GJvwHFNreySsSynWH0wHAfqUCtH2mIZbVQqUn/+oD61cfVcMcwJaZJG7NLaenVN/yid/4ALh5sNVn4mrkCD+kxY7J7SfGEF1F00Ly3F0K4vz6qXnFOw2BlWnc3W+zJg7/ulTnY1QilEcoVa0ZxSQnse3RmnwN0DJ9j035kzbJWwKkSPVI3dz+MKPgI/ZXA0kclhUR7L7OV1RFKn10ZubDvX0UO3rMcs4jZjtX+sZOTA+N6Jgtj8TudtpkvjQSsYUNnp0pbOmp4pzvvW0x5U08qJEweaZKiK1mXuq3Q0L2hZ24GlXa6xVTeO8mdSGhbae3K5msRtiD8aP9D0kY7UNzNOSfzLzfqQ7kDxLWLlsQd17C9poVLrhTQZyHEKblWv2CQWgH5pf44VO2G+yv6nY1Pm2Hhar7+zX7hzjQQ1FSJYg2vD2cIDEdc1TfOiHjzHKn/rj4sozw31WiHkah6nkzC9x4xz/y/6glW2/8dZUL8AUpr8oM5XBqcS/4hOAWUgXuf+7xNLawtQ/KhYAtObnulrHpZznexpdflaG/z8bbPCgfBYka7QLIf834xNAo5Y/P7MVs+9cwLwMQXden3JUVrv3+iZHMiHWwHFrIAX06B8u71Pq3G7NeV8v0zPG8kkvWRtVRjzKH5EL8wQYFHd71nuT9Zr0qesIxs8/HCgRL+h9wbwrLXMA18JCJsuMTdYnRgQwkYrr9CmuDiyfLfWg6RAI/E1GYNMxgfzni+AAAAA",
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
      const prog = total > 0 ? Math.round(((total - left) / total) * 100) : 0;

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
                <div style="font-size:12px; color:var(--text-dim);">${taskTypeLabel(t)} • осталось ${left}/${total}</div>
              </div>
            </div>
            <div class="xp-track" style="height:8px;"><div class="xp-fill" style="width:${clamp(prog, 0, 100)}%"></div></div>
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
