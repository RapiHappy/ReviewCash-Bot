/* ReviewCash MiniApp — STABLE (Stars + T-Bank)
   Endpoints used:
   - POST /api/sync
   - POST /api/task/create
   - POST /api/task/submit
   - POST /api/withdraw/create
   - POST /api/withdraw/list
   - POST /api/ops/list
   - POST /api/tbank/claim   (NEW, implemented in main.py below)
*/

(function () {
  "use strict";

  // -----------------------------
  // Telegram / Mock
  // -----------------------------
  var MockTelegram = {
    WebApp: {
      expand: function () {},
      setHeaderColor: function () {},
      showAlert: function (msg) { alert(msg); },
      showConfirm: function (msg, cb) { var r = confirm(msg); if (cb) cb(r); },
      openTelegramLink: function (url) { window.open(url, "_blank"); },
      sendData: function (data) { alert("DEV MODE sendData:\n\n" + data); },
      ready: function () {},
      initData: "",
      initDataUnsafe: { user: { id: 123456, username: "dev_user", first_name: "Dev", last_name: "Mode" } }
    }
  };

  var tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : MockTelegram.WebApp;

  function showErr(msg, err) {
    try { if (window.__showError) return window.__showError(String(msg), err); } catch (e) {}
    try { console.error(msg, err); } catch (e2) {}
  }

  function tgAlert(msg) {
    try { tg.showAlert(String(msg)); } catch (e) { alert(String(msg)); }
  }

  function normalizeTelegramUrl(s) {
    var v = (s || "").trim();
    if (!v) return "";
    if (/^@[\w\d_]+$/i.test(v)) return "https://t.me/" + v.slice(1);
    if (/^t\.me\/.+/i.test(v)) return "https://" + v;
    v = v.replace(/^https?:\/\/telegram\.me\//i, "https://t.me/");
    return v;
  }

  function tgOpenTelegramLink(url) {
    try {
      var u = normalizeTelegramUrl(url);
      if (window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.openTelegramLink === "function") {
        return window.Telegram.WebApp.openTelegramLink(u);
      }
      window.open(u, "_blank");
    } catch (e) {
      window.open(String(url), "_blank");
    }
  }
  window.tgOpenTelegramLink = tgOpenTelegramLink;

  function isTelegramWebApp() {
    try {
      return !!(window.Telegram && window.Telegram.WebApp &&
        typeof window.Telegram.WebApp.initData === "string" &&
        window.Telegram.WebApp.initData.length > 0);
    } catch (e) { return false; }
  }

  function getTgUser() {
    try { if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) return tg.initDataUnsafe.user; } catch (e) {}
    return MockTelegram.WebApp.initDataUnsafe.user;
  }

  function tgInitData() {
    try {
      return (window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.initData === "string")
        ? window.Telegram.WebApp.initData
        : "";
    } catch (e) { return ""; }
  }

  var warnedOnce = false;
  function ensureTelegramOrExplain() {
    if (isTelegramWebApp()) return true;
    if (!warnedOnce) {
      warnedOnce = true;
      tgAlert("Открой Mini App через кнопку в Telegram (WebApp).\nЕсли открыть сайт напрямую — сервер вернёт 401.");
    }
    return false;
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
    if (v) return String(v).replace(/\/+$/, "");
    return window.location.origin;
  }
  var API = "https://reviewcash-bot.onrender.com";

  function getDeviceHash() {
    var v = "";
    try { v = localStorage.getItem("device_hash"); } catch (e) {}
    if (!v) {
      v = "dev_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
      try { localStorage.setItem("device_hash", v); } catch (e2) {}
    }
    return v;
  }

  function withTimeout(ms) {
    var c = new AbortController();
    var t = setTimeout(function () { try { c.abort(); } catch (e) {} }, ms);
    return { signal: c.signal, cancel: function () { clearTimeout(t); } };
  }

  async function apiPost(path, data) {
    var tt = withTimeout(15000);
    try {
      var res = await fetch(API + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tg-InitData": tgInitData() },
        body: JSON.stringify(Object.assign({}, data || {}, { device_hash: getDeviceHash() })),
        signal: tt.signal
      });
      var j = {};
      try { j = await res.json(); } catch (e) { j = {}; }
      if (!res.ok || j.ok === false) {
        throw new Error((j && j.error) ? j.error : ("HTTP " + res.status));
      }
      return j;
    } catch (e2) {
      var m = (e2 && e2.name === "AbortError") ? "Timeout (15s)" : (e2?.message || "Failed to fetch");
      throw new Error(m);
    } finally {
      tt.cancel();
    }
  }

  // -----------------------------
  // Config
  // -----------------------------
  var ADMIN_IDS = [6482440657, 123456];

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
  var state = { filter: "all", user: { rub: 0, stars: 0, xp: 0, level: 1 }, tasks: [], withdrawals: [], ops: [] };
  var isLinkValid = false;
  var linkCheckTimer = null;
  var activeTaskId = null;
  var tbankAmount = 0;

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
    if (user && typeof user.photo_url === "string" && user.photo_url.indexOf("http") === 0) photoSrc = user.photo_url;
    else photoSrc = "https://ui-avatars.com/api/?name=" + encodeURIComponent(seed) + "&background=random&color=fff&size=128&bold=true";

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

  function checkAdmin() {
    var u = getTgUser();
    var adminPanel = el("admin-panel-card");
    if (!adminPanel) return;
    adminPanel.style.display = (u && u.id && ADMIN_IDS.indexOf(Number(u.id)) >= 0) ? "block" : "none";
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

    if (id === "m-withdraw") renderWithdrawals();
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
  // Link validation
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
      }, 450);
    });
  }

  // -----------------------------
  // Data
  // -----------------------------
  function normalizeTask(t) {
    var myId = 0;
    try { myId = Number((getTgUser() && getTgUser().id) || 0); } catch (e) { myId = 0; }
    var ownerId = Number(t.owner_id || t.user_id || 0);
    var owner = (ownerId && myId && ownerId === myId) ? "me" : "other";

    var target = t.target_url || t.target || "";
    if ((t.type === "tg") && target) target = normalizeTelegramUrl(target);

    return {
      id: String(t.id),
      type: String(t.type || "tg"),
      subType: t.sub_type || t.subType || null,
      name: t.title || t.name || "Задание",
      price: Number(t.reward_rub || t.reward || t.price || 0),
      owner: owner,
      checkType: t.check_type || t.checkType || ((t.type === "tg") ? "auto" : "manual"),
      target: target,
      text: t.instructions || t.text || "",
      qty: Number(t.qty_total || t.qty || 1),
      raw: t
    };
  }

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

    state.tasks = (r.tasks || []).map(normalizeTask);

    try { state.withdrawals = (await apiPost("/api/withdraw/list", {})).withdrawals || []; } catch (e) {}
    try { state.ops = (await apiPost("/api/ops/list", {})).operations || []; } catch (e2) {}
  }

  // -----------------------------
  // Render
  // -----------------------------
  function renderBalance() {
    if (el("u-bal-rub")) el("u-bal-rub").innerText = Math.floor(state.user.rub).toLocaleString("ru-RU") + " ₽";
    if (el("u-bal-star")) el("u-bal-star").innerText = Math.floor(state.user.stars).toLocaleString("ru-RU") + " ⭐";

    var xpPerLevel = 100;
    var lvl = Math.max(1, Number(state.user.level || 1));
    var next = lvl * xpPerLevel;
    var prev = (lvl - 1) * xpPerLevel;
    var curXP = Number(state.user.xp || 0);
    var inLvl = curXP - prev;
    var need = next - prev;
    var pct = need > 0 ? Math.max(0, Math.min(100, (inLvl / need) * 100)) : 0;

    if (el("u-lvl-badge")) el("u-lvl-badge").innerText = "LVL " + lvl;
    if (el("u-xp-cur")) el("u-xp-cur").innerText = curXP + " XP";
    if (el("u-xp-next")) el("u-xp-next").innerText = next + " XP";
    if (el("u-xp-fill")) el("u-xp-fill").style.width = pct + "%";
  }

  function renderTasks() {
    var box = el("tasks-list");
    if (!box) return;
    box.innerHTML = "";

    if (!isTelegramWebApp()) {
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
      return (state.filter === "all") ? (t.owner === "other") : (t.owner === "me");
    });

    if (!list.length) {
      var empty = document.createElement("div");
      empty.style.textAlign = "center";
      empty.style.padding = "60px 20px";
      empty.style.color = "var(--text-dim)";
      empty.style.opacity = "0.6";
      empty.innerHTML =
        '<div style="font-size:48px;margin-bottom:15px;filter:grayscale(1);">📭</div>' +
        '<div style="font-weight:800;">Задач пока нет</div>' +
        '<div style="font-size:12px;margin-top:5px;">Создай свою через “+”</div>';
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
      title.style.fontWeight = "800";
      title.innerText = t.name;

      var price = document.createElement("div");
      price.style.color = "var(--accent-cyan)";
      price.style.fontWeight = "900";
      price.style.fontSize = "14px";
      price.innerText = "+" + t.price + " ₽";

      meta.appendChild(title);
      meta.appendChild(price);

      left.appendChild(brand);
      left.appendChild(meta);

      var btn = document.createElement("button");
      btn.className = "btn btn-action";
      btn.innerText = (t.owner === "me") ? "Удалить" : "Выполнить";
      btn.onclick = function () { window.handleTask(btn, t.owner, t.id); };

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
    } catch (e) { return String(v); }
  }

  function providerTitle(p) {
    if (p === "tbank") return "Пополнение (Т-Банк)";
    if (p === "stars") return "Пополнение (Stars)";
    return "Операция";
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
        icon = (status === "paid") ? "✅" : "⏳";
      } else if (kind === "withdrawal") {
        title = "Вывод средств";
        sign = "-";
        colorClass = "amt-red";
        icon = (status === "paid") ? "✅" : (status === "rejected") ? "❌" : "⏳";
      }

      var statusText = (status === "paid") ? "Выполнено" : (status === "rejected") ? "Отклонено" : "Ожидает";

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
      var amount = Number((w.amount_rub != null) ? w.amount_rub : (w.amount != null) ? w.amount : 0);
      var created = w.created_at || w.date || "";
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
          '<div style="font-weight:800; font-size:13px;">' + amount.toFixed(0) + " ₽</div>" +
          '<div style="font-size:10px; color:var(--text-dim);">' + fmtDate(created) + "</div>" +
        "</div>" +
        '<div class="status-badge ' + stClass + '">' + stText + "</div>";

      list.appendChild(div);
    });
  }

  function render() {
    renderBalance();
    renderTasks();
    window.renderReferrals && window.renderReferrals();
  }
  window.render = render;

  // -----------------------------
  // Navigation
  // -----------------------------
  window.showTab = function (t) {
    var navItems = document.querySelectorAll(".nav-item");
    for (var i = 0; i < navItems.length; i++) rmClass(navItems[i], "active");
    var navBtn = el("tab-" + t);
    if (navBtn) addClass(navBtn, "active");

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
      try { state.ops = (await apiPost("/api/ops/list", {})).operations || []; } catch (e) {}
    }
    renderHistory();
  };

  window.closeHistory = function () {
    addClass(el("view-history"), "hidden");
    rmClass(el("view-profile"), "hidden");
    var tabProfile = el("tab-profile");
    if (tabProfile) addClass(tabProfile, "active");
  };

  window.toggleTheme = function () {
    document.body.classList.toggle("light-mode");
    var isLight = document.body.classList.contains("light-mode");
    try { if (tg.setHeaderColor) tg.setHeaderColor(isLight ? "#f2f4f7" : "#05070a"); } catch (e) {}
  };

  // -----------------------------
  // Filters
  // -----------------------------
  window.setFilter = function (f) {
    state.filter = f;
    if (el("f-all")) el("f-all").classList.toggle("active", f === "all");
    if (el("f-my")) el("f-my").classList.toggle("active", f === "my");
    renderTasks();
  };

  // -----------------------------
  // Create task
  // -----------------------------
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

  window.createTask = async function () {
    if (!ensureTelegramOrExplain()) return;

    var type = el("t-type") ? el("t-type").value : "tg";
    var qty = parseInt(el("t-qty") ? el("t-qty").value : "1", 10);
    var currency = el("t-cur") ? el("t-cur").value : "rub";
    var targetRaw = (el("t-target") ? el("t-target").value : "").trim();
    var instructions = (el("t-text") ? el("t-text").value : "").trim();

    if (!qty || qty < 1) return tgAlert("Минимальное количество: 1");
    if (!targetRaw) return tgAlert("Укажите ссылку на объект");
    if (!isLinkValid) return tgAlert("Укажите корректную ссылку и дождитесь проверки.");
    if (currency === "star") return tgAlert("Создание заданий за Stars пока отключено. Stars только для пополнения.");

    var target = (type === "tg") ? normalizeTelegramUrl(targetRaw) : targetRaw;

    var pricePerItem = 0, workerReward = 0, taskName = "", checkType = "manual";
    var tgChat = null, tgKind = null;

    if (type === "tg") {
      var stKey = el("t-tg-subtype") ? el("t-tg-subtype").value : "tg_sub";
      var conf = TG_TASK_TYPES[stKey];
      if (!conf) return tgAlert("Выберите тип TG-задания");
      pricePerItem = Number(conf.cost || 0);
      workerReward = Number(conf.reward || 0);
      taskName = conf.label || "TG задание";
      checkType = "auto";

      tgChat = target.replace(/^https?:\/\/t\.me\//i, "@").replace(/^t\.me\//i, "@");
      tgChat = tgChat.split("/")[0];
      tgKind = (stKey === "tg_group") ? "group" : "channel";
    } else {
      var opt = el("t-type")?.selectedOptions?.[0] || null;
      pricePerItem = opt ? Number(opt.dataset.p || 0) : 0;
      taskName = (type === "ya") ? "Отзыв Яндекс" : "Отзыв Google";
      checkType = "manual";
      workerReward = Math.floor(pricePerItem * 0.5);
    }

    var costRub = pricePerItem * qty;

    try {
      await apiPost("/api/task/create", {
        type: type, title: taskName, target_url: target, instructions: instructions,
        reward_rub: workerReward, cost_rub: costRub, qty_total: qty, check_type: checkType,
        tg_chat: tgChat, tg_kind: tgKind
      });

      await loadData();
      render();
      window.closeModal();
      window.setFilter("my");
      tgAlert("✅ Задание создано!\nСписано: " + costRub + " ₽");
    } catch (e) {
      tgAlert("Ошибка создания: " + (e?.message || "unknown"));
      showErr("createTask error", e);
    }
  };

  // -----------------------------
  // Task details / submit
  // -----------------------------
  window.handleTask = async function (_btn, owner, id) {
    if (!ensureTelegramOrExplain()) return;

    id = String(id || "");
    if (owner === "me") return tgAlert("Удаление заданий отключено (нужен endpoint cancel).");

    var task = state.tasks.find(function (x) { return String(x.id) === id; });
    if (!task) return;

    activeTaskId = id;

    if (el("td-title")) el("td-title").innerText = task.name;
    if (el("td-reward")) el("td-reward").innerText = "+" + task.price + " ₽";

    var iconBox = el("td-icon");
    if (iconBox) {
      if (task.type === "tg" && task.subType && TG_TASK_TYPES[task.subType]) {
        iconBox.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:32px;">' + TG_TASK_TYPES[task.subType].icon + "</div>";
        if (el("td-type-badge")) el("td-type-badge").innerText = TG_TASK_TYPES[task.subType].label.toUpperCase();
      } else if (ASSETS[task.type]) {
        iconBox.innerHTML = '<img src="' + ASSETS[task.type] + '" style="width:100%;height:100%;object-fit:contain;">';
        if (el("td-type-badge")) el("td-type-badge").innerText = String(task.type).toUpperCase();
      } else {
        iconBox.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:32px;">📄</div>';
        if (el("td-type-badge")) el("td-type-badge").innerText = String(task.type).toUpperCase();
      }
    }

    if (el("td-link")) el("td-link").innerText = task.target || "";
    var linkBtn = el("td-link-btn");
    if (linkBtn) {
      linkBtn.href = task.target || "#";
      linkBtn.onclick = function (e) { try { e.preventDefault(); } catch (e2) {} tgOpenTelegramLink(task.target); };
    }
    if (el("td-text")) el("td-text").innerText = task.text || "Нет дополнительных инструкций";

    var isAuto = (task.checkType === "auto");
    setHidden(el("proof-manual"), isAuto);
    setHidden(el("proof-auto"), !isAuto);

    if (el("p-username")) el("p-username").value = "";

    var actionBtn = el("td-action-btn");
    if (actionBtn) {
      actionBtn.disabled = false;
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
      tgAlert("✅ Отправлено! Если бот видит выполнение — начисление сразу.");
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = "⚡ Проверить выполнение"; }
      tgAlert("Ошибка: " + (e?.message || "unknown"));
      showErr("checkTgTask error", e);
    }
  };

  window.submitReviewProof = async function (taskId) {
    if (!ensureTelegramOrExplain()) return;
    var uname = (el("p-username") ? el("p-username").value : "").trim();
    if (!uname) return tgAlert("Укажите ваше имя/никнейм.");

    var btn = el("td-action-btn");
    if (btn) { btn.disabled = true; btn.innerHTML = "⏳ Отправка..."; }

    try {
      await apiPost("/api/task/submit", { task_id: String(taskId), proof_text: uname, proof_url: "" });
      await loadData();
      render();
      window.closeModal();
      tgAlert("✅ Отчет отправлен! Дальше — модерация.");
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = "📤 Отправить отчет"; }
      tgAlert("Ошибка: " + (e?.message || "unknown"));
      showErr("submitReviewProof error", e);
    }
  };

  window.updateFileName = function () { tgAlert("Загрузка скриншота пока отключена (нет upload endpoint)."); };

  window.copyLink = function () {
    var url = el("td-link") ? el("td-link").innerText : "";
    if (!url) return;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(function () { tgAlert("Ссылка скопирована"); });
    else tgAlert(url);
  };

  // -----------------------------
  // Referrals
  // -----------------------------
  window.renderReferrals = function () {
    var u = getTgUser();
    var uid = (u && u.id) ? u.id : "12345";
    var invite = "t.me/ReviewCashBot?start=" + uid;
    if (el("invite-link")) el("invite-link").innerText = invite;
    if (el("ref-count")) el("ref-count").innerText = "0";
    if (el("ref-earn")) el("ref-earn").innerText = "0 ₽";
  };

  window.copyInviteLink = function () {
    var u = getTgUser();
    var uid = (u && u.id) ? u.id : "12345";
    var link = "https://t.me/ReviewCashBot?start=" + uid;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(function () { tgAlert("🔗 Ссылка скопирована!"); });
    else tgAlert(link);
  };

  window.shareInvite = function () {
    var u = getTgUser();
    var uid = (u && u.id) ? u.id : "12345";
    var inviteLink = "https://t.me/ReviewCashBot?start=" + uid;
    tgOpenTelegramLink("https://t.me/share/url?url=" + encodeURIComponent(inviteLink) + "&text=" + encodeURIComponent("Зарабатывай на заданиях вместе со мной!"));
  };

  // -----------------------------
  // Payments
  // -----------------------------
  window.processPay = function (method) {
    var val = Number(el("sum-input") ? (el("sum-input").value || 0) : 0);
    if (!isFinite(val) || val < 300) return tgAlert("Минимальная сумма пополнения — 300 ₽");

    if (method === "pay_stars") {
      if (!ensureTelegramOrExplain()) return;
      try {
        tg.sendData(JSON.stringify({ action: "pay_stars", amount: String(val) }));
      } catch (e) {
        tgAlert("Не удалось отправить данные в Telegram. Открой Mini App из бота.");
        showErr("sendData error", e);
      }
      return;
    }

    tgAlert("Неизвестный метод: " + method);
  };

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
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(code).then(function () { tgAlert("Код скопирован!"); });
    else tgAlert(code);
  };

  window.confirmTBank = async function () {
    if (!ensureTelegramOrExplain()) return;

    var sender = (el("tb-sender") ? el("tb-sender").value : "").trim();
    var code = (el("tb-code") ? el("tb-code").innerText : "").trim();
    if (!sender) return tgAlert("Укажите имя отправителя");
    if (!code) return tgAlert("Нет кода платежа");

    try {
      await apiPost("/api/tbank/claim", { amount_rub: Number(tbankAmount), sender: sender, code: code });
      tgAlert("✅ Заявка на пополнение отправлена.\nАдмин подтвердит вручную.");
      window.closeModal();
      await loadData(); render();
    } catch (e) {
      tgAlert("Ошибка Т-Банк: " + (e?.message || "unknown"));
      showErr("tbank claim error", e);
    }
  };

  // -----------------------------
  // Withdrawals
  // -----------------------------
  window.requestWithdraw = async function () {
    if (!ensureTelegramOrExplain()) return;

    var details = (el("w-details") ? el("w-details").value : "").trim();
    var amt = Number((el("w-amount") ? el("w-amount").value : "").trim());

    if (!details) return tgAlert("Укажи реквизиты");
    if (!isFinite(amt) || amt < 300) return tgAlert("Минимальная сумма: 300 ₽");

    try {
      await apiPost("/api/withdraw/create", { amount_rub: amt, details: details });
      try { state.withdrawals = (await apiPost("/api/withdraw/list", {})).withdrawals || []; } catch (e2) {}
      await loadData(); render(); renderWithdrawals();
      tgAlert("✅ Заявка создана! Ожидайте обработки.");
    } catch (e) {
      tgAlert("Ошибка вывода: " + (e?.message || "unknown"));
      showErr("withdraw error", e);
    }
  };

  // -----------------------------
  // Admin (просто инфо)
  // -----------------------------
  window.openAdminPanel = function () {
    tgAlert("Админка сделана на стороне бота:\n\n✅ /tbank_ok CODE\n✅ /tbank_no CODE\n✅ /wd_ok ID\n✅ /wd_no ID");
  };
  window.switchAdminTab = function () {};

  // -----------------------------
  // Boot
  // -----------------------------
  async function initApp() {
    try { tg.ready?.(); tg.expand?.(); } catch (e) {}

    populateTgTypes();
    setupProfileUI();
    checkAdmin();
    bindOverlayClose();
    installLinkWatcher();
    window.recalc();

    try { await loadData(); } catch (e) { tgAlert("Ошибка загрузки: " + (e?.message || "unknown")); }
    render();

    var loader = el("loader");
    if (loader) {
      addClass(loader, "fade-out");
      setTimeout(function () {
        try { loader.remove(); } catch (e) { loader.style.display = "none"; }
      }, 250);
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initApp().catch(function (e) {
      tgAlert("Fatal init error: " + (e?.message || e));
      showErr("fatal init", e);
    });
  });

})();
