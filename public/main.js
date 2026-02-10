/* ReviewCash MiniApp — stable main.js (Stars + T-Bank + Withdraw)
   IMPORTANT:
   - 401 = Mini App opened NOT via this bot button (no initData) OR BOT_TOKEN mismatch on server
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
      sendData: function (data) { alert("DEV MODE sendData:\n" + data); },
      ready: function () {},
      initData: "",
      initDataUnsafe: { user: { id: 123456, username: "dev_user", first_name: "Dev", last_name: "Mode" } }
    }
  };

  var tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : MockTelegram.WebApp;

  function tgAlert(msg) {
    try { tg.showAlert(String(msg)); } catch (e) { alert(String(msg)); }
  }
  function tgOpen(url) {
    try { tg.openTelegramLink(url); } catch (e) { window.open(url, "_blank"); }
  }

  function isTelegramWebApp() {
    try {
      return !!(window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.initData === "string" && window.Telegram.WebApp.initData.length > 0);
    } catch (e) { return false; }
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
  // DOM
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
      var msg = j && j.error ? j.error : ("HTTP " + res.status);
      throw new Error(msg);
    }
    return j;
  }

  function ensureTelegramOrExplain() {
    if (isTelegramWebApp()) return true;
    tgAlert("401 — это нормально если открыть не из кнопки бота.\n\nОткрой Mini App через кнопку «Открыть приложение» в этом же боте.");
    return false;
  }

  // -----------------------------
  // Config UI (TG subtypes)
  // -----------------------------
  var ASSETS = {
    ya: "https://www.google.com/s2/favicons?sz=64&domain=yandex.ru",
    gm: "https://www.google.com/s2/favicons?sz=64&domain=google.com",
    tg: "https://cdn-icons-png.flaticon.com/512/2111/2111646.png"
  };

  var TG_TASK_TYPES = {
    tg_sub:   { label: "Подписка на канал",   cost: 30,  reward: 15, icon: "📢", action: "Подписаться" },
    tg_group: { label: "Вступление в группу", cost: 25,  reward: 12, icon: "👥", action: "Вступить" },
    tg_react: { label: "Просмотр + Реакция",  cost: 10,  reward: 5,   icon: "❤️", action: "Смотреть пост" },
    tg_poll:  { label: "Участие в опросе",    cost: 15,  reward: 7,   icon: "📊", action: "Голосовать" },
    tg_start: { label: "Запуск бота /start",  cost: 25,  reward: 12,  icon: "🤖", action: "Запустить" }
  };

  // -----------------------------
  // State
  // -----------------------------
  var state = {
    filter: "all",
    user: { rub: 0, stars: 0, xp: 0, level: 1 },
    tasks: [],
    withdrawals: [],
    ops: []
  };

  var isLinkValid = false;
  var linkCheckTimer = null;
  var activeTaskId = null;

  // -----------------------------
  // UI header/profile
  // -----------------------------
  function setupProfileUI() {
    var user = getTgUser();
    var headerAvatar = el("header-avatar");
    var profileAvatar = el("u-pic");
    var headerName = el("header-name");
    var profileName = el("u-name");

    var displayName = "Пользователь";
    var seed = "U";
    if (user) {
      if (user.username) displayName = "@" + user.username;
      else displayName = (user.first_name || "") + " " + (user.last_name || "");
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

  (function bindOverlayClose() {
    document.addEventListener("click", function (e) {
      var target = e.target;
      if (!target) return;
      if (target.classList && target.classList.contains("overlay")) window.closeModal();
    });
  })();

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
  // Normalize tasks from backend
  // -----------------------------
  function normalizeTask(t) {
    var myId = 0;
    try { myId = Number(getTgUser().id || 0); } catch (e) { myId = 0; }

    var ownerId = Number(t.owner_id || 0);
    var owner = (ownerId && myId && ownerId === myId) ? "me" : "other";

    return {
      id: String(t.id),
      type: String(t.type || "tg"),
      name: t.title || "Задание",
      reward: Number(t.reward_rub || 0),
      owner: owner,
      checkType: t.check_type || ((t.type === "tg") ? "auto" : "manual"),
      target: t.target_url || "",
      text: t.instructions || "",
      qtyLeft: Number(t.qty_left || 0),
      tgChat: t.tg_chat || null,
      raw: t
    };
  }

  // -----------------------------
  // Load data
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
    state.tasks = (r.tasks || []).map(normalizeTask);

    try {
      var w = await apiPost("/api/withdraw/list", {});
      state.withdrawals = w.withdrawals || [];
    } catch (e) {}

    try {
      var ops = await apiPost("/api/ops/list", {});
      state.ops = ops.operations || [];
    } catch (e2) {}
  }

  // -----------------------------
  // Render
  // -----------------------------
  function renderBalance() {
    if (el("u-bal-rub")) el("u-bal-rub").innerText = Math.floor(state.user.rub).toLocaleString("ru-RU") + " ₽";
    if (el("u-bal-star")) el("u-bal-star").innerText = Math.floor(state.user.stars).toLocaleString("ru-RU") + " ⭐";

    // XP (optional)
    var xpPerLevel = 100;
    var lvl = Number(state.user.level || 1);
    var next = lvl * xpPerLevel;
    var prev = (lvl - 1) * xpPerLevel;
    var cur = Number(state.user.xp || 0);
    var inLvl = cur - prev;
    var need = next - prev;
    var pct = need > 0 ? Math.max(0, Math.min(100, (inLvl / need) * 100)) : 0;

    if (el("u-lvl-badge")) el("u-lvl-badge").innerText = "LVL " + lvl;
    if (el("u-xp-cur")) el("u-xp-cur").innerText = cur + " XP";
    if (el("u-xp-next")) el("u-xp-next").innerText = next + " XP";
    if (el("u-xp-fill")) el("u-xp-fill").style.width = pct + "%";
  }

  function renderTasks() {
    var box = el("tasks-list");
    if (!box) return;
    box.innerHTML = "";

    if (!ensureTelegramOrExplain()) {
      box.innerHTML = '<div class="empty">Открой Mini App через кнопку бота, чтобы загрузить задания.</div>';
      return;
    }

    var list = state.tasks.filter(function (t) {
      if (state.filter === "all") return t.owner === "other";
      return t.owner === "me";
    });

    if (!list.length) {
      box.innerHTML = '<div class="empty"><div class="emoji">📭</div><div><b>Задач пока нет</b></div><div class="dim small">Создай свою или зайди позже</div></div>';
      return;
    }

    list.forEach(function (t) {
      var item = document.createElement("div");
      item.className = "task-item";

      var left = document.createElement("div");
      left.className = "task-left";

      var brand = document.createElement("div");
      brand.className = "brand-box";

      // TG icon by subtype guess (optional)
      if (t.type === "tg") {
        brand.innerHTML = '<img src="' + ASSETS.tg + '" style="width:100%;height:100%;object-fit:contain;">';
      } else if (ASSETS[t.type]) {
        brand.innerHTML = '<img src="' + ASSETS[t.type] + '" style="width:100%;height:100%;object-fit:contain;">';
      } else {
        brand.innerHTML = "📄";
      }

      var meta = document.createElement("div");
      meta.className = "task-meta";

      var title = document.createElement("div");
      title.className = "task-title";
      title.innerText = t.name;

      var price = document.createElement("div");
      price.className = "task-reward";
      price.innerText = "+" + t.reward + " ₽";

      meta.appendChild(title);
      meta.appendChild(price);

      left.appendChild(brand);
      left.appendChild(meta);

      var btn = document.createElement("button");
      btn.className = "btn btn-action";
      btn.innerText = (t.owner === "me") ? "Моё" : "Выполнить";
      btn.onclick = function () { handleTask(t); };

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

  function renderHistory() {
    var list = el("history-list");
    if (!list) return;
    list.innerHTML = "";

    var items = Array.isArray(state.ops) ? state.ops : [];
    if (!items.length) {
      list.innerHTML = '<div class="empty">История пуста</div>';
      return;
    }

    items.forEach(function (item) {
      var kind = item.kind;
      var status = String(item.status || "pending");
      var amount = Number(item.amount_rub || 0);
      var dt = fmtDate(item.created_at);

      var title = "Операция";
      if (kind === "payment") title = (item.provider === "tbank") ? "Пополнение (T-Bank)" : "Пополнение (Stars)";
      if (kind === "withdrawal") title = "Вывод средств";

      var row = document.createElement("div");
      row.className = "list-item";
      row.innerHTML =
        '<div class="list-meta">' +
          '<div class="list-title">' + title + ' <span class="dim small">• ' + status + '</span></div>' +
          '<div class="list-date dim small">' + dt + '</div>' +
        '</div>' +
        '<div class="list-amount">' + (kind === "withdrawal" ? "-" : "+") + amount.toFixed(0) + " ₽</div>";
      list.appendChild(row);
    });
  }

  function renderWithdrawals() {
    var list = el("withdrawals-list");
    if (!list) return;

    list.innerHTML = "";
    var items = Array.isArray(state.withdrawals) ? state.withdrawals : [];
    if (!items.length) {
      list.innerHTML = '<div class="dim small" style="text-align:center;">Нет активных заявок</div>';
      return;
    }

    items.forEach(function (w) {
      var amount = Number(w.amount_rub || 0);
      var st = String(w.status || "pending");
      var div = document.createElement("div");
      div.className = "wd-row";
      div.innerHTML = '<div><b>' + amount.toFixed(0) + ' ₽</b><div class="dim small">' + fmtDate(w.created_at) + '</div></div>' +
                      '<div class="status-badge ' + (st === "paid" ? "st-paid" : (st === "rejected" ? "st-rejected" : "st-pending")) + '">' + st + '</div>';
      list.appendChild(div);
    });
  }

  function render() {
    renderBalance();
    renderTasks();
    renderReferrals();
  }

  // -----------------------------
  // Navigation
  // -----------------------------
  window.showTab = function (t) {
    ["tasks","friends","profile"].forEach(function (k) {
      var btn = el("tab-" + k);
      if (btn) btn.classList.toggle("active", k === t);
    });

    setHidden(el("view-tasks"), t !== "tasks");
    setHidden(el("view-friends"), t !== "friends");
    setHidden(el("view-profile"), t !== "profile");
    addClass(el("view-history"), "hidden");
  };

  window.showHistory = async function () {
    setHidden(el("view-tasks"), true);
    setHidden(el("view-friends"), true);
    setHidden(el("view-profile"), true);
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
    var tab = el("tab-profile");
    if (tab) addClass(tab, "active");
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

    var type = el("t-type") ? el("t-type").value : "tg";
    var stKey = el("t-tg-subtype") ? el("t-tg-subtype").value : "tg_sub";
    var qty = parseInt(el("t-qty") ? el("t-qty").value : "1", 10);
    var currency = el("t-cur") ? el("t-cur").value : "rub";
    var target = (el("t-target") ? el("t-target").value : "").trim();
    var instructions = (el("t-text") ? el("t-text").value : "").trim();

    if (!qty || qty < 1) return tgAlert("Минимум 1");
    if (!target) return tgAlert("Укажи ссылку");
    if (!isLinkValid) return tgAlert("Дождись проверки ссылки");

    if (currency === "star") {
      return tgAlert("Создание заданий за Stars пока выключено.\nStars только для пополнения.");
    }

    var pricePerItem = 0;
    var workerReward = 0;
    var taskName = "";
    var checkType = "manual";
    var tgChat = null;
    var tgKind = null;

    if (type === "tg") {
      var conf = TG_TASK_TYPES[stKey];
      if (!conf) return tgAlert("Выбери тип TG задания");
      pricePerItem = Number(conf.cost || 0);
      workerReward = Number(conf.reward || 0);
      taskName = conf.label;
      checkType = "auto";

      tgChat = target.replace(/^https?:\/\/t\.me\//i, "@").replace(/^t\.me\//i, "@");
      tgChat = tgChat.split("/")[0];
      tgKind = (stKey === "tg_group") ? "group" : "channel";
    } else {
      var opt = el("t-type") && el("t-type").selectedOptions ? el("t-type").selectedOptions[0] : null;
      pricePerItem = opt ? Number(opt.dataset.p || 0) : 0;
      taskName = (type === "ya") ? "Отзыв Яндекс" : "Отзыв Google";
      workerReward = Math.floor(pricePerItem * 0.5);
      checkType = "manual";
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
      closeModal();
      setFilter("my");
      tgAlert("✅ Создано! Списано: " + costRub + " ₽");
    } catch (e) {
      tgAlert("Ошибка: " + (e && e.message ? e.message : "unknown"));
    }
  };

  // -----------------------------
  // Task details / submit
  // -----------------------------
  function handleTask(task) {
    if (!task || task.owner === "me") return;

    activeTaskId = task.id;

    if (el("td-title")) el("td-title").innerText = task.name;
    if (el("td-reward")) el("td-reward").innerText = "+" + task.reward + " ₽";

    var iconBox = el("td-icon");
    if (iconBox) {
      if (ASSETS[task.type]) iconBox.innerHTML = '<img src="' + ASSETS[task.type] + '" style="width:100%;height:100%;object-fit:contain;">';
      else iconBox.innerHTML = "📄";
    }

    if (el("td-type-badge")) el("td-type-badge").innerText = String(task.type).toUpperCase();
    if (el("td-link")) el("td-link").innerText = task.target;
    if (el("td-link-btn")) el("td-link-btn").href = task.target;
    if (el("td-text")) el("td-text").innerText = task.text || "Нет инструкции";

    var isAuto = (task.checkType === "auto");
    setHidden(el("proof-manual"), isAuto);
    setHidden(el("proof-auto"), !isAuto);

    if (el("p-username")) el("p-username").value = "";

    var actionBtn = el("td-action-btn");
    if (actionBtn) {
      actionBtn.disabled = false;
      if (isAuto) {
        actionBtn.innerText = "⚡ Проверить выполнение";
        actionBtn.onclick = function () { checkTgTask(activeTaskId); };
      } else {
        actionBtn.innerText = "📤 Отправить отчет";
        actionBtn.onclick = function () { submitReviewProof(activeTaskId); };
      }
    }

    openModal("m-task-details");
  }

  async function checkTgTask(taskId) {
    if (!ensureTelegramOrExplain()) return;

    var btn = el("td-action-btn");
    if (btn) { btn.disabled = true; btn.innerText = "⏳ Проверка..."; }

    try {
      await apiPost("/api/task/submit", { task_id: String(taskId) });
      await loadData();
      render();
      closeModal();
      tgAlert("✅ Проверка отправлена. Если бот увидел подписку — начисление сразу.");
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerText = "⚡ Проверить выполнение"; }
      tgAlert("Ошибка: " + (e && e.message ? e.message : "unknown"));
    }
  }

  async function submitReviewProof(taskId) {
    if (!ensureTelegramOrExplain()) return;

    var uname = (el("p-username") ? el("p-username").value : "").trim();
    if (!uname) return tgAlert("Укажи ник/имя.");

    var btn = el("td-action-btn");
    if (btn) { btn.disabled = true; btn.innerText = "⏳ Отправка..."; }

    try {
      await apiPost("/api/task/submit", {
        task_id: String(taskId),
        proof_text: uname,
        proof_url: ""
      });
      await loadData();
      render();
      closeModal();
      tgAlert("✅ Отчет отправлен. Жди модерацию.");
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerText = "📤 Отправить отчет"; }
      tgAlert("Ошибка: " + (e && e.message ? e.message : "unknown"));
    }
  }

  // copy link
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
  function renderReferrals() {
    var u = getTgUser();
    var uid = (u && u.id) ? u.id : "12345";
    var invite = "t.me/ReviewCashBot?start=" + uid;
    if (el("invite-link")) el("invite-link").innerText = invite;
    if (el("ref-count")) el("ref-count").innerText = "0";
    if (el("ref-earn")) el("ref-earn").innerText = "0 ₽";
  }

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
  // Payments
  // -----------------------------
  window.processPay = function (method) {
    var val = Number(el("sum-input") ? (el("sum-input").value || 0) : 0);
    if (!isFinite(val) || val < 300) return tgAlert("Минимум 300 ₽");

    if (method === "pay_stars") {
      if (!ensureTelegramOrExplain()) return;
      try {
        tg.sendData(JSON.stringify({ action: "pay_stars", amount: String(val) }));
      } catch (e) {
        tgAlert("Не удалось отправить данные. Открой Mini App из бота.");
      }
      return;
    }

    tgAlert("Неизвестный метод: " + method);
  };

  var tbankAmount = 0;

  window.openTBankPay = function () {
    var val = Number(el("sum-input") ? (el("sum-input").value || 0) : 0);
    if (!isFinite(val) || val < 300) return tgAlert("Минимум 300 ₽");

    tbankAmount = val;
    if (el("tb-amount-display")) el("tb-amount-display").innerText = String(val) + " ₽";

    var u = getTgUser();
    var uId = (u && u.id) ? u.id : "TEST";
    var rand = Math.floor(1000 + Math.random() * 9000);
    var code = "PAY-" + uId + "-" + rand;
    if (el("tb-code")) el("tb-code").innerText = code;

    closeModal();
    openModal("m-pay-tbank");
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
    if (!sender) return tgAlert("Укажи имя отправителя");
    if (!code) return tgAlert("Нет кода");

    try {
      await apiPost("/api/tbank/claim", { amount_rub: Number(tbankAmount), sender: sender, code: code });
      tgAlert("✅ Заявка отправлена. Админ подтвердит вручную.");
      closeModal();
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
    var amt = Number(el("w-amount") ? (el("w-amount").value || 0) : 0);

    if (!details) return tgAlert("Укажи реквизиты");
    if (!isFinite(amt) || amt < 300) return tgAlert("Минимум 300 ₽");

    try {
      await apiPost("/api/withdraw/create", { amount_rub: amt, details: details });
      tgAlert("✅ Заявка создана");
      var w = await apiPost("/api/withdraw/list", {});
      state.withdrawals = w.withdrawals || [];
      renderWithdrawals();
    } catch (e) {
      tgAlert("Ошибка вывода: " + (e && e.message ? e.message : "unknown"));
    }
  };

  // -----------------------------
  // Boot
  // -----------------------------
  async function initApp() {
    try { tg.ready(); tg.expand(); } catch (e) {}

    populateTgTypes();
    setupProfileUI();
    installLinkWatcher();
    window.recalc();

    try {
      await loadData();
    } catch (e) {
      tgAlert("Ошибка загрузки: " + (e && e.message ? e.message : "unknown") +
        "\n\nЕсли видишь 401 — открой Mini App из кнопки этого же бота.");
    }

    render();

    var loader = el("loader");
    if (loader) {
      setTimeout(function () {
        try { loader.remove(); } catch (e) { loader.style.display = "none"; }
      }, 250);
    }
  }

  // expose handleTask
  window.handleTask = function (_btn, owner, id) {
    // compatibility with older html (calls handleTask(btn, owner, id))
    var task = state.tasks.find(function (t) { return String(t.id) === String(id); });
    if (task) handleTask(task);
  };

  document.addEventListener("DOMContentLoaded", function () {
    initApp().catch(function (e) {
      console.error(e);
      tgAlert("Fatal init error: " + (e && e.message ? e.message : e));
    });
  });

})();
