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
  function tgAlert(msg) {
    try {
      if (tg && tg.showAlert) return tg.showAlert(String(msg));
    } catch (e) {}
    alert(String(msg));
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
  // Brand icons (original PNG, embedded = instant)
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
    const src = BRAND_ICON_URI[key] || BRAND_ICON_URI.tg;
    const alt = (key === "ya") ? "Yandex" : (key === "gm") ? "Google" : "Telegram";
    const s = Number(sizePx) || 38;
    return `<img class="brand-img" src="${src}" alt="${alt}" width="${s}" height="${s}" loading="eager" decoding="async">`;
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
    initPlatformFilterIcons();

    // hide loader quickly
    const loader = $("loader");
    if (loader) loader.style.display = "none";

    // initial tab
    showTab("tasks");
    setFilter("all");
    setPlatformFilter(state.platformFilter);
    recalc();

    try {
      await syncAll();
    } catch (e) {
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
