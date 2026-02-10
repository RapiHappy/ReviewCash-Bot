/* ReviewCash MiniApp — full stable main.js
   - Works with backend on Render (/api/*)
   - Telegram initData header (X-Tg-InitData)
   - Stars topup via tg.sendData -> bot invoice
   - T-Bank claim via /api/tbank/claim (admin подтверждает)
   - Admin panel: approve/reject proofs, withdrawals, payments
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

  function tgAlert(msg) { try { tg.showAlert(String(msg)); } catch (e) { alert(String(msg)); } }
  function tgConfirm(msg, cb) { try { tg.showConfirm(String(msg), cb); } catch (e) { cb(confirm(String(msg))); } }
  function tgOpen(url) { try { tg.openTelegramLink(url); } catch (e) { window.open(url, "_blank"); } }

  function isTelegramWebApp() {
    try {
      return !!(window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.initData === "string" && window.Telegram.WebApp.initData.length > 0);
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
  var API = getApiBase();

  function getDeviceHash() {
    var v = "";
    try { v = localStorage.getItem("device_hash"); } catch (e) {}
    if (!v) {
      v = "dev_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
      try { localStorage.setItem("device_hash", v); } catch (e) {}
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

    var j = {};
    try { j = await res.json(); } catch (e) { j = {}; }

    if (!res.ok || j.ok === false) {
      var msg = (j && j.error) ? j.error : ("HTTP " + res.status);
      throw new Error(msg);
    }
    return j;
  }

  function ensureTelegramOrExplain() {
    if (isTelegramWebApp()) return true;
    tgAlert("Открой Mini App через кнопку в Telegram (WebApp). Если открыть сайт напрямую — initData пустой.");
    return false;
  }

  // -----------------------------
  // Config
  // -----------------------------
  var ADMIN_IDS = [6482440657, 123456]; // поставь свой id (и можно dev)

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
    tg_msg:   { label: "Сообщение боту",      cost: 15,  reward: 7,  icon: "✉️", action: "Написать" }
  };

  // -----------------------------
  // State
  // -----------------------------
  var state = {
    filter: "all",
    user: { rub: 0, stars: 0, xp: 0, level: 1 },
    tasks: [],
    withdrawals: [],
    ops: [],
    admin: { proofs: [], withdrawals: [], payments: [] }
  };

  var isLinkValid = false;
  var linkCheckTimer = null;
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

    var photoSrc = "https://ui-avatars.com/api/?name=" + encodeURIComponent(seed) + "&background=random&color=fff&size=128&bold=true";

    if (headerName) headerName.innerText = displayName;
    if (profileName) profileName.innerText = displayName;

    function setAvatar(img) {
      if (!img) return;
      img.src = photoSrc;
      img.onerror = function () { img.src = photoSrc; };
    }
    setAvatar(headerAvatar);
    setAvatar(profileAvatar);
  }

  function checkAdmin() {
    var u = getTgUser();
    var adminPanel = el("admin-panel-card");
    if (!adminPanel) return;
    if (u && u.id && ADMIN_IDS.indexOf(Number(u.id)) >= 0) adminPanel.style.display = "block";
    else adminPanel.style.display = "none";
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
      }, 400);
    });
  }

  // -----------------------------
  // Data loading
  // -----------------------------
  function normalizeTask(t) {
    var myId = 0;
    try { myId = Number(getTgUser().id || 0); } catch (e) { myId = 0; }
    var ownerId = Number(t.owner_id || t.user_id || 0);
    var owner = (ownerId && myId && ownerId === myId) ? "me" : "other";

    return {
      id: String(t.id),
      type: String(t.type || "tg"),
      name: t.title || t.name || "Задание",
      price: Number(t.reward_rub || t.reward || 0),
      owner: owner,
      checkType: t.check_type || ((t.type === "tg") ? "auto" : "manual"),
      target: t.target_url || t.target || "",
      text: t.instructions || t.text || "",
      qty: Number(t.qty_total || t.qty || 1),
      subType: t.sub_type || t.subType || null,
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
      render();
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
    } catch (e) { state.withdrawals = state.withdrawals || []; }

    try {
      var ops = await apiPost("/api/ops/list", {});
      state.ops = ops.operations || [];
    } catch (e2) { state.ops = state.ops || []; }
  }

  // -----------------------------
  // Render
  // -----------------------------
  function renderBalance() {
    var br = el("u-bal-rub");
    var bs = el("u-bal-star");
    if (br) br.innerText = Math.floor(state.user.rub).toLocaleString("ru-RU") + " ₽";
    if (bs) bs.innerText = Math.floor(state.user.stars).toLocaleString("ru-RU") + " ⭐";
  }

  function renderTasks() {
    var box = el("tasks-list");
    if (!box) return;
    box.innerHTML = "";

    var list = state.tasks.filter(function (t) {
      if (state.filter === "all") return t.owner === "other";
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
        '<div style="font-size:12px;margin-top:5px;">Создай свою или зайди позже</div>';
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
      if (t.type === "tg") {
        brand.innerHTML = '<div style="font-size:24px;">✈️</div>';
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

      meta.appendChild(title);
      meta.appendChild(price);

      left.appendChild(brand);
      left.appendChild(meta);

      var btn = document.createElement("button");
      btn.className = "btn btn-action";
      btn.innerText = (t.owner === "me") ? "Моё" : "Выполнить";
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
      return d.toLocaleString("ru-RU", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
    } catch (e) { return String(v); }
  }

  function providerTitle(p) {
    if (!p) return "Пополнение";
    if (p === "tbank") return "Пополнение (T-Bank)";
    if (p === "stars") return "Пополнение (Stars)";
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
        icon = (status === "paid") ? "✅" : (status === "rejected") ? "❌" : "⏳";
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
          '<div style="font-weight:700; font-size:13px;">' + amount.toFixed(0) + " ₽</div>" +
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
    var a = el("f-all");
    var m = el("f-my");
    if (a) a.classList.toggle("active", f === "all");
    if (m) m.classList.toggle("active", f === "my");
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
    if (!target) return tgAlert("Укажите ссылку");
    if (!isLinkValid) return tgAlert("Укажите корректную ссылку и дождитесь проверки.");

    if (currency === "star") {
      return tgAlert("Создание заданий за Stars пока отключено (Stars только для пополнения баланса).");
    }

    var pricePerItem = 0;
    var workerReward = 0;
    var taskName = "";
    var checkType = "manual";
    var tgChat = null;
    var tgKind = null;

    if (type === "tg") {
      var stKey = subtypeEl ? subtypeEl.value : "tg_sub";
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
        tg_kind: tgKind
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
    var task = null;
    for (var i = 0; i < state.tasks.length; i++) {
      if (String(state.tasks[i].id) === id) { task = state.tasks[i]; break; }
    }
    if (!task) return;

    activeTaskId = id;

    if (el("td-title")) el("td-title").innerText = task.name;
    if (el("td-reward")) el("td-reward").innerText = "+" + task.price + " ₽";

    var iconBox = el("td-icon");
    var iconHtml = (task.type === "tg")
      ? '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:32px;">✈️</div>'
      : (ASSETS[task.type] ? '<img src="' + ASSETS[task.type] + '" style="width:100%;height:100%;object-fit:contain;">'
                          : '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:32px;">📄</div>');
    if (iconBox) iconBox.innerHTML = iconHtml;
    if (el("td-type-badge")) el("td-type-badge").innerText = String(task.type).toUpperCase();

    if (el("td-link")) el("td-link").innerText = task.target;
    if (el("td-link-btn")) el("td-link-btn").href = task.target;
    if (el("td-text")) el("td-text").innerText = task.text || "Нет дополнительных инструкций";

    var isAuto = (task.checkType === "auto");
    setHidden(el("proof-manual"), isAuto);
    setHidden(el("proof-auto"), !isAuto);

    if (el("p-username")) el("p-username").value = "";

    var actionBtn = el("td-action-btn");
    if (actionBtn) {
      actionBtn.disabled = false;
      if (isAuto) {
        actionBtn.innerText = "⚡ Проверить выполнение";
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
      tgAlert("✅ Готово! Если бот видит подписку — начисление сразу.");
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = "⚡ Проверить выполнение"; }
      tgAlert("Ошибка: " + (e && e.message ? e.message : "unknown"));
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
      tgAlert("✅ Отчет отправлен! Дальше — модерация.");
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = "📤 Отправить отчет"; }
      tgAlert("Ошибка: " + (e && e.message ? e.message : "unknown"));
    }
  };

  // -----------------------------
  // Copy helpers
  // -----------------------------
  window.copyLink = function () {
    var url = el("td-link") ? el("td-link").innerText : "";
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { tgAlert("Ссылка скопирована"); });
    } else tgAlert(url);
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
    var inviteLink = "https://t.me/ReviewCashBot?start=" + uid;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(inviteLink).then(function () { tgAlert("🔗 Ссылка скопирована!"); });
    } else tgAlert(inviteLink);
  };

  window.shareInvite = function () {
    var u = getTgUser();
    var uid = (u && u.id) ? u.id : "12345";
    var inviteLink = "https://t.me/ReviewCashBot?start=" + uid;
    tgOpen("https://t.me/share/url?url=" + encodeURIComponent(inviteLink) + "&text=" + encodeURIComponent("Зарабатывай на заданиях вместе со мной!"));
  };

  // -----------------------------
  // Payments: Stars + TBank
  // -----------------------------
  window.processPay = function (method) {
    var val = Number(el("sum-input") ? (el("sum-input").value || 0) : 0);
    if (!isFinite(val) || val < 300) return tgAlert("Минимальная сумма пополнения — 300 ₽");

    if (method === "pay_stars") {
      if (!ensureTelegramOrExplain()) return;
      try { tg.sendData(JSON.stringify({ action: "pay_stars", amount: String(val) })); }
      catch (e) { tgAlert("Не удалось отправить данные. Открой Mini App из бота."); }
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
    } else tgAlert(code);
  };

  window.confirmTBank = async function () {
    if (!ensureTelegramOrExplain()) return;

    var sender = (el("tb-sender") ? el("tb-sender").value : "").trim();
    var code = (el("tb-code") ? el("tb-code").innerText : "").trim();
    if (!sender) return tgAlert("Укажите имя отправителя");
    if (!code) return tgAlert("Нет кода платежа");

    try {
      await apiPost("/api/tbank/claim", { amount_rub: Number(tbankAmount), sender: sender, code: code });
      tgAlert("✅ Заявка отправлена. Админ подтвердит вручную.");
      window.closeModal();
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
      var w = await apiPost("/api/withdraw/list", {});
      state.withdrawals = w.withdrawals || [];
      renderWithdrawals();
      tgAlert("✅ Заявка создана! Ожидайте обработки.");
    } catch (e) {
      tgAlert("Ошибка вывода: " + (e && e.message ? e.message : "unknown"));
    }
  };

  // -----------------------------
  // Admin panel
  // -----------------------------
  function isMeAdmin() {
    var u = getTgUser();
    return u && u.id && ADMIN_IDS.indexOf(Number(u.id)) >= 0;
  }

  async function adminRefresh() {
    if (!isMeAdmin()) return;

    try {
      var p = await apiPost("/api/admin/proof/list", {});
      state.admin.proofs = p.proofs || [];
    } catch (e) { state.admin.proofs = []; }

    try {
      var w = await apiPost("/api/admin/withdraw/list", {});
      state.admin.withdrawals = w.withdrawals || [];
    } catch (e2) { state.admin.withdrawals = []; }

    try {
      var pay = await apiPost("/api/admin/payments/list", {});
      state.admin.payments = pay.payments || [];
    } catch (e3) { state.admin.payments = []; }

    var badge = el("admin-badge");
    var cnt = (state.admin.proofs.length || 0) + (state.admin.withdrawals.filter(function(x){return String(x.status||"") === "pending";}).length || 0) + (state.admin.payments.length || 0);
    if (badge) {
      badge.textContent = String(cnt);
      badge.style.opacity = cnt > 0 ? "1" : "0";
    }

    renderAdminLists();
  }

  function mkAdminCard(title, subtitle, rightHtml, btnOk, btnNo) {
    var card = document.createElement("div");
    card.className = "card";
    card.style.padding = "14px";

    var top = document.createElement("div");
    top.style.display = "flex";
    top.style.justifyContent = "space-between";
    top.style.gap = "10px";

    var left = document.createElement("div");
    left.innerHTML = '<div style="font-weight:800;">' + title + '</div><div style="font-size:12px; color:var(--text-dim); margin-top:4px;">' + subtitle + "</div>";

    var right = document.createElement("div");
    right.innerHTML = rightHtml || "";

    top.appendChild(left);
    top.appendChild(right);

    var actions = document.createElement("div");
    actions.style.display = "grid";
    actions.style.gridTemplateColumns = "1fr 1fr";
    actions.style.gap = "10px";
    actions.style.marginTop = "12px";

    var b1 = document.createElement("button");
    b1.className = "btn btn-main";
    b1.textContent = "✅ Принять";
    b1.onclick = btnOk;

    var b2 = document.createElement("button");
    b2.className = "btn btn-secondary";
    b2.textContent = "❌ Отклонить";
    b2.onclick = btnNo;

    actions.appendChild(b1);
    actions.appendChild(b2);

    card.appendChild(top);
    card.appendChild(actions);
    return card;
  }

  async function adminDecision(endpoint, payload) {
    try {
      await apiPost(endpoint, payload);
      await adminRefresh();
      tgAlert("✅ Готово");
    } catch (e) {
      tgAlert("Ошибка: " + (e && e.message ? e.message : "unknown"));
    }
  }

  function renderAdminLists() {
    var proofsBox = el("admin-list");
    var wdBox = el("admin-withdraw-list");
    var payBox = el("admin-pay-list");

    if (proofsBox) {
      proofsBox.innerHTML = "";
      if (!state.admin.proofs.length) {
        proofsBox.innerHTML = '<div style="text-align:center; color:var(--text-dim); padding:12px;">Нет отчётов</div>';
      } else {
        state.admin.proofs.forEach(function (p) {
          var title = "Отчёт • user " + p.user_id;
          var sub = "task_id: " + p.task_id + "<br>text: " + (p.proof_text || "");
          proofsBox.appendChild(
            mkAdminCard(
              title,
              sub,
              '<div style="font-size:12px; opacity:.6;">' + fmtDate(p.created_at) + "</div>",
              function(){ adminDecision("/api/admin/proof/decision", { proof_id: p.id, approved: true }); },
              function(){ adminDecision("/api/admin/proof/decision", { proof_id: p.id, approved: false }); }
            )
          );
        });
      }
    }

    if (wdBox) {
      wdBox.innerHTML = "";
      var wds = (state.admin.withdrawals || []).filter(function (x) { return String(x.status || "") === "pending"; });
      if (!wds.length) {
        wdBox.innerHTML = '<div style="text-align:center; color:var(--text-dim); padding:12px;">Нет выводов</div>';
      } else {
        wds.forEach(function (w) {
          var title = "Вывод • " + (Number(w.amount_rub || 0)).toFixed(0) + " ₽";
          var sub = "user: " + w.user_id + "<br>details: " + (w.details || "");
          wdBox.appendChild(
            mkAdminCard(
              title,
              sub,
              '<div style="font-size:12px; opacity:.6;">' + fmtDate(w.created_at) + "</div>",
              function(){ adminDecision("/api/admin/withdraw/decision", { withdraw_id: w.id, approved: true }); },
              function(){ adminDecision("/api/admin/withdraw/decision", { withdraw_id: w.id, approved: false }); }
            )
          );
        });
      }
    }

    if (payBox) {
      payBox.innerHTML = "";
      if (!state.admin.payments.length) {
        payBox.innerHTML = '<div style="text-align:center; color:var(--text-dim); padding:12px;">Нет пополнений</div>';
      } else {
        state.admin.payments.forEach(function (p) {
          var title = "Пополнение • " + (Number(p.amount_rub || 0)).toFixed(0) + " ₽";
          var meta = "";
          try { meta = p.meta ? JSON.stringify(p.meta) : ""; } catch(e) { meta = ""; }
          var sub = "provider: " + (p.provider || "") + "<br>user: " + p.user_id + "<br>ref: " + (p.provider_ref || "") + (meta ? "<br>meta: " + meta : "");
          payBox.appendChild(
            mkAdminCard(
              title,
              sub,
              '<div style="font-size:12px; opacity:.6;">' + fmtDate(p.created_at) + "</div>",
              function(){ adminDecision("/api/admin/payments/decision", { payment_id: p.id, approved: true }); },
              function(){ adminDecision("/api/admin/payments/decision", { payment_id: p.id, approved: false }); }
            )
          );
        });
      }
    }
  }

  window.openAdminPanel = async function () {
    if (!isMeAdmin()) return tgAlert("Нет доступа");
    window.openModal("m-admin");
    await adminRefresh();
  };

  window.switchAdminTab = function (tab) {
    var tabs = ["proofs", "withdrawals", "payments"];
    tabs.forEach(function (t) {
      var btn = el("at-" + t);
      if (btn) btn.classList.toggle("active", t === tab);
    });
    setHidden(el("admin-view-proofs"), tab !== "proofs");
    setHidden(el("admin-view-withdrawals"), tab !== "withdrawals");
    setHidden(el("admin-view-payments"), tab !== "payments");
  };

  // -----------------------------
  // Boot
  // -----------------------------
  async function initApp() {
    try { if (tg && tg.ready) tg.ready(); if (tg && tg.expand) tg.expand(); } catch (e) {}

    populateTgTypes();
    setupProfileUI();
    checkAdmin();
    bindOverlayClose();
    installLinkWatcher();
    window.recalc();

    try {
      await loadData();
    } catch (e) {
      tgAlert("Ошибка загрузки: " + (e && e.message ? e.message : "unknown") +
        "\n\nЕсли видишь 401 — значит сервер не принял initData. Открой Mini App строго из кнопки этого же бота.");
    }

    render();

    var loader = el("loader");
    if (loader) {
      setTimeout(function () {
        try { loader.remove(); } catch (e) { loader.style.display = "none"; }
      }, 250);
    }

    // админ бейдж обновим тоже
    if (isMeAdmin()) {
      try { await adminRefresh(); } catch(e2) {}
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initApp().catch(function (e) {
      console.error(e);
      tgAlert("Fatal init error: " + (e && e.message ? e.message : e));
    });
  });

})();
