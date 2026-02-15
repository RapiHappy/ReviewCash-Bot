/* ReviewCash MiniApp — FULL stable main.js
   Works with:
   - /api/sync
   - /api/task/create
   - /api/task/submit
   - /api/tbank/claim
   - /api/pay/stars/link   ✅ (openInvoice)
   - /api/withdraw/create, /api/withdraw/list
   - /api/ops/list
   - /api/admin/summary, /api/admin/proof/*, /api/admin/withdraw/*, /api/admin/tbank/*
*/

(function () {
  "use strict";

  // -----------------------------
  // Telegram / fallback
  // -----------------------------
  var MockTelegram = {
    WebApp: {
      expand: function () {},
      setHeaderColor: function () {},
      showAlert: function (msg) { alert(msg); },
      showConfirm: function (msg, cb) { var r = confirm(msg); if (cb) cb(r); },
      openTelegramLink: function (url) { window.open(url, "_blank"); },
      openInvoice: function (_url, cb) { if (cb) cb("failed"); },
      sendData: function (data) { alert("DEV MODE: sendData\n\n" + data); },
      ready: function () {},
      initData: "",
      initDataUnsafe: { user: { id: 123456, username: "dev_user", first_name: "Dev", last_name: "Mode" } }
    }
  };

  var tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : MockTelegram.WebApp;

  function tgAlert(msg) {
    try { tg.showAlert(String(msg)); } catch (e) { alert(String(msg)); }
  }
  function tgConfirm(msg, cb) {
    try { tg.showConfirm(String(msg), cb); } catch (e) { cb(confirm(String(msg))); }
  }
  function tgOpen(url) {
    try { tg.openTelegramLink(url); } catch (e) { window.open(url, "_blank"); }
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function isTelegramWebApp() {
    try {
      return !!(window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.initData === "string" && window.Telegram.WebApp.initData.length > 0);
    } catch (e) {
      return false;
    }
  }

  function getTgUser() {
    try {
      if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) return tg.initDataUnsafe.user;
    } catch (e) {}
    return MockTelegram.WebApp.initDataUnsafe.user;
  }

  function tgInitData() {
    try {
      return (window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.initData === "string")
        ? window.Telegram.WebApp.initData
        : "";
    } catch (e) {
      return "";
    }
  }

  // -----------------------------
  // DOM helpers
  // -----------------------------
  function el(id) { return document.getElementById(id); }
  function addClass(node, c) { if (node && node.classList) node.classList.add(c); }
  function rmClass(node, c) { if (node && node.classList) node.classList.remove(c); }
  function setHidden(node, hidden) { if (node) node.classList.toggle("hidden", !!hidden); }

  // -----------------------------
  // API base
  // -----------------------------
  function getApiBase() {
    var meta = document.querySelector('meta[name="api-base"]');
    var v = meta ? meta.getAttribute("content") : "";
    v = (v || "").trim().replace(/\/+$/, "");
    if (v) return v;
    return window.location.origin.replace(/\/+$/, "");
  }
  var API = getApiBase();

  function getDeviceHash() {
    var v = "";
    try { v = localStorage.getItem("device_hash"); } catch (e) {}
    if (!v) {
      v = "dev_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
      try { localStorage.setItem("device_hash", v); } catch (e2) {}
    }
    return v;
  }

  async function apiPost(path, data) {
    var res = await fetch(API + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tg-InitData": tgInitData()
      },
      body: JSON.stringify(Object.assign({}, data || {}, { device_hash: getDeviceHash() }))
    });

    var text = "";
    try { text = await res.text(); } catch (e) { text = ""; }

    var j = {};
    try { j = text ? JSON.parse(text) : {}; } catch (e2) { j = {}; }

    if (!res.ok || j.ok === false) {
      var msg = (j && j.error) ? j.error : (text && text.length < 200 ? text : ("HTTP " + res.status));
      var err = new Error(msg || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    return j;
  }

  function ensureTelegramOrExplain() {
    if (isTelegramWebApp()) return true;
    tgAlert("Открой Mini App через кнопку WebApp в Telegram у ЭТОГО же бота.\n\nЕсли открыть ссылку напрямую — initData пустой и сервер вернёт 401.");
    return false;
  }

  // -----------------------------
  // Config / task types (Telegram)
  // -----------------------------
  var ASSETS = {
    ya: "https://www.google.com/s2/favicons?sz=64&domain=yandex.ru",
    gm: "https://www.google.com/s2/favicons?sz=64&domain=google.com",
    tg: "https://cdn-icons-png.flaticon.com/512/2111/2111646.png"
  };

  var TG_TASK_TYPES = {
    tg_sub:   { label: "Подписка на канал",   cost: 30,  reward: 15, icon: "📢", action: "Подписаться" },
    tg_group: { label: "Вступление в группу", cost: 25,  reward: 12, icon: "👥", action: "Вступить" },
    tg_react: { label: "Просмотр + Реакция",  cost: 10,  reward: 5,  icon: "❤️", action: "Смотреть пост" },
    tg_poll:  { label: "Участие в опросе",    cost: 15,  reward: 7,  icon: "📊", action: "Голосовать" },
    tg_start: { label: "Запуск бота /start",  cost: 25,  reward: 12, icon: "🤖", action: "Запустить" },
    tg_msg:   { label: "Сообщение боту",      cost: 15,  reward: 7,  icon: "✉️", action: "Написать" },
    tg_mapp:  { label: "Открыть Mini App",    cost: 40,  reward: 20, icon: "📱", action: "Открыть App" },
    tg_hold:  { label: "Подписка + 24ч",      cost: 60,  reward: 30, icon: "⏳", action: "Подписаться" },
    tg_invite:{ label: "Инвайт друзей",       cost: 100, reward: 50, icon: "🤝", action: "Пригласить" }
  };

  // -----------------------------
  // State
  // -----------------------------
  var state = {
    filter: "all",
    is_admin: false,
    admin_counts: { proofs: 0, withdrawals: 0, tbank: 0 },
    user: { rub: 0, stars: 0, xp: 0, level: 1 },
    tasks: [],
    withdrawals: [],
    ops: [],
    admin_proofs: [],
    admin_withdrawals: [],
    admin_tbank: []
  };

  var isLinkValid = false;
  var linkCheckTimer = null;
  var selectedProofFile = null;
  var activeTaskId = null;

  // -----------------------------
  // UI: profile header
  // -----------------------------
  function setupProfileUI() {
    var user = getTgUser();

    var headerAvatar = el("header-avatar");
    var profileAvatar = el("u-pic");
    var headerName = el("header-name");
    var profileName = el("u-name");

    var displayName = "Гость";
    var seed = "G";

    if (user) {
      if (user.username) displayName = "@" + user.username;
      else if (user.first_name || user.last_name) displayName = (user.first_name || "") + " " + (user.last_name || "");
      else displayName = "Пользователь";

      seed = user.first_name || user.username || "U";
    }

    var photoSrc = "";
    if (user && typeof user.photo_url === "string" && user.photo_url.indexOf("http") === 0) {
      photoSrc = user.photo_url;
    } else {
      photoSrc = "https://ui-avatars.com/api/?name=" + encodeURIComponent(seed) + "&background=random&color=fff&size=128&bold=true";
    }

    if (headerName) headerName.innerText = displayName;
    if (profileName) profileName.innerText = displayName;

    function setAvatar(img) {
      if (!img) return;
      img.src = photoSrc;
      img.onerror = function () {
        img.src = "https://ui-avatars.com/api/?name=" + encodeURIComponent(seed) + "&background=random&color=fff&size=128&bold=true";
      };
    }
    setAvatar(headerAvatar);
    setAvatar(profileAvatar);
  }

  function applyAdminUI() {
    var adminPanel = el("admin-panel-card");
    if (!adminPanel) return;
    adminPanel.style.display = state.is_admin ? "block" : "none";

    var badge = el("admin-badge");
    if (badge) {
      var total = (state.admin_counts.proofs || 0) + (state.admin_counts.withdrawals || 0) + (state.admin_counts.tbank || 0);
      badge.style.opacity = total > 0 ? "1" : "0";
      badge.innerText = String(total);
    }
  }

  // -----------------------------
  // Modals
  // -----------------------------
  window.openModal = function (id) {
    var box = el(id);
    if (box) addClass(box, "active");

    if (id === "m-create") {
      var tTarget = el("t-target");
      var tText = el("t-text");
      var tStatus = el("t-target-status");
      if (tTarget) tTarget.value = "";
      if (tText) tText.value = "";
      if (tStatus) { tStatus.className = "input-status"; tStatus.innerHTML = ""; }
      isLinkValid = false;
      window.recalc();
    }

    if (id === "m-withdraw") {
      renderWithdrawals();
    }
  };

  window.closeModal = function () {
    var overlays = document.querySelectorAll(".overlay");
    for (var i = 0; i < overlays.length; i++) rmClass(overlays[i], "active");
  };

  function bindOverlayClose() {
    var overlays = document.querySelectorAll(".overlay");
    for (var i = 0; i < overlays.length; i++) {
      overlays[i].addEventListener("click", function (e) {
        if (e.target === this) window.closeModal();
      });
    }
  }

  // -----------------------------
  // Link validation in create form
  // -----------------------------
  function isValidLink(s) {
    s = (s || "").trim();
    if (!s) return false;
    if (/^https?:\/\/.+\..+/i.test(s)) return true;
    if (/^t\.me\/.+/i.test(s)) return true;
    if (/^@[\w\d_]+$/i.test(s)) return true;
    return false;
  }

  function installLinkWatcher() {
    var targetInput = el("t-target");
    if (!targetInput) return;

    targetInput.addEventListener("input", function () {
      var val = (targetInput.value || "").trim();
      var statusEl = el("t-target-status");

      if (linkCheckTimer) clearTimeout(linkCheckTimer);
      isLinkValid = false;

      if (!val) {
        if (statusEl) { statusEl.className = "input-status"; statusEl.innerHTML = ""; }
        return;
      }

      if (statusEl) {
        statusEl.className = "input-status visible checking";
        statusEl.innerHTML = "⏳ Проверка ссылки...";
      }

      linkCheckTimer = setTimeout(function () {
        var ok = isValidLink(val);
        isLinkValid = ok;
        if (statusEl) {
          statusEl.className = "input-status visible " + (ok ? "valid" : "invalid");
          statusEl.innerHTML = ok ? "✅ Ссылка корректна" : "❌ Некорректная ссылка";
        }
      }, 500);
    });
  }

  // -----------------------------
  // Normalize task
  // -----------------------------
  function normalizeTask(t) {
    var myId = 0;
    try { myId = Number(getTgUser().id || 0); } catch (e) { myId = 0; }

    var ownerId = Number(t.owner_id || t.user_id || 0);
    var owner = (ownerId && myId && ownerId === myId) ? "me" : "other";

    var subType = null;
    try {
      var ins = String(t.instructions || "");
      var m = ins.match(/TG_SUBTYPE:\s*([a-z0-9_]+)/i);
      if (m && m[1]) subType = m[1];
    } catch (e2) {}

    return {
      id: String(t.id),
      type: String(t.type || "tg"),
      subType: subType,
      name: t.title || t.name || "Задание",
      price: Number(t.reward_rub || t.reward || t.price || 0),
      owner: owner,
      checkType: t.check_type || t.checkType || ((t.type === "tg") ? "auto" : "manual"),
      target: t.target_url || t.target || "",
      text: t.instructions || t.text || "",
      qtyLeft: Number(t.qty_left != null ? t.qty_left : 0),
      qty: Number(t.qty_total || t.qty || 1),
      raw: t
    };
  }

  // -----------------------------
  // Data loading
  // -----------------------------
  async function loadData() {
    if (!ensureTelegramOrExplain()) {
      state.tasks = [];
      state.withdrawals = [];
      state.ops = [];
      state.user.rub = 0;
      state.user.stars = 0;
      return;
    }

    var r = await apiPost("/api/sync", {});
    var bal = r.balance || {};

    state.user.rub = Number(bal.rub_balance || 0);
    state.user.stars = Number(bal.stars_balance || 0);
    state.user.xp = Number(bal.xp || 0);
    state.user.level = Number(bal.level || 1);

    var tasks = r.tasks || [];
    state.tasks = tasks.map(normalizeTask);

    try {
      var w = await apiPost("/api/withdraw/list", {});
      state.withdrawals = w.withdrawals || [];
    } catch (e1) {
      state.withdrawals = state.withdrawals || [];
    }

    try {
      var ops = await apiPost("/api/ops/list", {});
      state.ops = ops.operations || [];
    } catch (e2) {
      state.ops = state.ops || [];
    }

    try {
      var s = await apiPost("/api/admin/summary", {});
      if (s && s.ok && s.counts) {
        state.is_admin = true;
        state.admin_counts = s.counts || { proofs: 0, withdrawals: 0, tbank: 0 };
      } else {
        state.is_admin = false;
      }
    } catch (e3) {
      state.is_admin = false;
      state.admin_counts = { proofs: 0, withdrawals: 0, tbank: 0 };
    }
  }

  // -----------------------------
  // Render
  // -----------------------------
  function renderBalance() {
    var br = el("u-bal-rub");
    var bs = el("u-bal-star");
    if (br) br.innerText = Math.floor(state.user.rub).toLocaleString("ru-RU") + " ₽";
    if (bs) bs.innerText = Math.floor(state.user.stars).toLocaleString("ru-RU") + " ⭐";

    var xpPerLevel = 100;
    var currentLevel = Number(state.user.level || 1);
    var nextLevelXP = currentLevel * xpPerLevel;
    var prevLevelXP = (currentLevel - 1) * xpPerLevel;
    var xpInCurrentLevel = Number(state.user.xp || 0) - prevLevelXP;
    var xpNeeded = nextLevelXP - prevLevelXP;
    var pct = xpNeeded > 0 ? Math.max(0, Math.min(100, (xpInCurrentLevel / xpNeeded) * 100)) : 0;

    var lvlBadge = el("u-lvl-badge");
    var xpCur = el("u-xp-cur");
    var xpNext = el("u-xp-next");
    var xpFill = el("u-xp-fill");

    if (lvlBadge) lvlBadge.innerText = "LVL " + currentLevel;
    if (xpCur) xpCur.innerText = String(state.user.xp || 0) + " XP";
    if (xpNext) xpNext.innerText = String(nextLevelXP) + " XP";
    if (xpFill) xpFill.style.width = pct + "%";
  }

  function renderTasks() {
    var box = el("tasks-list");
    if (!box) return;

    box.innerHTML = "";

    if (!ensureTelegramOrExplain()) {
      var warn = document.createElement("div");
      warn.style.textAlign = "center";
      warn.style.padding = "60px 20px";
      warn.style.color = "var(--text-dim)";
      warn.style.opacity = "0.75";
      warn.innerText = "Открой Mini App через Telegram для загрузки задач.";
      box.appendChild(warn);
      return;
    }

    var list = state.tasks.filter(function (t) {
      if (state.filter === "all") return t.owner === "other" && (t.qtyLeft > 0);
      return t.owner === "me";
    });

    if (!list.length) {
      var empty = document.createElement("div");
      empty.style.textAlign = "center";
      empty.style.padding = "60px 20px";
      empty.style.color = "var(--text-dim)";
      empty.style.opacity = "0.6";
      empty.innerHTML =
        '<div style="font-size:48px;margin-bottom:15px;filter:grayscale(1);">📭</div>' +
        '<div style="font-weight:600;">Задач пока нет</div>' +
        '<div style="font-size:12px;margin-top:5px;">Заходите позже или создайте свою</div>';
      box.appendChild(empty);
      return;
    }

    list.forEach(function (t, index) {
      var item = document.createElement("div");
      item.className = "task-item anim-entry";
      item.style.animationDelay = (0.05 * index) + "s";

      var left = document.createElement("div");
      left.style.display = "flex";
      left.style.alignItems = "center";

      var brand = document.createElement("div");
      brand.className = "brand-box";

      if (t.type === "tg" && t.subType && TG_TASK_TYPES[t.subType]) {
        brand.innerHTML = '<div style="font-size:24px;">' + TG_TASK_TYPES[t.subType].icon + "</div>";
      } else if (ASSETS[t.type]) {
        brand.innerHTML = '<img src="' + ASSETS[t.type] + '" style="width:100%;height:100%;object-fit:contain;">';
      } else {
        brand.innerHTML = '<div style="font-size:24px;">📄</div>';
      }

      var meta = document.createElement("div");
      meta.style.marginLeft = "15px";

      var title = document.createElement("div");
      title.style.fontWeight = "700";
      title.innerText = t.name;

      var price = document.createElement("div");
      price.style.color = "var(--accent-cyan)";
      price.style.fontWeight = "800";
      price.style.fontSize = "14px";
      price.innerText = "+" + t.price + " ₽";

      var sub = document.createElement("div");
      sub.style.fontSize = "11px";
      sub.style.color = "var(--text-dim)";
      sub.style.marginTop = "2px";
      sub.innerText = (t.owner === "me") ? ("Осталось: " + t.qtyLeft + "/" + t.qty) : ("Осталось: " + t.qtyLeft);

      meta.appendChild(title);
      meta.appendChild(price);
      meta.appendChild(sub);

      left.appendChild(brand);
      left.appendChild(meta);

      var btn = document.createElement("button");
      btn.className = "btn btn-action";
      btn.innerText = (t.owner === "me") ? "Моё" : "Выполнить";
      btn.onclick = function () {
        window.handleTask(btn, t.owner, t.id);
      };

      item.appendChild(left);
      item.appendChild(btn);
      box.appendChild(item);
    });
  }

  function fmtDate(v) {
    if (!v) return "";
    try {
      var d = new Date(v);
      if (isNaN(d.getTime())) return String(v);
      return d.toLocaleString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return String(v);
    }
  }

  function providerTitle(p) {
    if (!p) return "Пополнение";
    if (p === "tbank") return "Пополнение (T-Bank)";
    if (p === "stars") return "Пополнение (Stars)";
    if (p === "cryptobot") return "Пополнение (CryptoBot)";
    return "Пополнение";
  }

  function renderHistory() {
    var list = el("history-list");
    if (!list) return;

    list.innerHTML = "";

    var items = Array.isArray(state.ops) ? state.ops : [];
    if (!items.length) {
      list.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-dim);">История пуста</div>';
      return;
    }

    items.forEach(function (item) {
      var kind = item.kind;
      var status = String(item.status || "pending");
      var amount = Number(item.amount_rub || 0);
      var dateText = fmtDate(item.created_at);

      var icon = "🧾";
      var title = "Операция";
      var sign = "";
      var colorClass = "";

      if (kind === "payment") {
        title = providerTitle(item.provider);
        sign = "+";
        colorClass = (status === "paid") ? "amt-green" : "";
        icon = (status === "paid") ? "✅" : (status === "rejected" || status === "failed") ? "❌" : "⏳";
      } else if (kind === "withdrawal") {
        title = "Вывод средств";
        sign = "-";
        colorClass = "amt-red";
        icon = (status === "paid") ? "✅" : (status === "rejected") ? "❌" : "⏳";
      }

      var statusText = (status === "paid") ? "Выполнено" : (status === "rejected" || status === "failed") ? "Отклонено" : "Ожидает";

      var row = document.createElement("div");
      row.className = "list-item";
      row.innerHTML =
        '<div class="list-icon">' + icon + "</div>" +
        '<div class="list-meta">' +
          '<div class="list-title">' + title + ' <span style="font-size:11px; color:var(--text-dim);">• ' + statusText + "</span></div>" +
          '<div class="list-date">' + dateText + "</div>" +
        "</div>" +
        '<div class="list-amount ' + colorClass + '">' + sign + amount.toFixed(0) + " ₽</div>";

      list.appendChild(row);
    });
  }

  function renderWithdrawals() {
    var list = el("withdrawals-list");
    if (!list) return;

    list.innerHTML = "";
    var items = Array.isArray(state.withdrawals) ? state.withdrawals : [];

    if (!items.length) {
      list.innerHTML = '<div style="font-size:12px; color:var(--text-dim); text-align:center;">Нет активных заявок</div>';
      return;
    }

    items.forEach(function (w) {
      var amount = Number((w.amount_rub != null) ? w.amount_rub : 0);
      var created = w.created_at || "";
      var status = String(w.status || "pending");

      var stClass = "st-pending";
      var stText = "Ожидание";
      if (status === "paid") { stClass = "st-paid"; stText = "Выплачено"; }
      if (status === "rejected") { stClass = "st-rejected"; stText = "Отклонено"; }

      var div = document.createElement("div");
      div.style.background = "var(--glass)";
      div.style.padding = "10px";
      div.style.borderRadius = "12px";
      div.style.display = "flex";
      div.style.justifyContent = "space-between";
      div.style.alignItems = "center";

      div.innerHTML =
        '<div>' +
          '<div style="font-weight:700; font-size:13px;">' + amount.toFixed(0) + " ₽</div>" +
          '<div style="font-size:10px; color:var(--text-dim);">' + fmtDate(created) + "</div>" +
        "</div>" +
        '<div class="status-badge ' + stClass + '">' + stText + "</div>";

      list.appendChild(div);
    });
  }

  function renderReferrals() {
    var u = getTgUser();
    var uid = (u && u.id) ? u.id : "0";
    var invite = "t.me/ReviewCashBot?start=" + uid;

    var linkEl = el("invite-link");
    if (linkEl) linkEl.innerText = invite;

    if (el("ref-count")) el("ref-count").innerText = "0";
    if (el("ref-earn")) el("ref-earn").innerText = "0 ₽";
  }

  function render() {
    renderBalance();
    renderTasks();
    renderReferrals();
    applyAdminUI();
  }

  // -----------------------------
  // Navigation
  // -----------------------------
  window.showTab = function (t) {
    var tabs = ["tasks", "friends", "profile"];
    for (var i = 0; i < tabs.length; i++) {
      var id = "tab-" + tabs[i];
      var btn = el(id);
      if (btn) btn.classList.toggle("active", tabs[i] === t);
    }

    setHidden(el("view-tasks"), t !== "tasks");
    setHidden(el("view-friends"), t !== "friends");
    setHidden(el("view-profile"), t !== "profile");
    addClass(el("view-history"), "hidden");
  };

  window.showHistory = async function () {
    addClass(el("view-tasks"), "hidden");
    addClass(el("view-friends"), "hidden");
    addClass(el("view-profile"), "hidden");
    rmClass(el("view-history"), "hidden");

    if (ensureTelegramOrExplain()) {
      try {
        var ops = await apiPost("/api/ops/list", {});
        state.ops = ops.operations || [];
      } catch (e) {}
    }
    renderHistory();
  };

  window.closeHistory = function () {
    addClass(el("view-history"), "hidden");
    rmClass(el("view-profile"), "hidden");
    var tabProfile = el("tab-profile");
    if (tabProfile) addClass(tabProfile, "active");
  };

  // -----------------------------
  // Filters
  // -----------------------------
  window.setFilter = function (f) {
    state.filter = f;
    var a = el("f-all");
    var m = el("f-my");
    if (a) a.classList.toggle("active", f === "all");
    if (m) m.classList.toggle("active", f === "my");
    renderTasks();
  };

  // -----------------------------
  // Create task
  // -----------------------------
  function populateTgTypes() {
    var sel = el("t-tg-subtype");
    if (!sel) return;
    sel.innerHTML = "";
    Object.keys(TG_TASK_TYPES).forEach(function (k) {
      var t = TG_TASK_TYPES[k];
      var opt = document.createElement("option");
      opt.value = k;
      opt.textContent = t.icon + " " + t.label + " (" + t.cost + "₽)";
      sel.appendChild(opt);
    });
  }

  window.recalc = function () {
    var typeSelect = el("t-type");
    var subtypeSelect = el("t-tg-subtype");
    var subtypeWrapper = el("tg-subtype-wrapper");
    var tgOptions = el("tg-options");
    if (!typeSelect) return;

    var typeVal = typeSelect.value;
    var pricePerItem = 0;

    if (typeVal === "tg") {
      if (subtypeWrapper) rmClass(subtypeWrapper, "hidden");
      if (tgOptions) rmClass(tgOptions, "hidden");
      var stKey = subtypeSelect ? subtypeSelect.value : "tg_sub";
      if (TG_TASK_TYPES[stKey]) pricePerItem = Number(TG_TASK_TYPES[stKey].cost || 0);
    } else {
      if (subtypeWrapper) addClass(subtypeWrapper, "hidden");
      if (tgOptions) addClass(tgOptions, "hidden");
      var opt = typeSelect.selectedOptions && typeSelect.selectedOptions[0];
      pricePerItem = opt ? Number(opt.dataset.p || 0) : 0;
    }

    var q = Number(el("t-qty") ? (el("t-qty").value || 0) : 0);
    var cur = el("t-cur") ? el("t-cur").value : "rub";
    var totalRub = pricePerItem * q;
    var out = el("t-total");
    if (!out) return;

    if (cur === "star") {
      var stars = Math.ceil(totalRub / 1.5);
      out.innerText = stars + " ⭐";
      out.style.color = "var(--accent-gold)";
    } else {
      out.innerText = totalRub + " ₽";
      out.style.color = "var(--accent-cyan)";
    }
  };

  window.createTask = async function () {
    if (!ensureTelegramOrExplain()) return;

    var typeEl = el("t-type");
    var subtypeEl = el("t-tg-subtype");
    var qtyEl = el("t-qty");
    var curEl = el("t-cur");
    var targetEl = el("t-target");
    var textEl = el("t-text");

    var type = typeEl ? typeEl.value : "tg";
    var qty = parseInt(qtyEl ? qtyEl.value : "1", 10);
    var currency = curEl ? curEl.value : "rub";
    var target = (targetEl ? targetEl.value : "").trim();
    var instructions = (textEl ? textEl.value : "").trim();

    if (!qty || qty < 1) return tgAlert("Минимальное количество: 1");
    if (!target) return tgAlert("Укажите ссылку на объект");
    if (!isLinkValid) return tgAlert("Укажите корректную ссылку и дождитесь проверки.");

    if (currency === "star") {
      return tgAlert("Создание заданий за Stars пока выключено.\nStars используются для пополнения баланса.");
    }

    var pricePerItem = 0;
    var workerReward = 0;
    var taskName = "";
    var checkType = "manual";
    var tgChat = null;
    var tgKind = null;
    var subType = null;

    if (type === "tg") {
      var stKey = subtypeEl ? subtypeEl.value : "tg_sub";
      var conf = TG_TASK_TYPES[stKey];
      if (!conf) return tgAlert("Выберите тип TG-задания");
      subType = stKey;

      pricePerItem = Number(conf.cost || 0);
      workerReward = Number(conf.reward || 0);
      taskName = conf.label || "TG задание";
      checkType = "auto";

      tgChat = target.replace(/^https?:\/\/t\.me\//i, "@").replace(/^t\.me\//i, "@");
      tgChat = tgChat.split("/")[0];
      tgKind = (stKey === "tg_group") ? "group" : "channel";
    } else {
      var opt = typeEl && typeEl.selectedOptions ? typeEl.selectedOptions[0] : null;
      pricePerItem = opt ? Number(opt.dataset.p || 0) : 0;
      taskName = (type === "ya") ? "Отзыв Яндекс" : "Отзыв Google";
      checkType = "manual";
      workerReward = Math.floor(pricePerItem * 0.5);
    }

    var costRub = pricePerItem * qty;

    try {
      await apiPost("/api/task/create", {
        type: type,
        title: taskName,
        target_url: target,
        instructions: instructions,
        reward_rub: workerReward,
        cost_rub: costRub,
        qty_total: qty,
        check_type: checkType,
        tg_chat: tgChat,
        tg_kind: tgKind,
        sub_type: subType
      });

      await loadData();
      render();
      window.closeModal();
      window.setFilter("my");
      tgAlert("✅ Задание создано!\nСписано: " + costRub + " ₽");
    } catch (e) {
      tgAlert("Ошибка создания задания: " + (e && e.message ? e.message : "unknown"));
    }
  };

  // -----------------------------
  // Task details / submit
  // -----------------------------
  window.handleTask = async function (_btn, owner, id) {
    if (!ensureTelegramOrExplain()) return;

    id = String(id || "");
    if (owner === "me") {
      return tgAlert("Это твоё задание.\nУдаление/остановка можно добавить отдельным эндпоинтом позже.");
    }

    var task = null;
    for (var i = 0; i < state.tasks.length; i++) {
      if (String(state.tasks[i].id) === id) { task = state.tasks[i]; break; }
    }
    if (!task) return;

    activeTaskId = id;

    if (el("td-title")) el("td-title").innerText = task.name;
    if (el("td-reward")) el("td-reward").innerText = "+" + task.price + " ₽";

    var iconBox = el("td-icon");
    var iconHtml = "";
    if (task.type === "tg" && task.subType && TG_TASK_TYPES[task.subType]) {
      iconHtml = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:32px;">' + TG_TASK_TYPES[task.subType].icon + "</div>";
      if (el("td-type-badge")) el("td-type-badge").innerText = TG_TASK_TYPES[task.subType].label.toUpperCase();
    } else if (ASSETS[task.type]) {
      iconHtml = '<img src="' + ASSETS[task.type] + '" style="width:100%;height:100%;object-fit:contain;">';
      if (el("td-type-badge")) el("td-type-badge").innerText = String(task.type).toUpperCase();
    } else {
      iconHtml = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:32px;">📄</div>';
      if (el("td-type-badge")) el("td-type-badge").innerText = String(task.type).toUpperCase();
    }
    if (iconBox) iconBox.innerHTML = iconHtml;

    if (el("td-link")) el("td-link").innerText = task.target;
    if (el("td-link-btn")) el("td-link-btn").href = task.target;
    if (el("td-text")) el("td-text").innerText = task.text || "Нет дополнительных инструкций";

    var isAuto = (task.checkType === "auto");
    setHidden(el("proof-manual"), isAuto);
    setHidden(el("proof-auto"), !isAuto);

    if (el("p-username")) el("p-username").value = "";
    if (el("p-file")) el("p-file").value = "";
    if (el("p-filename")) { el("p-filename").innerText = "📷 Прикрепить скриншот"; el("p-filename").style.color = "var(--accent-cyan)"; }
    selectedProofFile = null;

    var actionBtn = el("td-action-btn");
    if (actionBtn) {
      actionBtn.disabled = false;
      rmClass(actionBtn, "working");

      if (isAuto) {
        var txt = "⚡ Проверить выполнение";
        if (task.subType && TG_TASK_TYPES[task.subType]) txt = "⚡ Проверить: " + TG_TASK_TYPES[task.subType].action;
        actionBtn.innerText = txt;
        actionBtn.onclick = function () { window.checkTgTask(activeTaskId); };
      } else {
        actionBtn.innerText = "📤 Отправить отчет";
        actionBtn.onclick = function () { window.submitReviewProof(activeTaskId); };
      }
    }

    window.openModal("m-task-details");
  };

  window.checkTgTask = async function (taskId) {
    if (!ensureTelegramOrExplain()) return;

    var btn = el("td-action-btn");
    if (btn) { btn.disabled = true; btn.innerHTML = "⏳ Проверка..."; }

    try {
      await apiPost("/api/task/submit", { task_id: String(taskId) });
      await loadData();
      render();
      window.closeModal();
      tgAlert("✅ Проверка отправлена!\nЕсли бот видит подписку — начисление произойдёт сразу.");
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = "⚡ Проверить выполнение"; }
      tgAlert("Ошибка проверки: " + (e && e.message ? e.message : "unknown"));
    }
  };

  window.submitReviewProof = async function (taskId) {
    if (!ensureTelegramOrExplain()) return;

    var uname = (el("p-username") ? el("p-username").value : "").trim();
    if (!uname) return tgAlert("Укажите ваше имя/никнейм.");

    var btn = el("td-action-btn");
    if (btn) { btn.disabled = true; btn.innerHTML = "⏳ Отправка..."; }

    try {
      await apiPost("/api/task/submit", {
        task_id: String(taskId),
        proof_text: uname,
        proof_url: ""
      });

      await loadData();
      render();
      window.closeModal();
      tgAlert("✅ Отчет отправлен!\nДальше — модерация.");
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = "📤 Отправить отчет"; }
      tgAlert("Ошибка отправки: " + (e && e.message ? e.message : "unknown"));
    }
  };

  window.updateFileName = function (input) {
    try {
      if (input && input.files && input.files[0]) {
        selectedProofFile = input.files[0];
        var name = input.files[0].name || "file";
        var pfn = el("p-filename");
        if (pfn) {
          pfn.innerText = "📄 " + (name.length > 20 ? name.substr(0, 18) + "..." : name);
          pfn.style.color = "var(--text-main)";
        }
      }
    } catch (e) {}
  };

  // -----------------------------
  // Copy helpers
  // -----------------------------
  window.copyLink = function () {
    var url = el("td-link") ? el("td-link").innerText : "";
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { tgAlert("Ссылка скопирована"); });
    } else {
      tgAlert(url);
    }
  };

  window.copyInviteLink = function () {
    var u = getTgUser();
    var uid = (u && u.id) ? u.id : "0";
    var inviteLink = "https://t.me/ReviewCashBot?start=" + uid;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(inviteLink).then(function () { tgAlert("🔗 Ссылка скопирована!"); });
    } else {
      tgAlert(inviteLink);
    }
  };

  window.shareInvite = function () {
    var u = getTgUser();
    var uid = (u && u.id) ? u.id : "0";
    var inviteLink = "https://t.me/ReviewCashBot?start=" + uid;
    tgOpen("https://t.me/share/url?url=" + encodeURIComponent(inviteLink) + "&text=" + encodeURIComponent("Зарабатывай на заданиях вместе со мной!"));
  };

  // -----------------------------
  // Payments: Stars + TBank
  // -----------------------------
  window.processPay = async function (method) {
    var val = Number(el("sum-input") ? (el("sum-input").value || 0) : 0);
    if (!isFinite(val) || val < 300) return tgAlert("Минимальная сумма пополнения — 300 ₽");

    if (method === "pay_stars") {
      if (!ensureTelegramOrExplain()) return;

      // ✅ Новый путь: получаем invoice_link с сервера и открываем через openInvoice
      try {
        var r = await apiPost("/api/pay/stars/link", { amount_rub: val });
        var link = r && r.invoice_link ? String(r.invoice_link) : "";

        if (!link) {
          return tgAlert("Не удалось получить инвойс Stars. Попробуй ещё раз.");
        }

        if (tg && typeof tg.openInvoice === "function") {
          tg.openInvoice(link, async function (status) {
            // status: "paid" | "cancelled" | "failed"
            if (status === "paid") {
              // даём серверу секунду получить successful_payment и обновить баланс
              await sleep(900);
              await loadData();
              render();
              tgAlert("✅ Оплата прошла! Баланс обновлён.");
            } else if (status === "cancelled") {
              tgAlert("Платёж отменён.");
            } else {
              tgAlert("Платёж не выполнен.");
            }
          });
        } else {
          // fallback: старый метод через sendData (инвойс придёт в чат)
          tg.sendData(JSON.stringify({ action: "pay_stars", amount_rub: String(val) }));
          tgAlert("⭐ Инвойс отправлен в чат с ботом. Оплати его там.");
        }
      } catch (e) {
        tgAlert("Ошибка Stars: " + (e && e.message ? e.message : "unknown"));
      }
      return;
    }

    tgAlert("Неизвестный метод оплаты: " + method);
  };

  var tbankAmount = 0;

  window.openTBankPay = function () {
    var val = Number(el("sum-input") ? (el("sum-input").value || 0) : 0);
    if (!isFinite(val) || val < 300) return tgAlert("Минимальная сумма пополнения — 300 ₽");

    tbankAmount = val;
    if (el("tb-amount-display")) el("tb-amount-display").innerText = String(val) + " ₽";

    var u = getTgUser();
    var uId = (u && u.id) ? u.id : "TEST";
    var rand = Math.floor(1000 + Math.random() * 9000);
    var code = "PAY-" + uId + "-" + rand;

    if (el("tb-code")) el("tb-code").innerText = code;

    window.closeModal();
    window.openModal("m-pay-tbank");
  };

  window.copyCode = function () {
    var code = el("tb-code") ? el("tb-code").innerText : "";
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () { tgAlert("Код скопирован!"); });
    } else {
      tgAlert(code);
    }
  };

  window.confirmTBank = async function () {
    if (!ensureTelegramOrExplain()) return;

    var sender = (el("tb-sender") ? el("tb-sender").value : "").trim();
    var code = (el("tb-code") ? el("tb-code").innerText : "").trim();
    if (!sender) return tgAlert("Укажите ваше имя отправителя");
    if (!code) return tgAlert("Нет кода платежа");

    try {
      await apiPost("/api/tbank/claim", { amount_rub: Number(tbankAmount), sender: sender, code: code });
      tgAlert("✅ Заявка на пополнение отправлена.\nАдминистратор подтвердит вручную.");
      window.closeModal();
      await loadData();
      render();
    } catch (e) {
      tgAlert("Ошибка T-Bank: " + (e && e.message ? e.message : "unknown"));
    }
  };

  // -----------------------------
  // Withdrawals
  // -----------------------------
  window.requestWithdraw = async function () {
    if (!ensureTelegramOrExplain()) return;

    var details = (el("w-details") ? el("w-details").value : "").trim();
    var amountStr = (el("w-amount") ? el("w-amount").value : "").trim();

    var amt = Number(amountStr);
    if (!details) return tgAlert("Укажи реквизиты");
    if (!isFinite(amt) || amt <= 0) return tgAlert("Некорректная сумма");
    if (amt < 300) return tgAlert("Минимальная сумма: 300 ₽");

    try {
      await apiPost("/api/withdraw/create", { amount_rub: amt, details: details });
      try {
        var w = await apiPost("/api/withdraw/list", {});
        state.withdrawals = w.withdrawals || [];
      } catch (e2) {}

      await loadData();
      render();
      renderWithdrawals();
      tgAlert("✅ Заявка создана! Ожидайте обработки.");
    } catch (e) {
      tgAlert("Ошибка вывода: " + (e && e.message ? e.message : "unknown"));
    }
  };

  // -----------------------------
  // Admin panel
  // -----------------------------
  window.openAdminPanel = async function () {
    if (!ensureTelegramOrExplain()) return;
    if (!state.is_admin) return tgAlert("Нет прав администратора.");

    await refreshAdminLists();
    window.openModal("m-admin");
  };

  window.switchAdminTab = function (tab) {
    var proofs = el("admin-view-proofs");
    var wds = el("admin-view-withdrawals");
    var tb = el("admin-view-tbank");

    setHidden(proofs, tab !== "proofs");
    setHidden(wds, tab !== "withdrawals");
    setHidden(tb, tab !== "tbank");

    var atP = el("at-proofs");
    var atW = el("at-withdrawals");
    var atT = el("at-tbank");
    if (atP) atP.classList.toggle("active", tab === "proofs");
    if (atW) atW.classList.toggle("active", tab === "withdrawals");
    if (atT) atT.classList.toggle("active", tab === "tbank");
  };

  async function refreshAdminLists() {
    try {
      var s = await apiPost("/api/admin/summary", {});
      state.is_admin = true;
      state.admin_counts = s.counts || { proofs: 0, withdrawals: 0, tbank: 0 };
    } catch (e0) {}

    try {
      var p = await apiPost("/api/admin/proof/list", {});
      state.admin_proofs = p.proofs || [];
    } catch (e1) {
      state.admin_proofs = [];
    }

    try {
      var w = await apiPost("/api/admin/withdraw/list", {});
      state.admin_withdrawals = w.withdrawals || [];
    } catch (e2) {
      state.admin_withdrawals = [];
    }

    try {
      var t = await apiPost("/api/admin/tbank/list", {});
      state.admin_tbank = t.tbank || [];
    } catch (e3) {
      state.admin_tbank = [];
    }

    applyAdminUI();
    renderAdminProofs();
    renderAdminWithdrawals();
    renderAdminTbank();
  }

  function mkAdminCard(title, subtitle, rightHtml) {
    var card = document.createElement("div");
    card.className = "card";
    card.style.padding = "14px";
    card.innerHTML =
      '<div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">' +
        '<div style="flex:1;">' +
          '<div style="font-weight:900; margin-bottom:4px;">' + title + "</div>" +
          '<div style="font-size:12px; color:var(--text-dim); line-height:1.35;">' + subtitle + "</div>" +
        "</div>" +
        '<div style="min-width:110px; text-align:right;">' + (rightHtml || "") + "</div>" +
      "</div>";
    return card;
  }

  function renderAdminProofs() {
    var box = el("admin-list");
    if (!box) return;
    box.innerHTML = "";

    if (!state.admin_proofs.length) {
      box.innerHTML = '<div style="text-align:center; color:var(--text-dim); padding:10px;">Нет отчётов</div>';
      return;
    }

    state.admin_proofs.forEach(function (p) {
      var task = p.task || {};
      var title = "Отчёт #" + p.id;
      var subtitle =
        "Task: " + (task.title || p.task_id) + "<br>" +
        "User: " + p.user_id + "<br>" +
        "Proof: " + (p.proof_text || "—") + "<br>" +
        "Дата: " + fmtDate(p.created_at);

      var right =
        '<button class="btn btn-main" style="padding:8px 10px; font-size:12px; margin-bottom:8px;" data-a="ok">✅ Принять</button>' +
        '<button class="btn btn-secondary" style="padding:8px 10px; font-size:12px;" data-a="no">❌ Отклонить</button>';

      var card = mkAdminCard(title, subtitle, right);

      var btnOk = card.querySelector('button[data-a="ok"]');
      var btnNo = card.querySelector('button[data-a="no"]');

      if (btnOk) btnOk.onclick = function () { adminDecisionProof(p.id, true); };
      if (btnNo) btnNo.onclick = function () { adminDecisionProof(p.id, false); };

      box.appendChild(card);
    });
  }

  async function adminDecisionProof(proofId, approved) {
    if (!ensureTelegramOrExplain()) return;
    try {
      await apiPost("/api/admin/proof/decision", { proof_id: proofId, approved: approved });
      await refreshAdminLists();
      tgAlert("Готово.");
    } catch (e) {
      tgAlert("Ошибка: " + (e && e.message ? e.message : "unknown"));
    }
  }

  function renderAdminWithdrawals() {
    var box = el("admin-withdraw-list");
    if (!box) return;
    box.innerHTML = "";

    if (!state.admin_withdrawals.length) {
      box.innerHTML = '<div style="text-align:center; color:var(--text-dim); padding:10px;">Нет заявок</div>';
      return;
    }

    state.admin_withdrawals.forEach(function (w) {
      var title = "Вывод #" + w.id + " • " + Number(w.amount_rub || 0).toFixed(0) + " ₽";
      var subtitle =
        "User: " + w.user_id + "<br>" +
        "Details: " + (w.details || "—") + "<br>" +
        "Status: " + (w.status || "pending") + "<br>" +
        "Дата: " + fmtDate(w.created_at);

      var right =
        '<button class="btn btn-main" style="padding:8px 10px; font-size:12px; margin-bottom:8px;" data-a="ok">✅ Выплатить</button>' +
        '<button class="btn btn-secondary" style="padding:8px 10px; font-size:12px;" data-a="no">❌ Отклонить</button>';

      var card = mkAdminCard(title, subtitle, right);

      var btnOk = card.querySelector('button[data-a="ok"]');
      var btnNo = card.querySelector('button[data-a="no"]');

      if (btnOk) btnOk.onclick = function () { adminDecisionWithdraw(w.id, true); };
      if (btnNo) btnNo.onclick = function () { adminDecisionWithdraw(w.id, false); };

      box.appendChild(card);
    });
  }

  async function adminDecisionWithdraw(withdrawId, approved) {
    if (!ensureTelegramOrExplain()) return;
    try {
      await apiPost("/api/admin/withdraw/decision", { withdraw_id: withdrawId, approved: approved });
      await refreshAdminLists();
      tgAlert("Готово.");
    } catch (e) {
      tgAlert("Ошибка: " + (e && e.message ? e.message : "unknown"));
    }
  }

  function renderAdminTbank() {
    var box = el("admin-tbank-list");
    if (!box) return;
    box.innerHTML = "";

    if (!state.admin_tbank.length) {
      box.innerHTML = '<div style="text-align:center; color:var(--text-dim); padding:10px;">Нет заявок</div>';
      return;
    }

    state.admin_tbank.forEach(function (p) {
      var title = "T-Bank #" + p.id + " • " + Number(p.amount_rub || 0).toFixed(0) + " ₽";
      var sender = (p.meta && p.meta.sender) ? p.meta.sender : "—";
      var subtitle =
        "User: " + p.user_id + "<br>" +
        "Code: " + (p.provider_ref || "—") + "<br>" +
        "Sender: " + sender + "<br>" +
        "Дата: " + fmtDate(p.created_at);

      var right =
        '<button class="btn btn-main" style="padding:8px 10px; font-size:12px; margin-bottom:8px;" data-a="ok">✅ Зачислить</button>' +
        '<button class="btn btn-secondary" style="padding:8px 10px; font-size:12px;" data-a="no">❌ Отклонить</button>';

      var card = mkAdminCard(title, subtitle, right);

      var btnOk = card.querySelector('button[data-a="ok"]');
      var btnNo = card.querySelector('button[data-a="no"]');

      if (btnOk) btnOk.onclick = function () { adminDecisionTbank(p.id, true); };
      if (btnNo) btnNo.onclick = function () { adminDecisionTbank(p.id, false); };

      box.appendChild(card);
    });
  }

  async function adminDecisionTbank(paymentId, approved) {
    if (!ensureTelegramOrExplain()) return;
    try {
      await apiPost("/api/admin/tbank/decision", { payment_id: paymentId, approved: approved });
      await refreshAdminLists();
      tgAlert("Готово.");
    } catch (e) {
      tgAlert("Ошибка: " + (e && e.message ? e.message : "unknown"));
    }
  }

  // -----------------------------
  // Boot
  // -----------------------------
  async function initApp() {
    try {
      if (tg && tg.ready) tg.ready();
      if (tg && tg.expand) tg.expand();
    } catch (e) {}

    populateTgTypes();
    setupProfileUI();
    bindOverlayClose();
    installLinkWatcher();
    window.recalc();

    try {
      await loadData();
    } catch (e) {
      if (e && e.status === 401) {
        tgAlert(
          "HTTP 401\n\n" +
          "Это значит: initData не прошёл проверку.\n\n" +
          "Проверь:\n" +
          "1) Mini App открыт кнопкой WebApp у ЭТОГО ЖЕ бота\n" +
          "2) BOT_TOKEN на сервере — от того же бота\n"
        );
      } else {
        tgAlert("Ошибка загрузки: " + (e && e.message ? e.message : "unknown"));
      }
    }

    render();

    var loader = el("loader");
    if (loader) {
      addClass(loader, "fade-out");
      setTimeout(function () {
        try { loader.remove(); } catch (e) { loader.style.display = "none"; }
        var cont = document.querySelector(".app-container");
        if (cont) addClass(cont, "anim-active");
      }, 250);
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initApp().catch(function (e) {
      console.error(e);
      tgAlert("Fatal init error: " + (e && e.message ? e.message : e));
    });
  });

})();
