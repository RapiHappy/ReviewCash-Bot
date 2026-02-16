/* ReviewCash main.js (FULL)
   Works with backend endpoints:
   /api/sync
   /api/task/create
   /api/task/submit
   /api/proof/upload
   /api/withdraw/create
   /api/withdraw/list
   /api/pay/stars/link
   /api/tbank/claim
   /api/ops/list
   /api/referrals
   /api/admin/*
*/

(() => {
  // ---------------------------
  // Helpers
  // ---------------------------
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const PLACEHOLDER_AVATAR =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

  function setText(id, txt) {
    const el = $(id);
    if (el) el.textContent = txt == null ? "" : String(txt);
  }

  function setHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  function show(el) {
    if (!el) return;
    el.classList.remove("hidden");
    el.style.display = "";
  }

  function hide(el) {
    if (!el) return;
    el.classList.add("hidden");
    el.style.display = "none";
  }

  function toast(msg) {
    try {
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.showPopup) {
        Telegram.WebApp.showPopup({ message: String(msg) });
      } else {
        alert(String(msg));
      }
    } catch {
      alert(String(msg));
    }
  }

  function formatRub(x) {
    const n = Number(x || 0);
    if (Number.isNaN(n)) return "0 ₽";
    return `${Math.round(n)} ₽`;
  }

  function safeUrl(u) {
    try {
      const url = new URL(u);
      return url.toString();
    } catch {
      return "";
    }
  }

  function parseTgChatFromLink(link) {
    // Accept:
    // https://t.me/username
    // https://t.me/username/123
    // t.me/username
    // @username
    const s = String(link || "").trim();
    if (!s) return "";
    if (s.startsWith("@")) return s;

    let norm = s;
    if (norm.startsWith("t.me/")) norm = "https://" + norm;
    if (!/^https?:\/\//i.test(norm)) return "";

    try {
      const u = new URL(norm);
      if (!/t\.me$/i.test(u.hostname) && !/telegram\.me$/i.test(u.hostname)) return "";
      const parts = u.pathname.split("/").filter(Boolean);
      if (!parts.length) return "";
      const username = parts[0];

      // invite links like /joinchat/... or /+...
      if (username === "joinchat" || username.startsWith("+")) return "";

      // OK
      return "@" + username;
    } catch {
      return "";
    }
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(String(text));
      return true;
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = String(text);
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        document.body.removeChild(ta);
        return true;
      } catch {
        document.body.removeChild(ta);
        return false;
      }
    }
  }

  // ---------------------------
  // API base
  // ---------------------------
  function getApiBase() {
    const meta = document.querySelector('meta[name="api-base"]');
    const content = meta ? (meta.getAttribute("content") || "").trim() : "";
    if (!content) return location.origin;
    return content.replace(/\/+$/, "");
  }

  const API_BASE = getApiBase();

  function getInitData() {
    try {
      if (window.Telegram && Telegram.WebApp) return Telegram.WebApp.initData || "";
    } catch {}
    return "";
  }

  async function apiPost(path, body, opts = {}) {
    const url = API_BASE + path;
    const headers = opts.headers || {};
    const initData = getInitData();

    // if you test outside Telegram: server can allow DISABLE_INITDATA=1
    if (initData) headers["X-Tg-InitData"] = initData;

    // default json
    if (!opts.raw) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: opts.raw ? body : JSON.stringify(body || {}),
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { ok: false, error: text || "Bad JSON" };
    }

    if (!res.ok) {
      const err = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new Error(err);
    }
    return data;
  }

  // ---------------------------
  // State
  // ---------------------------
  const state = {
    filter: "all",
    user: null,
    balance: null,
    tasks: [],
    currentTask: null,
    isAdmin: false,
    adminCounts: { proofs: 0, withdrawals: 0, tbank: 0 },
    deviceHash: "",
    referrerId: null,
    tbank: { amount: 0, code: "", sender: "" },
  };

  function ensureDeviceHash() {
    try {
      let v = localStorage.getItem("rc_device_hash");
      if (!v) {
        v = "dev_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
        localStorage.setItem("rc_device_hash", v);
      }
      state.deviceHash = v;
    } catch {
      state.deviceHash = "";
    }
  }

  function getStartReferrer() {
    try {
      const unsafe = Telegram?.WebApp?.initDataUnsafe;
      const sp = unsafe?.start_param;
      if (sp && /^\d+$/.test(String(sp))) return Number(sp);
    } catch {}
    return null;
  }

  // ---------------------------
  // UI: Tabs & Modals
  // ---------------------------
  window.showTab = async (tab) => {
    const views = {
      tasks: $("view-tasks"),
      friends: $("view-friends"),
      profile: $("view-profile"),
      history: $("view-history"),
    };
    Object.values(views).forEach(hide);
    show(views[tab]);

    // nav active
    ["tasks", "friends", "profile"].forEach((t) => {
      const el = $("tab-" + t);
      if (!el) return;
      if (t === tab) el.classList.add("active");
      else el.classList.remove("active");
    });

    if (tab === "profile") {
      await loadWithdrawalsMini();
      await loadAdminBadge();
    }
    if (tab === "friends") {
      await loadReferrals();
    }
  };

  window.openModal = (id) => {
    const el = $(id);
    if (!el) return;
    el.style.display = "flex";
    el.classList.remove("hidden");
    el.classList.add("active");
  };

  window.closeModal = () => {
    document.querySelectorAll(".overlay").forEach((ov) => {
      ov.classList.remove("active");
      ov.style.display = "none";
      ov.classList.add("hidden");
    });
  };

  // close overlay on outside click
  function bindOverlayClose() {
    document.querySelectorAll(".overlay").forEach((ov) => {
      ov.addEventListener("click", (e) => {
        if (e.target === ov) window.closeModal();
      });
    });
  }

  // ---------------------------
  // TG subtypes & pricing
  // (можешь поменять цены под себя)
  // ---------------------------
  const TG_SUBTYPES = [
    { id: "join_channel", title: "Подписка на канал", price: 10, kind: "join", desc: "Бот проверит подписку автоматически." },
    { id: "join_group", title: "Вступить в группу", price: 12, kind: "join", desc: "Бот проверит участие автоматически." },
    { id: "start_bot", title: "Запустить бота", price: 15, kind: "start", desc: "Проверка обычно вручную — но сейчас оставим авто-чек по чату." },
    { id: "react_post", title: "Реакция на пост", price: 6, kind: "reaction", desc: "Доказательство часто нужно вручную (скрин). Сейчас делаем вручную." },
    { id: "view_post", title: "Просмотр поста", price: 4, kind: "view", desc: "Обычно вручную. Сейчас делаем вручную." },
  ];

  function initTgSubtypeSelect() {
    const sel = $("t-tg-subtype");
    if (!sel) return;
    sel.innerHTML = "";
    TG_SUBTYPES.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.title} (${s.price}₽)`;
      sel.appendChild(opt);
    });
  }

  function getSelectedTgSubtype() {
    const sel = $("t-tg-subtype");
    const id = sel ? sel.value : TG_SUBTYPES[0].id;
    return TG_SUBTYPES.find((x) => x.id === id) || TG_SUBTYPES[0];
  }

  // ---------------------------
  // Calc total
  // ---------------------------
  window.recalc = () => {
    const type = ($("t-type")?.value || "tg").trim();
    const qty = Math.max(1, parseInt($("t-qty")?.value || "1", 10) || 1);
    const cur = ($("t-cur")?.value || "rub").trim();

    const tgWrap = $("tg-subtype-wrapper");
    const tgOpts = $("tg-options");

    let unitPrice = 0;
    let reward = 0;
    let checkType = "manual";
    let tgKind = null;
    let sub = null;

    if (type === "tg") {
      show(tgWrap);
      const st = getSelectedTgSubtype();
      sub = st.id;
      unitPrice = Number(st.price || 0);
      reward = unitPrice / 2;
      tgKind = st.kind;

      // авто-чек только для join задач, остальное вручную
      if (st.kind === "join") {
        checkType = "auto";
        show(tgOpts);
      } else {
        checkType = "manual";
        hide(tgOpts);
      }

      setText("tg-subtype-desc", st.desc || "");
    } else {
      hide(tgWrap);
      hide(tgOpts);

      const opt = $("t-type")?.selectedOptions?.[0];
      unitPrice = Number(opt?.getAttribute("data-p") || 0);
      if (!unitPrice) unitPrice = type === "ya" ? 120 : type === "gm" ? 75 : 0;
      reward = unitPrice / 2;
      checkType = "manual";
    }

    const total = unitPrice * qty;

    // UI only: if stars selected - still показываем ⭐, но backend работает в RUB
    const sign = cur === "star" ? "⭐" : "₽";
    setText("t-total", `${Math.round(total)} ${sign}`);

    // Save computed
    state._create = { type, qty, cur, unitPrice, total, reward, checkType, tgKind, sub };
  };

  // ---------------------------
  // Sync & render
  // ---------------------------
  async function syncAll() {
    try {
      const loader = $("loader");
      if (loader) loader.style.display = "flex";

      const body = {
        device_hash: state.deviceHash,
        device_id: state.deviceHash,
      };

      // send referrer only once (first sync)
      if (state.referrerId != null) body.referrer_id = state.referrerId;

      const data = await apiPost("/api/sync", body);

      if (!data.ok) throw new Error(data.error || "Sync error");

      state.user = data.user;
      state.balance = data.balance || {};
      state.tasks = Array.isArray(data.tasks) ? data.tasks : [];

      renderHeader();
      renderProfile();
      renderTasks();

      // referral link
      renderInvite();

      // admin badge attempt
      await loadAdminBadge();

      if (loader) loader.style.display = "none";
    } catch (e) {
      if (window.__showError) window.__showError("SYNC ERROR", e);
      else toast(e.message || String(e));
    }
  }

  function renderHeader() {
    const u = state.user || {};
    const fullName =
      (u.first_name || "").trim() ||
      (u.username ? "@" + u.username : "") ||
      String(u.user_id || "User");

    setText("header-name", fullName);

    const a1 = $("header-avatar");
    const a2 = $("u-pic");
    const url = u.photo_url ? String(u.photo_url) : "";
    if (a1) a1.src = url || PLACEHOLDER_AVATAR;
    if (a2) a2.src = url || PLACEHOLDER_AVATAR;

    // avoid triggering resource error on empty src
    if (a1 && !a1.getAttribute("src")) a1.src = PLACEHOLDER_AVATAR;
    if (a2 && !a2.getAttribute("src")) a2.src = PLACEHOLDER_AVATAR;
  }

  function renderProfile() {
    const u = state.user || {};
    const b = state.balance || {};

    const name =
      (u.first_name || "").trim() ||
      (u.username ? "@" + u.username : "") ||
      String(u.user_id || "User");

    setText("u-name", name);
    setText("u-bal-rub", formatRub(b.rub_balance));
    setText("u-bal-star", `${Math.round(Number(b.stars_balance || 0))} ⭐`);

    const xp = Math.max(0, parseInt(b.xp || 0, 10) || 0);
    const lvl = Math.max(1, parseInt(b.level || 1, 10) || 1);

    setText("u-lvl-badge", `LVL ${lvl}`);

    const cur = xp;
    const next = lvl * 100; // если XP_PER_LEVEL=100, UI совпадёт
    setText("u-xp-cur", `${cur} XP`);
    setText("u-xp-next", `${next} XP`);

    const fill = $("u-xp-fill");
    if (fill) {
      const prevLevelXp = (lvl - 1) * 100;
      const inLevel = Math.max(0, cur - prevLevelXp);
      const pct = Math.max(0, Math.min(100, (inLevel / 100) * 100));
      fill.style.width = pct + "%";
    }
  }

  function badgeForTask(t) {
    if (!t) return { text: "TASK", cls: "st-pending" };
    const type = t.type;
    if (type === "tg") return { text: "TELEGRAM", cls: "st-pending" };
    if (type === "ya") return { text: "YANDEX", cls: "st-pending" };
    if (type === "gm") return { text: "GOOGLE", cls: "st-pending" };
    return { text: "TASK", cls: "st-pending" };
  }

  function iconForTask(t) {
    if (!t) return "✅";
    if (t.type === "tg") return "✈️";
    if (t.type === "ya") return "📍";
    if (t.type === "gm") return "🌍";
    return "✅";
  }

  function renderTasks() {
    const list = $("tasks-list");
    if (!list) return;

    const uid = Number(state.user?.user_id || 0);
    const tasks = (state.tasks || []).filter((t) => {
      if (state.filter === "my") return Number(t.owner_id || 0) === uid;
      return true;
    });

    if (!tasks.length) {
      list.innerHTML = `<div class="card" style="text-align:center; opacity:0.7;">Заданий пока нет</div>`;
      return;
    }

    list.innerHTML = tasks
      .map((t) => {
        const reward = Number(t.reward_rub || 0);
        const left = Number(t.qty_left || 0);
        const total = Number(t.qty_total || 0);
        const pct = total > 0 ? Math.round(((total - left) / total) * 100) : 0;

        const b = badgeForTask(t);

        return `
          <div class="card" style="cursor:pointer;" data-task-id="${t.id}">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
              <div style="flex:1;">
                <div class="status-badge ${b.cls}" style="display:inline-block; margin-bottom:8px;">${b.text}</div>
                <div style="font-size:16px; font-weight:900; margin-bottom:4px;">${escapeHtml(t.title || "Задание")}</div>
                <div style="color:var(--text-dim); font-size:12px; margin-bottom:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                  ${escapeHtml(t.target_url || "")}
                </div>
                <div style="display:flex; gap:10px; align-items:center;">
                  <div style="font-weight:900; color:var(--accent-green);">+${reward} ₽</div>
                  <div style="font-size:12px; color:var(--text-dim);">Осталось: ${left}/${total}</div>
                </div>
                <div style="margin-top:10px; height:8px; background:rgba(255,255,255,0.06); border-radius:10px; overflow:hidden;">
                  <div style="height:100%; width:${pct}%; background:rgba(0,234,255,0.6);"></div>
                </div>
              </div>
              <div class="brand-box" style="width:52px; height:52px; font-size:26px;">${iconForTask(t)}</div>
            </div>
          </div>
        `;
      })
      .join("");

    // bind click
    list.querySelectorAll("[data-task-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-task-id");
        const t = (state.tasks || []).find((x) => String(x.id) === String(id));
        if (t) openTaskDetails(t);
      });
    });
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  window.setFilter = (f) => {
    state.filter = f === "my" ? "my" : "all";
    const fa = $("f-all");
    const fm = $("f-my");
    if (fa) fa.classList.toggle("active", state.filter === "all");
    if (fm) fm.classList.toggle("active", state.filter === "my");
    renderTasks();
  };

  // ---------------------------
  // Task details modal
  // ---------------------------
  function openTaskDetails(task) {
    state.currentTask = task;

    const b = badgeForTask(task);
    const reward = Number(task.reward_rub || 0);

    const tdBadge = $("td-type-badge");
    if (tdBadge) {
      tdBadge.textContent = b.text;
      tdBadge.className = "status-badge " + b.cls;
      tdBadge.style.display = "inline-block";
    }

    setText("td-title", task.title || "Задание");
    setText("td-reward", `+${reward} ₽`);

    const icon = $("td-icon");
    if (icon) icon.textContent = iconForTask(task);

    const link = task.target_url || "";
    setText("td-link", link || "—");
    const linkBtn = $("td-link-btn");
    if (linkBtn) {
      if (link) {
        linkBtn.href = link;
        linkBtn.style.display = "flex";
      } else {
        linkBtn.href = "#";
        linkBtn.style.display = "none";
      }
    }

    setText("td-text", task.instructions || "Выполните задание и отправьте отчёт.");

    // proof area
    const manual = $("proof-manual");
    const auto = $("proof-auto");
    const btn = $("td-action-btn");

    // reset file input
    const file = $("p-file");
    const fn = $("p-filename");
    const pu = $("p-username");
    if (file) file.value = "";
    if (fn) fn.textContent = "📷 Прикрепить скриншот";
    if (pu) pu.value = "";

    const isAuto = task.type === "tg" && String(task.check_type || "") === "auto";
    if (isAuto) {
      hide(manual);
      show(auto);
      if (btn) {
        btn.textContent = "✅ Проверить выполнение";
        btn.disabled = false;
        btn.onclick = submitAutoTask;
      }
    } else {
      show(manual);
      hide(auto);
      if (btn) {
        btn.textContent = "📨 Отправить на проверку";
        btn.disabled = true; // пока нет файла
        btn.onclick = submitManualTask;
      }
    }

    window.openModal("m-task-details");
  }

  window.copyLink = async () => {
    const t = state.currentTask;
    const link = t?.target_url || "";
    if (!link) return toast("Нет ссылки");
    const ok = await copyToClipboard(link);
    toast(ok ? "Ссылка скопирована" : "Не удалось скопировать");
  };

  window.updateFileName = (input) => {
    const f = input?.files?.[0];
    const fn = $("p-filename");
    if (fn) fn.textContent = f ? `✅ ${f.name}` : "📷 Прикрепить скриншот";

    const btn = $("td-action-btn");
    if (btn) btn.disabled = !f; // без изображения нельзя отправить
  };

  async function uploadProofFile(file) {
    const fd = new FormData();
    fd.append("file", file);

    // raw multipart
    const initData = getInitData();
    const headers = {};
    if (initData) headers["X-Tg-InitData"] = initData;

    const res = await fetch(API_BASE + "/api/proof/upload", {
      method: "POST",
      headers,
      body: fd,
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { ok: false, error: text || "Bad JSON" };
    }

    if (!res.ok) throw new Error(data?.error || `Upload HTTP ${res.status}`);
    if (!data?.ok || !data?.url) throw new Error(data?.error || "Upload failed");
    return data.url;
  }

  async function submitAutoTask() {
    try {
      const t = state.currentTask;
      if (!t) return;
      const btn = $("td-action-btn");
      if (btn) btn.disabled = true;

      const res = await apiPost("/api/task/submit", {
        task_id: t.id,
        proof_text: "AUTO_CHECK",
        proof_url: null,
      });

      if (res.status === "paid") toast(`✅ Выполнено! +${Math.round(res.earned || 0)} ₽`);
      else toast("✅ Отправлено");

      window.closeModal();
      await syncAll();
    } catch (e) {
      toast(e.message || String(e));
    } finally {
      const btn = $("td-action-btn");
      if (btn) btn.disabled = false;
    }
  }

  async function submitManualTask() {
    try {
      const t = state.currentTask;
      if (!t) return;

      const fileInput = $("p-file");
      const f = fileInput?.files?.[0];
      if (!f) return toast("❌ Нужен скриншот доказательства");

      const uname = ($("p-username")?.value || "").trim();
      const proofText = uname ? `Имя/ник: ${uname}` : "Отчёт";

      const btn = $("td-action-btn");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "⏳ Загрузка...";
      }

      const url = await uploadProofFile(f);

      if (btn) btn.textContent = "⏳ Отправка...";
      await apiPost("/api/task/submit", {
        task_id: t.id,
        proof_text: proofText,
        proof_url: url,
      });

      toast("✅ Отправлено на модерацию");
      window.closeModal();
      await syncAll();
    } catch (e) {
      toast(e.message || String(e));
    } finally {
      const btn = $("td-action-btn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "📨 Отправить на проверку";
      }
    }
  }

  // ---------------------------
  // Create task
  // ---------------------------
  window.createTask = async () => {
    try {
      if (!state._create) window.recalc();
      const c = state._create || {};
      const type = c.type || "tg";
      const qty = Math.max(1, parseInt($("t-qty")?.value || "1", 10) || 1);

      const target = ($("t-target")?.value || "").trim();
      const safe = safeUrl(target);
      if (!safe) return toast("❌ Вставь нормальную ссылку (например https://t.me/username)");

      const text = ($("t-text")?.value || "").trim();

      let title = "";
      let tg_chat = null;

      if (type === "tg") {
        const st = getSelectedTgSubtype();
        title = `Telegram: ${st.title}`;
        tg_chat = parseTgChatFromLink(safe);
        if (!tg_chat) return toast("❌ Для Telegram нужно: https://t.me/username (без joinchat/инвайтов)");
      }
      if (type === "ya") title = "Яндекс Карты: Отзыв";
      if (type === "gm") title = "Google Maps: Отзыв";

      const unitPrice = Number(c.unitPrice || 0);
      const total = unitPrice * qty;
      const reward = Number(c.reward || 0);
      const check_type = String(c.checkType || "manual");
      const tg_kind = c.tgKind || null;
      const sub_type = c.sub || null;

      // Важно: backend списывает RUB. Если выбрано ⭐ — просто показываем в UI, но по факту это рубли.
      if (($("t-cur")?.value || "rub") === "star") {
        toast("⚠️ Задания сейчас оплачиваются рублями (RUB баланс). Stars — только пополнение.");
      }

      const res = await apiPost("/api/task/create", {
        type,
        title,
        target_url: safe,
        instructions: text,
        reward_rub: reward,           // сколько получит исполнитель
        cost_rub: total,              // сколько спишем у владельца
        qty_total: qty,
        check_type: check_type,
        tg_chat: tg_chat,
        tg_kind: tg_kind,
        sub_type: sub_type,
      });

      if (!res.ok) throw new Error(res.error || "Не удалось создать");
      toast("✅ Задание создано!");
      window.closeModal();
      await syncAll();
    } catch (e) {
      toast(e.message || String(e));
    }
  };

  // ---------------------------
  // Topup: Stars & T-Bank
  // ---------------------------
  function getTopupAmount() {
    const v = $("sum-input")?.value;
    const n = Number(String(v || "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }

  window.processPay = async (action) => {
    try {
      if (action !== "pay_stars") return;
      const amount = getTopupAmount();
      if (amount < 300) return toast("Минимальная сумма: 300 ₽");

      const res = await apiPost("/api/pay/stars/link", { amount_rub: amount });
      if (!res.ok) throw new Error(res.error || "Stars link error");

      // ВАЖНО: баланс придёт только после успешной оплаты (successful_payment).
      if (res.invoice_link && Telegram?.WebApp?.openInvoice) {
        Telegram.WebApp.openInvoice(res.invoice_link, async (status) => {
          // status: paid/cancelled/failed/pending
          if (status === "paid") {
            toast("✅ Оплата прошла! Обновляю баланс...");
            await sleep(800);
            await syncAll();
          } else if (status === "cancelled") {
            toast("Оплата отменена");
          } else {
            toast("Статус: " + status);
          }
        });
      } else {
        toast("Инвойс отправлен в чат. Оплати сообщение-инвойс.");
      }
    } catch (e) {
      toast(e.message || String(e));
    }
  };

  window.openTBankPay = () => {
    const amount = getTopupAmount();
    if (amount < 300) return toast("Минимальная сумма: 300 ₽");

    // generate code
    const code = "RC" + Math.random().toString(16).slice(2, 8).toUpperCase();

    state.tbank.amount = amount;
    state.tbank.code = code;

    setText("tb-amount-display", `${Math.round(amount)} ₽`);
    setText("tb-code", code);
    $("tb-sender").value = "";

    window.openModal("m-pay-tbank");
  };

  window.copyCode = async () => {
    const ok = await copyToClipboard(state.tbank.code || "");
    toast(ok ? "Код скопирован" : "Не удалось скопировать");
  };

  window.confirmTBank = async () => {
    try {
      const sender = ($("tb-sender")?.value || "").trim();
      if (!sender) return toast("Укажи имя отправителя");
      const amount = Number(state.tbank.amount || 0);
      const code = String(state.tbank.code || "").trim();
      if (!amount || !code) return toast("Нет данных платежа");

      await apiPost("/api/tbank/claim", {
        amount_rub: amount,
        sender: sender,
        code: code,
      });

      toast("✅ Заявка отправлена. Ожидай подтверждение админом.");
      window.closeModal();
      await syncAll();
    } catch (e) {
      toast(e.message || String(e));
    }
  };

  // ---------------------------
  // Withdraw
  // ---------------------------
  async function loadWithdrawalsMini() {
    try {
      const res = await apiPost("/api/withdraw/list", {});
      if (!res.ok) return;
      renderWithdrawList(res.withdrawals || []);
    } catch {
      // ignore
    }
  }

  function renderWithdrawList(rows) {
    const box = $("withdrawals-list");
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = `<div style="opacity:0.6; font-size:12px;">Заявок пока нет</div>`;
      return;
    }
    box.innerHTML = rows
      .map((w) => {
        const st = String(w.status || "pending");
        const stEmoji = st === "paid" ? "✅" : st === "rejected" ? "❌" : "⏳";
        return `
          <div class="card" style="margin:0; padding:12px;">
            <div style="display:flex; justify-content:space-between; gap:10px;">
              <div>
                <div style="font-weight:900;">${stEmoji} ${Math.round(Number(w.amount_rub || 0))} ₽</div>
                <div style="opacity:0.7; font-size:12px; margin-top:2px;">${escapeHtml(w.details || "")}</div>
              </div>
              <div style="opacity:0.6; font-size:11px;">${escapeHtml((w.created_at || "").slice(0, 16).replace("T", " "))}</div>
            </div>
          </div>
        `;
      })
      .join("");
  }

  window.requestWithdraw = async () => {
    try {
      const details = ($("w-details")?.value || "").trim();
      const amount = Number(($("w-amount")?.value || "").replace(",", "."));
      if (!details) return toast("Укажи реквизиты");
      if (!amount || amount < 300) return toast("Минимум 300₽");

      const res = await apiPost("/api/withdraw/create", { details, amount_rub: amount });
      if (!res.ok) throw new Error(res.error || "Withdraw error");

      toast("✅ Заявка создана");
      await loadWithdrawalsMini();
      await syncAll();
    } catch (e) {
      toast(e.message || String(e));
    }
  };

  // ---------------------------
  // History
  // ---------------------------
  window.showHistory = async () => {
    try {
      showTab("history");
      setHTML("history-list", `<div class="card" style="padding:16px;">⏳ Загрузка...</div>`);
      const res = await apiPost("/api/ops/list", {});
      const ops = res.operations || [];
      renderHistory(ops);
    } catch (e) {
      setHTML("history-list", `<div class="card" style="padding:16px; opacity:0.7;">Ошибка: ${escapeHtml(e.message || String(e))}</div>`);
    }
  };

  window.closeHistory = () => showTab("profile");

  function renderHistory(ops) {
    const box = $("history-list");
    if (!box) return;
    if (!ops.length) {
      box.innerHTML = `<div class="menu-item" style="margin:0;">История пуста</div>`;
      return;
    }

    box.innerHTML = ops
      .map((o) => {
        if (o.kind === "payment") {
          const st = String(o.status || "");
          const icon = st === "paid" ? "✅" : st === "rejected" ? "❌" : st === "failed" ? "⚠️" : "⏳";
          const p = String(o.provider || "");
          return `
            <div class="menu-item" style="margin:0;">
              <div>${icon} Пополнение (${escapeHtml(p)})</div>
              <div style="opacity:0.7;">${Math.round(Number(o.amount_rub || 0))} ₽</div>
            </div>
          `;
        } else {
          const st = String(o.status || "");
          const icon = st === "paid" ? "✅" : st === "rejected" ? "❌" : "⏳";
          return `
            <div class="menu-item" style="margin:0;">
              <div>${icon} Вывод</div>
              <div style="opacity:0.7;">${Math.round(Number(o.amount_rub || 0))} ₽</div>
            </div>
          `;
        }
      })
      .join("");
  }

  // ---------------------------
  // Friends / Referral
  // ---------------------------
  function renderInvite() {
    const uid = state.user?.user_id;
    if (!uid) return;
    const link = `t.me/ReviewCashBot?start=${uid}`;
    setText("invite-link", link);
  }

  window.copyInviteLink = async () => {
    const t = $("invite-link")?.textContent || "";
    const ok = await copyToClipboard(t);
    toast(ok ? "Скопировано" : "Не удалось");
  };

  window.shareInvite = () => {
    const t = $("invite-link")?.textContent || "";
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent("https://" + t)}&text=${encodeURIComponent("Зарабатывай в ReviewCash:")}`;
    if (Telegram?.WebApp?.openTelegramLink) Telegram.WebApp.openTelegramLink(shareUrl);
    else window.open(shareUrl, "_blank");
  };

  async function loadReferrals() {
    try {
      const res = await apiPost("/api/referrals", {});
      if (!res.ok) return;
      setText("ref-count", res.count || 0);
      setText("ref-earn", `${Math.round(Number(res.earned_rub || 0))} ₽`);
    } catch {
      // ignore
    }
  }

  // ---------------------------
  // Admin panel
  // ---------------------------
  async function loadAdminBadge() {
    const card = $("admin-panel-card");
    const badge = $("admin-badge");
    if (!card) return;

    try {
      const res = await apiPost("/api/admin/summary", {});
      if (!res.ok) throw new Error(res.error || "admin");
      state.isAdmin = true;
      state.adminCounts = res.counts || { proofs: 0, withdrawals: 0, tbank: 0 };

      const total =
        Number(state.adminCounts.proofs || 0) +
        Number(state.adminCounts.withdrawals || 0) +
        Number(state.adminCounts.tbank || 0);

      card.style.display = "block";
      if (badge) {
        badge.textContent = String(total);
        badge.style.opacity = total > 0 ? "1" : "0.2";
      }
    } catch {
      state.isAdmin = false;
      card.style.display = "none";
    }
  }

  window.openAdminPanel = async () => {
    if (!state.isAdmin) return toast("Нет доступа");
    window.openModal("m-admin");
    await switchAdminTab("proofs");
  };

  window.switchAdminTab = async (tab) => {
    // tabs active
    ["proofs", "withdrawals", "tbank"].forEach((t) => {
      $("at-" + t)?.classList.toggle("active", t === tab);
    });

    hide($("admin-view-proofs"));
    hide($("admin-view-withdrawals"));
    hide($("admin-view-tbank"));

    if (tab === "proofs") {
      show($("admin-view-proofs"));
      await loadAdminProofs();
    } else if (tab === "withdrawals") {
      show($("admin-view-withdrawals"));
      await loadAdminWithdrawals();
    } else {
      show($("admin-view-tbank"));
      await loadAdminTbank();
    }
  };

  async function loadAdminProofs() {
    const list = $("admin-list");
    if (!list) return;
    list.innerHTML = `<div class="card" style="padding:14px;">⏳ Загрузка...</div>`;

    try {
      const res = await apiPost("/api/admin/proof/list", {});
      const rows = res.proofs || [];

      if (!rows.length) {
        list.innerHTML = `<div class="card" style="padding:14px; opacity:0.7;">Нет отчётов</div>`;
        return;
      }

      list.innerHTML = rows
        .map((p) => {
          const task = p.task || {};
          const img = p.proof_url ? `
            <div style="margin-top:10px;">
              <img src="${escapeHtml(p.proof_url)}" style="width:100%; border-radius:14px; border:1px solid rgba(255,255,255,0.12);" />
            </div>` : "";

          return `
            <div class="card" style="padding:14px;">
              <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                <div style="flex:1;">
                  <div style="font-weight:900; font-size:14px;">${escapeHtml(task.title || "Задание")}</div>
                  <div style="opacity:0.7; font-size:12px; margin-top:4px;">User: ${escapeHtml(p.user_id)}</div>
                  <div style="opacity:0.7; font-size:12px; margin-top:4px;">
                    Ссылка: <a href="${escapeHtml(task.target_url || "#")}" target="_blank" style="color:var(--accent-cyan);">открыть</a>
                  </div>
                  <div style="opacity:0.8; font-size:12px; margin-top:8px; white-space:pre-wrap;">${escapeHtml(p.proof_text || "")}</div>
                  ${img}
                </div>
              </div>

              <div style="display:flex; gap:10px; margin-top:12px;">
                <button class="btn btn-main" style="flex:1;" data-approve-proof="${p.id}">✅ Принять</button>
                <button class="btn btn-secondary" style="flex:1;" data-reject-proof="${p.id}">❌ Отклонить</button>
              </div>
            </div>
          `;
        })
        .join("");

      list.querySelectorAll("[data-approve-proof]").forEach((b) =>
        b.addEventListener("click", () => decideProof(b.getAttribute("data-approve-proof"), true))
      );
      list.querySelectorAll("[data-reject-proof]").forEach((b) =>
        b.addEventListener("click", () => decideProof(b.getAttribute("data-reject-proof"), false))
      );
    } catch (e) {
      list.innerHTML = `<div class="card" style="padding:14px; opacity:0.7;">Ошибка: ${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  async function decideProof(proofId, approved) {
    try {
      await apiPost("/api/admin/proof/decision", { proof_id: proofId, approved });
      toast(approved ? "✅ Принято" : "❌ Отклонено");
      await loadAdminProofs();
      await loadAdminBadge();
      await syncAll();
    } catch (e) {
      toast(e.message || String(e));
    }
  }

  async function loadAdminWithdrawals() {
    const list = $("admin-withdraw-list");
    if (!list) return;
    list.innerHTML = `<div class="card" style="padding:14px;">⏳ Загрузка...</div>`;

    try {
      const res = await apiPost("/api/admin/withdraw/list", {});
      const rows = res.withdrawals || [];

      if (!rows.length) {
        list.innerHTML = `<div class="card" style="padding:14px; opacity:0.7;">Нет заявок</div>`;
        return;
      }

      list.innerHTML = rows
        .map((w) => {
          const st = String(w.status || "pending");
          return `
            <div class="card" style="padding:14px;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
                <div style="flex:1;">
                  <div style="font-weight:900;">${Math.round(Number(w.amount_rub || 0))} ₽</div>
                  <div style="opacity:0.7; font-size:12px; margin-top:4px;">User: ${escapeHtml(w.user_id)}</div>
                  <div style="opacity:0.85; font-size:12px; margin-top:6px; white-space:pre-wrap;">${escapeHtml(w.details || "")}</div>
                  <div style="opacity:0.6; font-size:11px; margin-top:6px;">${escapeHtml((w.created_at || "").slice(0, 16).replace("T"," "))}</div>
                </div>
              </div>

              ${st === "pending" ? `
              <div style="display:flex; gap:10px; margin-top:12px;">
                <button class="btn btn-main" style="flex:1;" data-approve-wd="${w.id}">✅ Выплачено</button>
                <button class="btn btn-secondary" style="flex:1;" data-reject-wd="${w.id}">❌ Отклонить</button>
              </div>` : `
              <div style="margin-top:10px; opacity:0.7; font-size:12px;">Статус: ${escapeHtml(st)}</div>
              `}
            </div>
          `;
        })
        .join("");

      list.querySelectorAll("[data-approve-wd]").forEach((b) =>
        b.addEventListener("click", () => decideWithdraw(b.getAttribute("data-approve-wd"), true))
      );
      list.querySelectorAll("[data-reject-wd]").forEach((b) =>
        b.addEventListener("click", () => decideWithdraw(b.getAttribute("data-reject-wd"), false))
      );
    } catch (e) {
      list.innerHTML = `<div class="card" style="padding:14px; opacity:0.7;">Ошибка: ${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  async function decideWithdraw(withdrawId, approved) {
    try {
      await apiPost("/api/admin/withdraw/decision", { withdraw_id: withdrawId, approved });
      toast(approved ? "✅ Отмечено как выплачено" : "❌ Отклонено");
      await loadAdminWithdrawals();
      await loadAdminBadge();
      await syncAll();
    } catch (e) {
      toast(e.message || String(e));
    }
  }

  async function loadAdminTbank() {
    const list = $("admin-tbank-list");
    if (!list) return;
    list.innerHTML = `<div class="card" style="padding:14px;">⏳ Загрузка...</div>`;

    try {
      const res = await apiPost("/api/admin/tbank/list", {});
      const rows = res.tbank || [];

      if (!rows.length) {
        list.innerHTML = `<div class="card" style="padding:14px; opacity:0.7;">Нет заявок</div>`;
        return;
      }

      list.innerHTML = rows
        .map((p) => {
          const meta = p.meta || {};
          return `
            <div class="card" style="padding:14px;">
              <div style="font-weight:900;">${Math.round(Number(p.amount_rub || 0))} ₽</div>
              <div style="opacity:0.7; font-size:12px; margin-top:4px;">User: ${escapeHtml(p.user_id)}</div>
              <div style="opacity:0.8; font-size:12px; margin-top:4px;">Code: <b>${escapeHtml(p.provider_ref || "")}</b></div>
              <div style="opacity:0.8; font-size:12px; margin-top:4px;">Sender: ${escapeHtml(meta.sender || "")}</div>

              <div style="display:flex; gap:10px; margin-top:12px;">
                <button class="btn btn-main" style="flex:1;" data-approve-tb="${p.id}">✅ Подтвердить</button>
                <button class="btn btn-secondary" style="flex:1;" data-reject-tb="${p.id}">❌ Отклонить</button>
              </div>
            </div>
          `;
        })
        .join("");

      list.querySelectorAll("[data-approve-tb]").forEach((b) =>
        b.addEventListener("click", () => decideTbank(b.getAttribute("data-approve-tb"), true))
      );
      list.querySelectorAll("[data-reject-tb]").forEach((b) =>
        b.addEventListener("click", () => decideTbank(b.getAttribute("data-reject-tb"), false))
      );
    } catch (e) {
      list.innerHTML = `<div class="card" style="padding:14px; opacity:0.7;">Ошибка: ${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  async function decideTbank(paymentId, approved) {
    try {
      await apiPost("/api/admin/tbank/decision", { payment_id: paymentId, approved });
      toast(approved ? "✅ Подтверждено" : "❌ Отклонено");
      await loadAdminTbank();
      await loadAdminBadge();
      await syncAll();
    } catch (e) {
      toast(e.message || String(e));
    }
  }

  // ---------------------------
  // Init
  // ---------------------------
  function initTelegram() {
    try {
      if (window.Telegram && Telegram.WebApp) {
        Telegram.WebApp.ready();
        Telegram.WebApp.expand();
      }
    } catch {}
  }

  function bindTaskListClicks() {
    // already bound per render
  }

  // expose for html inline handlers
  window.copyToClipboard = copyToClipboard; // optional

  async function boot() {
    initTelegram();
    bindOverlayClose();
    ensureDeviceHash();

    state.referrerId = getStartReferrer();

    // init tg subtype list
    initTgSubtypeSelect();

    // bind change handlers
    $("t-type")?.addEventListener("change", window.recalc);
    $("t-tg-subtype")?.addEventListener("change", window.recalc);
    $("t-qty")?.addEventListener("input", window.recalc);
    $("t-cur")?.addEventListener("change", window.recalc);

    // First calc
    window.recalc();

    // default view
    showTab("tasks");

    // sync
    await syncAll();
  }

  boot();
})();
