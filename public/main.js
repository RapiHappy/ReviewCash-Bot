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
  function tgAlert(msg, kind) {
    const raw = String(msg ?? "");
    const pretty = prettyErrorMessage(raw);
    const k = kind || guessKind(pretty);

    // Prefer in-app toast (nicer than Telegram default alert)
    const stack = getToastStack();
    if (stack) {
      showToast(pretty, k);
      return;
    }

    try {
      if (tg && tg.showAlert) return tg.showAlert(pretty);
    } catch (e) {}
    alert(pretty);
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
  // UI helpers: toasts + loader + better errors
  // --------------------
  function getToastStack() {
    return document.getElementById("toast-stack");
  }

  function guessKind(msg) {
    const s = String(msg || "");
    if (/^\d{3}\s*:/i.test(s)) return "error";
    if (/\b(ошибка|error|не удалось|лимит|запрещено|отклон|нельзя)\b/i.test(s)) return "error";
    if (/✅|готово|успеш|выполнен|создан/i.test(s)) return "success";
    return "info";
  }

  function prettyErrorMessage(s) {
    const m = String(s || "").trim();
    // Strip internal (POST /path) tail
    const m1 = m.replace(/\s*\(POST\s+[^)]+\)\s*$/i, "");
    // Convert "400: ..." -> "..."
    const m2 = m1.replace(/^\d{3}\s*:\s*/i, "");
    return m2 || m || "Ошибка";
  }

  function showToast(msg, kind = "info", ttl = 3800) {
    const stack = getToastStack();
    if (!stack) return;
    stack.style.display = "flex";

    const el = document.createElement("div");
    el.className = "rc-toast rc-" + (kind || "info");

    const ico = document.createElement("div");
    ico.className = "rc-ico";
    ico.textContent = (kind === "success") ? "✓" : (kind === "error" ? "!" : "i");

    const text = document.createElement("div");
    text.className = "rc-msg";
    text.textContent = String(msg || "");

    const x = document.createElement("button");
    x.className = "rc-x";
    x.type = "button";
    x.textContent = "×";
    x.addEventListener("click", () => removeToast(el));

    el.appendChild(ico);
    el.appendChild(text);
    el.appendChild(x);
    stack.appendChild(el);

    requestAnimationFrame(() => el.classList.add("rc-in"));

    let t = null;
    if (ttl && ttl > 0) {
      t = setTimeout(() => removeToast(el), ttl);
    }

    function removeToast(node) {
      try { if (t) clearTimeout(t); } catch (e) {}
      if (!node || !node.parentNode) return;
      node.classList.remove("rc-in");
      setTimeout(() => {
        try { node.remove(); } catch (e) {}
        // hide stack when empty
        try { if (stack.children.length === 0) stack.style.display = "none"; } catch (e2) {}
      }, 240);
    }
  }

  function showLoader(text = "Загрузка…", sub = "") {
    const l = document.getElementById("loader");
    if (!l) return;
    const t = document.getElementById("loader-text");
    const s = document.getElementById("loader-sub");
    if (t) t.textContent = String(text || "Загрузка…");
    if (s) s.textContent = String(sub || "");
    l.style.display = "flex";
  }

  function hideLoader() {
    const l = document.getElementById("loader");
    if (l) l.style.display = "none";
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
    currentTask: null,
    isAdmin: false,
    adminCounts: { proofs: 0, withdrawals: 0, tbank: 0 },
    tbankCode: "",
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
    const res = await fetch(url, {
      method: "POST",
      headers: apiHeaders(true),
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) ? (data.error || data.message) : text || (res.status + " " + res.statusText);
      throw new Error(`${res.status}: ${msg} (POST ${path})`);
    }
    return data;
  }

  async function apiPostForm(path, formData) {
    const url = state.api + path;
    const res = await fetch(url, {
      method: "POST",
      headers: apiHeaders(false),
      body: formData,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) ? (data.error || data.message) : text || (res.status + " " + res.statusText);
      throw new Error(`${res.status}: ${msg} (POST ${path})`);
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
    const secs = qsa(".app-container > section");
    secs.forEach(sec => { sec.classList.remove("rc-active"); sec.classList.add("hidden"); });

    const el = $("view-" + id);
    if (el) {
      el.classList.remove("hidden");
      // trigger transition
      requestAnimationFrame(() => {
        try { el.classList.add("rc-active"); } catch (e) {}
      });
    }
    try { setActiveTab(id); } catch (e) {}
  }

  function openOverlay(id) {
    const el = $(id);
    if (!el) return;
    el.style.display = "flex";
    document.body.style.overflow = "hidden";
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
      if (pic) ha.src = pic;
      ha.onerror = () => { ha.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="; };
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
      if (pic) upic.src = pic;
      upic.onerror = () => { upic.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="; };
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
  function setFilter(f) {
    state.filter = f === "my" ? "my" : "all";
    const fa = $("f-all"), fm = $("f-my");
    if (fa) fa.classList.toggle("active", state.filter === "all");
    if (fm) fm.classList.toggle("active", state.filter === "my");
    renderTasks();
  }
  window.setFilter = setFilter;
  const BRAND_SVGS = {
    ya: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="56" height="56" rx="14" fill="#FFCC00"/><path d="M32 14c-8.5 0-15.5 7-15.5 15.5C16.5 41.2 32 54 32 54s15.5-12.8 15.5-24.5C47.5 21 40.5 14 32 14z" fill="#D61E3B"/><circle cx="32" cy="29.5" r="6.3" fill="#111827"/></svg>`,
    gm: `<svg xmlns="http://www.w3.org/2000/svg" aria-label="Google" role="img" viewBox="0 0 512 512"><rect width="512" height="512" rx="15%" fill="#fff"/><path fill="#4285f4" d="M386 400c45-42 65-112 53-179H260v74h102c-4 24-18 44-38 57z"/><path fill="#34a853" d="M90 341a192 192 0 0 0 296 59l-62-48c-53 35-141 22-171-60z"/><path fill="#fbbc02" d="M153 292c-8-25-8-48 0-73l-63-49c-23 46-30 111 0 171z"/><path fill="#ea4335" d="M153 219c22-69 116-109 179-50l55-54c-78-75-230-72-297 55z"/></svg>`,
    tg: `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="15.5" fill="#229ED9"/><path fill="#fff" d="M29.919 6.163l-4.225 19.925c-.319 1.406-1.15 1.756-2.331 1.094l-6.438-4.744-3.106 2.988c-.344.344-.631.631-1.294.631l.463-6.556 11.931-10.781c.519-.462-.113-.719-.806-.256l-14.75 9.288-6.35-1.988c-1.381-.431-1.406-1.381.288-2.044l24.837-9.569c1.15-.431 2.156.256 1.781 2.013z"/></svg>`,
  };

  function brandIconHtml(task) {
    const t = String((task && (task.type || task.platform)) || "").toLowerCase();
    const svg = (t === "ya") ? BRAND_SVGS.ya : (t === "gm") ? BRAND_SVGS.gm : BRAND_SVGS.tg;
    return `<span class=\"brand-ico\" aria-hidden=\"true\">${svg}</span>`;
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

    if (state.filter === "my" && uid) {
      list = list.filter(t => Number(t.owner_id) === Number(uid));
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
              <div class="brand-box" style="width:38px; height:38px; font-size:18px;">${brandIconHtml(t)}</div>
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
    $("td-icon").innerHTML = brandIconHtml(task);
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

    if (!nick) return tgAlert("Укажи никнейм (как в сервисе)");

    // REQUIRED IMAGE (you asked)
    if (!file) return tgAlert("Прикрепи скриншот доказательства (обязательно)");

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

    if (!target) return tgAlert("Укажи ссылку");
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

      tgChat = parseTgChatFromUrl(target);
      checkType = tgChat ? "auto" : "manual";
      tgKind = "member_check";
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
        state.adminCounts = res.counts || state.adminCounts;
        renderAdminBadge();
        const apc = $("admin-panel-card");
        if (apc) apc.style.display = "block";
      } else {
        state.isAdmin = false;
        const apc2 = $("admin-panel-card");
        if (apc2) apc2.style.display = "none";
      }
    } catch (e) {
      state.isAdmin = false;
      const c = $("admin-panel-card");
      if (c) c.style.display = "none";
    }
  }

  function renderAdminBadge() {
    const b = $("admin-badge");
    if (!b) return;
    const n = (Number(state.adminCounts.proofs || 0) + Number(state.adminCounts.withdrawals || 0) + Number(state.adminCounts.tbank || 0));
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
    if (avp) avp.classList.toggle("hidden", tab !== "proofs");
    if (avw) avw.classList.toggle("hidden", tab !== "withdrawals");
    if (avt) avt.classList.toggle("hidden", tab !== "tbank");

    if (tab === "proofs") await loadAdminProofs();
    if (tab === "withdrawals") await loadAdminWithdrawals();
    if (tab === "tbank") await loadAdminTbank();
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
          <div class="brand-box" style="width:46px; height:46px; font-size:22px;">${brandIconHtml(t)}</div>
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
    // keep loader visible until first successful sync/render
    showLoader("Загрузка…", "Подключаемся");

    // initial tab
    showTab("tasks");
    setFilter("all");
    recalc();

    try {
      await syncAll();
      hideLoader();
    } catch (e) {
      hideLoader();
      tgAlert(String(e.message || e));
    }
  }

  document.addEventListener("DOMContentLoaded", bootstrap);

  // Expose some globals required by HTML
  window.showTab = showTab;
  window.copyInviteLink = window.copyInviteLink;
  window.shareInvite = window.shareInvite;
  window.openAdminPanel = window.openAdminPanel;
})();
