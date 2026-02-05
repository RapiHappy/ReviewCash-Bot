var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __read = (this && this.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
// Mock Telegram WebApp for non-Telegram environments
var MockTelegram = {
    WebApp: {
        expand: function () { return console.log('TG: Expanded'); },
        setHeaderColor: function (color) { return console.log('TG: Header Color', color); },
        showAlert: function (msg) { return alert(msg); },
        showConfirm: function (msg, cb) { var r = confirm(msg); if (cb)
            cb(r); },
        openTelegramLink: function (url) { return window.open(url, '_blank'); },
        sendData: function (data) {
            console.log('TG: sendData called with', data);
            alert('DEV MODE: Data sent to bot:\n' + data + '\n\nIn real app, this closes the window.');
        },
        ready: function () { return console.log('TG: Ready'); },
        initData: '',
        initDataUnsafe: {
            user: {
                id: 123456, // MOCK USER
                username: 'miniapp_user',
                first_name: 'Alex',
                last_name: 'Test',
                // photo_url intentionally left undefined to test fallback
            }
        }
    }
};
// HELPER: Get User Data Safely
function getTgUser() {
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user) {
        return window.Telegram.WebApp.initDataUnsafe.user;
    }
    return MockTelegram.WebApp.initDataUnsafe.user;
}
var tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : MockTelegram.WebApp;
// --- API LAYER (Mini App через БОТА: initData) ---
// --- API BASE ---
// GitHub Pages != backend domain. Set in index.html: <meta name="api-base" content="https://YOUR-BACKEND">
function getApiBase() {
    var meta = document.querySelector('meta[name="api-base"]');
    var v = meta ? meta.getAttribute('content') : '';
    if (v)
        return String(v).replace(/\/+$/, '');
    // optional: ?api=https%3A%2F%2Fyour-backend
    var qs = (window.location && window.location.search) ? window.location.search : '';
    var m = qs.match(/[?&]api=([^&]+)/);
    if (m && m[1])
        return decodeURIComponent(m[1]).replace(/\/+$/, '');
    // fallback: same-origin (works only if Mini App and backend are on same domain)
    return window.location.origin;
}
var API = getApiBase();
function tgInitData() {
    // Telegram передает строку initData (для проверки подписи на сервере)
    return (window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.initData === 'string')
        ? window.Telegram.WebApp.initData
        : "";
}
function getDeviceHash() {
    var v = localStorage.getItem("device_hash");
    if (!v) {
        v = "dev_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
        localStorage.setItem("device_hash", v);
    }
    return v;
}
function apiPost(path, data) {
    return __awaiter(this, void 0, void 0, function () {
        var res, j;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, fetch(API + path, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-Tg-InitData": tgInitData()
                        },
                        body: JSON.stringify(__assign(__assign({}, (data || {})), { device_hash: getDeviceHash() }))
                    })];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    j = _a.sent();
                    if (!res.ok || j.ok === false) {
                        throw new Error(j.error || ("HTTP " + res.status));
                    }
                    return [2 /*return*/, j];
            }
        });
    });
}
// Fallback storage (чтобы старые куски UI не падали в dev/браузере)
var miniappsAI = window.miniappsAI || {
    storage: {
        getItem: function (k) { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
            return [2 /*return*/, localStorage.getItem(k)];
        }); }); },
        setItem: function (k, v) { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
            return [2 /*return*/, localStorage.setItem(k, v)];
        }); }); }
    }
};
// --- CONFIGURATION ---
var ADMIN_IDS = [6482440657, 123456];
var ASSETS = {
    ya: 'https://www.google.com/s2/favicons?sz=64&domain=yandex.ru',
    gm: 'https://www.google.com/s2/favicons?sz=64&domain=google.com',
    tg: 'https://cdn-icons-png.flaticon.com/512/2111/2111646.png'
};
var TG_TASK_TYPES = {
    tg_sub: { label: 'Подписка на канал', cost: 30, reward: 15, icon: '📢', action: 'Подписаться' },
    tg_group: { label: 'Вступление в группу', cost: 25, reward: 12, icon: '👥', action: 'Вступить' },
    tg_react: { label: 'Просмотр + Реакция', cost: 10, reward: 5, icon: '❤️', action: 'Смотреть пост' },
    tg_poll: { label: 'Участие в опросе', cost: 15, reward: 7, icon: '📊', action: 'Голосовать' },
    tg_start: { label: 'Запуск бота /start', cost: 25, reward: 12, icon: '🤖', action: 'Запустить' },
    tg_msg: { label: 'Сообщение боту', cost: 15, reward: 7, icon: '✉️', action: 'Написать' },
    tg_mapp: { label: 'Открыть Mini App', cost: 40, reward: 20, icon: '📱', action: 'Открыть App' },
    tg_hold: { label: 'Подписка + 24ч', cost: 60, reward: 30, icon: '⏳', action: 'Подписаться' },
    tg_invite: { label: 'Инвайт друзей', cost: 100, reward: 50, icon: '🤝', action: 'Пригласить' },
};
// --- TASK LIMITS ---
var TASK_LIMITS = {
    ya: 3 * 24 * 60 * 60 * 1000, // 3 days
    gm: 1 * 24 * 60 * 60 * 1000 // 1 day
};
// INITIAL STATE
var state = {
    filter: 'all',
    user: {
        rub: 0,
        stars: 0,
        xp: 0,
        level: 1
    },
    tasks: [],
    moderation: [],
    history: [],
    ops: [],
    withdrawals: [],
    adminWithdrawals: [],
    referrals: {
        count: 0,
        earned: 0
    },
    limits: {} // Local cache of limits
};
var isLinkValid = false;
var linkCheckTimer = null;
var selectedProofFile = null;
var activeAdminTab = 'proofs';
// Initialization
function initApp() {
    return __awaiter(this, void 0, void 0, function () {
        var e_1, e_2, loader, targetInput;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (window.Telegram && window.Telegram.WebApp) {
                        if (window.Telegram.WebApp.ready)
                            window.Telegram.WebApp.ready();
                        if (window.Telegram.WebApp.expand)
                            window.Telegram.WebApp.expand();
                    }
                    else {
                        MockTelegram.WebApp.expand();
                    }
                    populateTgTypes();
                    setupProfileUI();
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, loadData()];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 4];
                case 3:
                    e_1 = _a.sent();
                    console.error('Data load error', e_1);
                    return [3 /*break*/, 4];
                case 4:
                    checkAdmin();
                    _a.label = 5;
                case 5:
                    _a.trys.push([5, 7, , 8]);
                    return [4 /*yield*/, loadAdminData()];
                case 6:
                    _a.sent();
                    return [3 /*break*/, 8];
                case 7:
                    e_2 = _a.sent();
                    console.error("Admin load error", e_2);
                    return [3 /*break*/, 8];
                case 8:
                    checkLevelUp(); // Check if initial level is correct
                    render();
                    updateAdminBadge();
                    loader = document.getElementById('loader');
                    if (loader) {
                        loader.classList.add('fade-out');
                        setTimeout(function () {
                            loader.remove();
                            document.querySelector('.app-container').classList.add('anim-active');
                        }, 300);
                    }
                    document.querySelectorAll('.overlay').forEach(function (overlay) {
                        overlay.addEventListener('click', function (e) {
                            if (e.target === overlay) {
                                closeModal();
                            }
                        });
                    });
                    targetInput = document.getElementById('t-target');
                    if (targetInput) {
                        targetInput.addEventListener('input', function (e) {
                            var val = e.target.value.trim();
                            var statusEl = document.getElementById('t-target-status');
                            clearTimeout(linkCheckTimer);
                            isLinkValid = false;
                            if (!val) {
                                statusEl.className = 'input-status';
                                statusEl.innerHTML = '';
                                return;
                            }
                            statusEl.className = 'input-status visible checking';
                            statusEl.innerHTML = '<span class="spin-icon">⏳</span> Проверка ссылки...';
                            linkCheckTimer = setTimeout(function () {
                                var isValid = /^https?:\/\/.+\..+/.test(val) || /^t\.me\/.+/.test(val) || /^[\w-]+\.+[\w-]+/.test(val);
                                statusEl.className = 'input-status visible ' + (isValid ? 'valid' : 'invalid');
                                if (isValid) {
                                    statusEl.innerHTML = '✅ Ссылка корректна';
                                    isLinkValid = true;
                                }
                                else {
                                    statusEl.innerHTML = '❌ Некорректная ссылка';
                                    isLinkValid = false;
                                }
                            }, 800);
                        });
                    }
                    // Initial recalc for modal
                    recalc();
                    return [2 /*return*/];
            }
        });
    });
}
document.addEventListener("DOMContentLoaded", function () {
    initApp().catch(console.error);
});
function populateTgTypes() {
    var sel = document.getElementById('t-tg-subtype');
    if (!sel)
        return;
    sel.innerHTML = '';
    Object.keys(TG_TASK_TYPES).forEach(function (k) {
        var t = TG_TASK_TYPES[k];
        var opt = document.createElement('option');
        opt.value = k;
        opt.textContent = "".concat(t.icon, " ").concat(t.label, " (").concat(t.cost, "\u20BD)");
        sel.appendChild(opt);
    });
}
function setupProfileUI() {
    try {
        var user = getTgUser();
        var headerAvatar_1 = document.getElementById('header-avatar');
        var profileAvatar_1 = document.getElementById('u-pic');
        var headerName = document.getElementById('header-name');
        var profileName = document.getElementById('u-name');
        var displayName = 'Гость';
        var seed_1 = 'G';
        if (user) {
            if (user.username)
                displayName = '@' + user.username;
            else if (user.first_name || user.last_name)
                displayName = "".concat(user.first_name || '', " ").concat(user.last_name || '').trim();
            else
                displayName = 'Пользователь';
            seed_1 = user.first_name || user.username || 'U';
        }
        var photoSrc = void 0;
        if (user && typeof user.photo_url === 'string' && user.photo_url.startsWith('http')) {
            photoSrc = user.photo_url;
        }
        else {
            photoSrc = "https://ui-avatars.com/api/?name=".concat(encodeURIComponent(seed_1), "&background=random&color=fff&size=128&bold=true");
        }
        if (headerName)
            headerName.innerText = displayName;
        if (profileName)
            profileName.innerText = displayName;
        if (headerAvatar_1) {
            headerAvatar_1.src = photoSrc;
            headerAvatar_1.onerror = function () { return headerAvatar_1.src = "https://ui-avatars.com/api/?name=".concat(encodeURIComponent(seed_1), "&background=random&color=fff&size=128&bold=true"); };
        }
        if (profileAvatar_1) {
            profileAvatar_1.src = photoSrc;
            profileAvatar_1.onerror = function () { return profileAvatar_1.src = "https://ui-avatars.com/api/?name=".concat(encodeURIComponent(seed_1), "&background=random&color=fff&size=128&bold=true"); };
        }
    }
    catch (e) {
        console.error('Profile Setup Error:', e);
    }
}
function checkAdmin() {
    var u = getTgUser();
    var adminPanel = document.getElementById('admin-panel-card');
    if (u && u.id && ADMIN_IDS.includes(Number(u.id))) {
        if (adminPanel)
            adminPanel.style.display = 'block';
    }
    else {
        if (adminPanel)
            adminPanel.style.display = 'none';
    }
}
function loadData() {
    return __awaiter(this, void 0, void 0, function () {
        var r, myId, w, e_3;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, apiPost("/api/sync", {})];
                case 1:
                    r = _b.sent();
                    // баланс
                    state.user.rub = Number((r.balance && r.balance.rub_balance) || 0);
                    state.user.stars = Number((r.balance && r.balance.stars_balance) || 0);
                    // (опционально) прогресс/левел, если сервер отдаёт
                    if (r.balance && typeof r.balance.xp !== 'undefined')
                        state.user.xp = Number(r.balance.xp || 0);
                    if (r.balance && typeof r.balance.level !== 'undefined')
                        state.user.level = Number(r.balance.level || 1);
                    myId = Number(((_a = getTgUser()) === null || _a === void 0 ? void 0 : _a.id) || 0);
                    state.tasks = (r.tasks || []).map(function (t) {
                        var ownerId = Number(t.owner_id || t.user_id || 0);
                        var owner = t.owner || (ownerId && myId && ownerId === myId ? 'me' : 'other');
                        return {
                            id: t.id,
                            type: t.type,
                            subType: t.sub_type || t.subType || null,
                            name: t.title || t.name || 'Задание',
                            price: Number(t.reward_rub || t.reward || t.price || 0),
                            owner: owner,
                            checkType: t.check_type || t.checkType || (t.type === 'tg' ? 'auto' : 'manual'),
                            target: t.target_url || t.target || '',
                            text: t.instructions || t.text || '',
                            qty: t.qty_total || t.qty || 1
                        };
                    });
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, apiPost("/api/withdraw/list", {})];
                case 3:
                    w = _b.sent();
                    state.withdrawals = w.withdrawals || [];
                    return [3 /*break*/, 5];
                case 4:
                    e_3 = _b.sent();
                    console.warn("withdraw list error", e_3);
                    state.withdrawals = state.withdrawals || [];
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// --- ADMIN DATA (очередь модерации/выводов) ---
function loadAdminData() {
    return __awaiter(this, void 0, void 0, function () {
        var u, p, proofs, e_4, w, withdrawals, e_5;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    u = getTgUser();
                    if (!u || !u.id || !ADMIN_IDS.includes(Number(u.id)))
                        return [2 /*return*/];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, apiPost("/api/admin/proof/list", {})];
                case 2:
                    p = _a.sent();
                    proofs = (p && (p.proofs || p.items || p.queue)) || [];
                    state.moderation = proofs.map(function (x) {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v;
                        return ({
                            id: (_b = (_a = x.id) !== null && _a !== void 0 ? _a : x.proof_id) !== null && _b !== void 0 ? _b : x.task_submit_id,
                            taskName: (_e = (_d = (_c = x.task_title) !== null && _c !== void 0 ? _c : x.taskName) !== null && _d !== void 0 ? _d : (x.task && (x.task.title || x.task.name))) !== null && _e !== void 0 ? _e : 'Задание',
                            timestamp: (_h = (_g = (_f = x.created_at) !== null && _f !== void 0 ? _f : x.timestamp) !== null && _g !== void 0 ? _g : x.date) !== null && _h !== void 0 ? _h : '',
                            workerName: (_l = (_k = (_j = x.worker_username) !== null && _j !== void 0 ? _j : x.workerName) !== null && _k !== void 0 ? _k : (x.user && (x.user.username || x.user.name))) !== null && _l !== void 0 ? _l : (x.tg_username || '—'),
                            targetUrl: (_p = (_o = (_m = x.target_url) !== null && _m !== void 0 ? _m : x.targetUrl) !== null && _o !== void 0 ? _o : x.proof_url) !== null && _p !== void 0 ? _p : '',
                            screenshotUrl: (_s = (_r = (_q = x.screenshot_url) !== null && _q !== void 0 ? _q : x.screenshotUrl) !== null && _r !== void 0 ? _r : x.proof_url) !== null && _s !== void 0 ? _s : '',
                            price: (_v = (_u = (_t = x.reward_rub) !== null && _t !== void 0 ? _t : x.price) !== null && _u !== void 0 ? _u : x.amount_rub) !== null && _v !== void 0 ? _v : 0,
                            raw: x
                        });
                    }).filter(function (x) { return x.id != null; });
                    return [3 /*break*/, 4];
                case 3:
                    e_4 = _a.sent();
                    console.error('admin proofs load error', e_4);
                    return [3 /*break*/, 4];
                case 4:
                    _a.trys.push([4, 6, , 7]);
                    return [4 /*yield*/, apiPost("/api/admin/withdraw/list", {})];
                case 5:
                    w = _a.sent();
                    withdrawals = (w && (w.withdrawals || w.items || w.list)) || [];
                    state.adminWithdrawals = withdrawals.map(function (x) {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
                        return ({
                            id: (_a = x.id) !== null && _a !== void 0 ? _a : x.withdraw_id,
                            amount: Number((_c = (_b = x.amount_rub) !== null && _b !== void 0 ? _b : x.amount) !== null && _c !== void 0 ? _c : 0),
                            details: (_f = (_e = (_d = x.details) !== null && _d !== void 0 ? _d : x.requisites) !== null && _e !== void 0 ? _e : x.wallet) !== null && _f !== void 0 ? _f : '',
                            date: (_h = (_g = x.created_at) !== null && _g !== void 0 ? _g : x.date) !== null && _h !== void 0 ? _h : '',
                            status: (_j = x.status) !== null && _j !== void 0 ? _j : 'pending',
                            raw: x
                        });
                    }).filter(function (x) { return x.id != null; });
                    return [3 /*break*/, 7];
                case 6:
                    e_5 = _a.sent();
                    console.error('admin withdrawals load error', e_5);
                    return [3 /*break*/, 7];
                case 7: return [2 /*return*/];
            }
        });
    });
}
function saveData() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, miniappsAI.storage.setItem('userBalance', JSON.stringify(state.user))];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, miniappsAI.storage.setItem('tasksList', JSON.stringify(state.tasks))];
                case 2:
                    _a.sent();
                    return [4 /*yield*/, miniappsAI.storage.setItem('adminQueue', JSON.stringify(state.moderation))];
                case 3:
                    _a.sent();
                    return [4 /*yield*/, miniappsAI.storage.setItem('userHistory', JSON.stringify(state.history))];
                case 4:
                    _a.sent();
                    return [4 /*yield*/, miniappsAI.storage.setItem('withdrawals', JSON.stringify(state.withdrawals))];
                case 5:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
// --- TASK LIMIT LOGIC ---
function checkTaskAvailability(type) {
    return __awaiter(this, void 0, void 0, function () {
        var raw, data, last, diff, remaining;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!TASK_LIMITS[type])
                        return [2 /*return*/, { ok: true }];
                    return [4 /*yield*/, miniappsAI.storage.getItem('taskLimitData')];
                case 1:
                    raw = _a.sent();
                    data = raw ? JSON.parse(raw) : {};
                    last = data[type] || 0;
                    diff = Date.now() - last;
                    if (diff < TASK_LIMITS[type]) {
                        remaining = TASK_LIMITS[type] - diff;
                        return [2 /*return*/, { ok: false, remainingMs: remaining }];
                    }
                    return [2 /*return*/, { ok: true }];
            }
        });
    });
}
function recordTaskAction(type) {
    return __awaiter(this, void 0, void 0, function () {
        var raw, data;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!TASK_LIMITS[type])
                        return [2 /*return*/];
                    return [4 /*yield*/, miniappsAI.storage.getItem('taskLimitData')];
                case 1:
                    raw = _a.sent();
                    data = raw ? JSON.parse(raw) : {};
                    data[type] = Date.now();
                    return [4 /*yield*/, miniappsAI.storage.setItem('taskLimitData', JSON.stringify(data))];
                case 2:
                    _a.sent();
                    state.limits = data; // Update local state
                    return [2 /*return*/];
            }
        });
    });
}
// --- HISTORY SYSTEM ---
function addHistory(type, amount, desc) {
    state.history.unshift({
        id: Date.now(),
        type: type, // 'earn', 'spend', 'withdraw'
        amount: amount,
        desc: desc,
        date: new Date().toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    });
    if (state.history.length > 50)
        state.history.pop();
}
function renderHistory() {
    var list = document.getElementById('history-list');
    if (!list)
        return;
    list.innerHTML = '';
    var items = (Array.isArray(state.ops) && state.ops.length) ? state.ops : (state.history || []);
    if (items.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-dim);">История пуста</div>';
        return;
    }
    var fmtDate = function (v) {
        if (!v)
            return '';
        try {
            var d = new Date(v);
            if (isNaN(d.getTime()))
                return String(v);
            return d.toLocaleString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
        catch (_a) {
            return String(v);
        }
    };
    var providerTitle = function (p) {
        if (!p)
            return 'Пополнение';
        if (p === 'tbank')
            return 'Пополнение (T-Bank)';
        if (p === 'cryptobot')
            return 'Пополнение (CryptoBot)';
        if (p === 'stars')
            return 'Пополнение (Stars)';
        return 'Пополнение';
    };
    items.forEach(function (item) {
        // поддержка старого фейкового формата истории
        if (item.type) {
            var icon_1 = '📝';
            var colorClass_1 = '';
            var sign_1 = '';
            if (item.type === 'earn') {
                icon_1 = '💰';
                colorClass_1 = 'amt-green';
                sign_1 = '+';
            }
            else if (item.type === 'spend') {
                icon_1 = '💸';
                colorClass_1 = 'amt-red';
                sign_1 = '-';
            }
            else if (item.type === 'withdraw') {
                icon_1 = '🏦';
                colorClass_1 = 'amt-red';
                sign_1 = '-';
            }
            list.insertAdjacentHTML('beforeend', "\n                <div class=\"list-item\">\n                    <div class=\"list-icon\">".concat(icon_1, "</div>\n                    <div class=\"list-meta\">\n                        <div class=\"list-title\">").concat(item.desc, "</div>\n                        <div class=\"list-date\">").concat(item.date, "</div>\n                    </div>\n                    <div class=\"list-amount ").concat(colorClass_1, "\">").concat(sign_1).concat(item.amount, " \u20BD</div>\n                </div>\n            "));
            return;
        }
        var kind = item.kind;
        var status = String(item.status || 'pending');
        var amount = Number(item.amount_rub || 0);
        var dateText = fmtDate(item.created_at);
        var icon = '🧾';
        var title = 'Операция';
        var sign = '';
        var colorClass = '';
        if (kind === 'payment') {
            // платежи показываем как "+"
            title = providerTitle(item.provider);
            sign = '+';
            colorClass = (status === 'paid') ? 'amt-green' : '';
            icon = (status === 'paid') ? '✅' : '⏳';
        }
        else if (kind === 'withdrawal') {
            title = 'Вывод средств';
            sign = '-';
            colorClass = 'amt-red';
            icon = (status === 'paid') ? '✅' : (status === 'rejected' ? '❌' : '⏳');
        }
        var statusText = status === 'paid' ? 'Выполнено' :
            status === 'rejected' ? 'Отклонено' :
                'Ожидает';
        list.insertAdjacentHTML('beforeend', "\n            <div class=\"list-item\">\n                <div class=\"list-icon\">".concat(icon, "</div>\n                <div class=\"list-meta\">\n                    <div class=\"list-title\">").concat(title, " <span style=\"font-size:11px; color:var(--text-dim);\">\u2022 ").concat(statusText, "</span></div>\n                    <div class=\"list-date\">").concat(dateText, "</div>\n                </div>\n                <div class=\"list-amount ").concat(colorClass, "\">").concat(sign).concat(amount.toFixed(0), " \u20BD</div>\n            </div>\n        "));
    });
}
// --- LEVELING SYSTEM ---
function addXP(amount) {
    state.user.xp += amount;
    checkLevelUp();
}
function checkLevelUp() {
    var newLevel = 1 + Math.floor(state.user.xp / 100);
    if (newLevel > state.user.level) {
        state.user.level = newLevel;
        var bonus = 50;
        state.user.rub += bonus;
        addHistory('earn', bonus, "\u0411\u043E\u043D\u0443\u0441 \u0437\u0430 ".concat(newLevel, " \u0443\u0440\u043E\u0432\u0435\u043D\u044C!"));
        tg.showAlert("\uD83C\uDF89 \u041F\u043E\u0437\u0434\u0440\u0430\u0432\u043B\u044F\u0435\u043C!\n\u0412\u044B \u0434\u043E\u0441\u0442\u0438\u0433\u043B\u0438 ".concat(newLevel, " \u0443\u0440\u043E\u0432\u043D\u044F!\n\u041D\u0430\u0433\u0440\u0430\u0434\u0430: +").concat(bonus, " \u20BD"));
    }
}
// --- CORE LOGIC: CREATE TASK ---
window.createTask = function () {
    return __awaiter(this, void 0, void 0, function () {
        var typeEl, subtypeEl, qtyEl, curEl, targetEl, textEl, type, qty, currency, target, instructions, pricePerItem, workerReward, taskName, subType, checkType, stKey, conf, costRub, finalCost, tgChat, tgKind, btn, e_6;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    typeEl = document.getElementById('t-type');
                    subtypeEl = document.getElementById('t-tg-subtype');
                    qtyEl = document.getElementById('t-qty');
                    curEl = document.getElementById('t-cur');
                    targetEl = document.getElementById('t-target');
                    textEl = document.getElementById('t-text');
                    type = typeEl.value;
                    qty = parseInt(qtyEl.value, 10);
                    currency = curEl.value;
                    target = (targetEl.value || '').trim();
                    instructions = (textEl.value || '').trim();
                    if (!qty || qty < 1)
                        return [2 /*return*/, tg.showAlert('Минимальное количество: 1')];
                    if (!target)
                        return [2 /*return*/, tg.showAlert('Укажите ссылку на объект')];
                    if (!isLinkValid) {
                        return [2 /*return*/, tg.showAlert('Пожалуйста, укажите корректную ссылку и дождитесь проверки.')];
                    }
                    pricePerItem = 0;
                    workerReward = 0;
                    taskName = '';
                    subType = null;
                    checkType = 'manual';
                    if (type === 'tg') {
                        stKey = subtypeEl.value;
                        conf = TG_TASK_TYPES[stKey];
                        if (!conf)
                            return [2 /*return*/, tg.showAlert('Выберите тип TG-задания')];
                        pricePerItem = Number(conf.cost || 0);
                        workerReward = Number(conf.reward || 0);
                        taskName = conf.label || 'TG задание';
                        subType = stKey;
                        checkType = 'auto';
                    }
                    else {
                        pricePerItem = Number(typeEl.selectedOptions[0].dataset.p || 0);
                        taskName = type === 'ya' ? 'Отзыв Яндекс' : 'Отзыв Google';
                        checkType = 'manual';
                        workerReward = Math.floor(pricePerItem * 0.5);
                    }
                    costRub = pricePerItem * qty;
                    finalCost = costRub;
                    if (currency === 'star')
                        finalCost = Math.ceil(costRub / 1.5);
                    tgChat = null;
                    tgKind = "channel";
                    if (type === "tg") {
                        tgChat = target
                            .replace(/^https?:\/\/t\.me\//i, "@")
                            .replace(/^t\.me\//i, "@")
                            .split("/")[0];
                        if (subType === "tg_group")
                            tgKind = "group";
                    }
                    btn = document.getElementById('t-submit-btn');
                    if (btn) {
                        btn.disabled = true;
                        btn.classList.add('working');
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, 5, 6]);
                    return [4 /*yield*/, apiPost("/api/task/create", {
                            type: type,
                            title: taskName, // например "Подписка на канал"
                            target_url: target,
                            instructions: instructions,
                            reward_rub: workerReward, // сколько платим исполнителю
                            cost_rub: costRub, // сколько списать у заказчика (в ₽)
                            qty_total: qty,
                            check_type: (type === "tg") ? "auto" : "manual",
                            tg_chat: (type === "tg") ? tgChat : null,
                            tg_kind: (type === "tg") ? tgKind : null
                        })];
                case 2:
                    _a.sent();
                    // перезагружаем стейт из БД
                    return [4 /*yield*/, loadData()];
                case 3:
                    // перезагружаем стейт из БД
                    _a.sent();
                    render();
                    if (typeof renderWithdrawals === 'function')
                        renderWithdrawals();
                    closeModal();
                    setFilter('my');
                    tg.showAlert("\u2705 \u0417\u0430\u0434\u0430\u043D\u0438\u0435 \u0441\u043E\u0437\u0434\u0430\u043D\u043E!\n\u0421\u043F\u0438\u0441\u0430\u043D\u043E: ".concat(finalCost, " ").concat(currency === 'rub' ? '₽' : '⭐'));
                    return [3 /*break*/, 6];
                case 4:
                    e_6 = _a.sent();
                    console.error(e_6);
                    tg.showAlert('Ошибка создания задания: ' + (e_6 && e_6.message ? e_6.message : 'unknown'));
                    return [3 /*break*/, 6];
                case 5:
                    if (btn) {
                        btn.disabled = false;
                        btn.classList.remove('working');
                    }
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    });
};
window.handleTask = function (btn, owner, id) {
    return __awaiter(this, void 0, void 0, function () {
        var task_1, availability, hrs, limitText, iconBox, iconChar, linkEl, linkBtn, textEl, isTgAuto, actBtn, actionText;
        var _this = this;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!(owner === 'me')) return [3 /*break*/, 1];
                    tg.showConfirm('Удалить это задание? Средства не вернутся (демо).', function (confirmed) { return __awaiter(_this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0:
                                    if (!confirmed) return [3 /*break*/, 2];
                                    state.tasks = state.tasks.filter(function (t) { return t.id !== id; });
                                    return [4 /*yield*/, saveData()];
                                case 1:
                                    _a.sent();
                                    render();
                                    _a.label = 2;
                                case 2: return [2 /*return*/];
                            }
                        });
                    }); });
                    return [3 /*break*/, 4];
                case 1:
                    task_1 = state.tasks.find(function (t) { return t.id === id; });
                    if (!task_1)
                        return [2 /*return*/];
                    if (!TASK_LIMITS[task_1.type]) return [3 /*break*/, 3];
                    btn.classList.add('working'); // Indicate loading
                    return [4 /*yield*/, checkTaskAvailability(task_1.type)];
                case 2:
                    availability = _a.sent();
                    btn.classList.remove('working');
                    if (!availability.ok) {
                        hrs = Math.ceil(availability.remainingMs / (1000 * 60 * 60));
                        limitText = task_1.type === 'ya' ? 'раз в 3 дня' : 'раз в день';
                        return [2 /*return*/, tg.showAlert("\u23F3 \u042D\u0442\u043E \u0437\u0430\u0434\u0430\u043D\u0438\u0435 \u043C\u043E\u0436\u043D\u043E \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0442\u044C ".concat(limitText, ".\n\n") +
                                "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0447\u0435\u0440\u0435\u0437: ~".concat(hrs, " \u0447."))];
                    }
                    _a.label = 3;
                case 3:
                    // --------------------
                    document.getElementById('td-title').innerText = task_1.name;
                    document.getElementById('td-reward').innerText = "+".concat(task_1.price, " \u20BD");
                    iconBox = document.getElementById('td-icon');
                    iconChar = ASSETS[task_1.type] ? "<img src=\"".concat(ASSETS[task_1.type], "\" style=\"width:100%\">") : '📄';
                    if (task_1.type === 'tg' && task_1.subType && TG_TASK_TYPES[task_1.subType]) {
                        iconChar = TG_TASK_TYPES[task_1.subType].icon;
                        document.getElementById('td-type-badge').innerText = TG_TASK_TYPES[task_1.subType].label.toUpperCase();
                    }
                    else {
                        document.getElementById('td-type-badge').innerText = task_1.type.toUpperCase();
                    }
                    iconBox.innerHTML = "<div style=\"display:flex;align-items:center;justify-content:center;height:100%;font-size:32px;\">".concat(iconChar, "</div>");
                    linkEl = document.getElementById('td-link');
                    linkBtn = document.getElementById('td-link-btn');
                    textEl = document.getElementById('td-text');
                    linkEl.innerText = task_1.target;
                    linkBtn.href = task_1.target;
                    textEl.innerText = task_1.text || 'Нет дополнительных инструкций';
                    isTgAuto = task_1.checkType === 'auto';
                    document.getElementById('proof-manual').classList.toggle('hidden', isTgAuto);
                    document.getElementById('proof-auto').classList.toggle('hidden', !isTgAuto);
                    document.getElementById('p-username').value = '';
                    document.getElementById('p-file').value = '';
                    document.getElementById('p-filename').innerText = '📷 Прикрепить скриншот';
                    document.getElementById('p-filename').style.color = 'var(--accent-cyan)';
                    selectedProofFile = null;
                    actBtn = document.getElementById('td-action-btn');
                    actBtn.disabled = false;
                    actBtn.classList.remove('working');
                    if (isTgAuto) {
                        actionText = '⚡ Проверить выполнение';
                        if (task_1.subType && TG_TASK_TYPES[task_1.subType]) {
                            actionText = '⚡ Проверить: ' + TG_TASK_TYPES[task_1.subType].action;
                        }
                        actBtn.innerHTML = actionText;
                        actBtn.onclick = function () { return checkTgTask(id, task_1.subType); };
                    }
                    else {
                        actBtn.innerHTML = '📤 Отправить отчет';
                        actBtn.onclick = function () { return submitReviewProof(id); };
                    }
                    openModal('m-task-details');
                    _a.label = 4;
                case 4: return [2 /*return*/];
            }
        });
    });
};
window.checkTgTask = function (id, subType) {
    return __awaiter(this, void 0, void 0, function () {
        var btn, msg, e_7;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    btn = document.getElementById('td-action-btn');
                    if (btn) {
                        btn.disabled = true;
                        msg = 'Проверка подписки...';
                        if (subType === 'tg_poll')
                            msg = 'Проверка голоса...';
                        if (subType === 'tg_react')
                            msg = 'Проверка реакции...';
                        if (subType === 'tg_start')
                            msg = 'Проверка запуска бота...';
                        if (subType === 'tg_mapp')
                            msg = 'Проверка запуска App...';
                        btn.innerHTML = "<span class=\"spin-icon\">\u23F3</span> ".concat(msg);
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    // Auto TG кнопка “Проверить” тоже бьёт /api/task/submit
                    return [4 /*yield*/, apiPost("/api/task/submit", { task_id: id })];
                case 2:
                    // Auto TG кнопка “Проверить” тоже бьёт /api/task/submit
                    _a.sent();
                    return [4 /*yield*/, loadData()];
                case 3:
                    _a.sent();
                    render();
                    closeModal();
                    tg.showAlert('✅ Задание принято! Если проверка авто — начисление произойдёт сразу/после подтверждения сервером.');
                    return [3 /*break*/, 5];
                case 4:
                    e_7 = _a.sent();
                    console.error(e_7);
                    tg.showAlert('Ошибка проверки: ' + (e_7 && e_7.message ? e_7.message : 'unknown'));
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = '⚡ Проверить выполнение';
                    }
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
};
window.submitReviewProof = function (id) {
    return __awaiter(this, void 0, void 0, function () {
        var user, proofUrlEl, proofUrl, btn, e_8;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    user = (((_a = document.getElementById('p-username')) === null || _a === void 0 ? void 0 : _a.value) || '').trim();
                    if (!user)
                        return [2 /*return*/, tg.showAlert('Укажите ваше имя/никнейм.')];
                    proofUrlEl = document.getElementById('p-proof-url') || document.getElementById('p-link') || null;
                    proofUrl = proofUrlEl ? (proofUrlEl.value || '').trim() : "";
                    btn = document.getElementById('td-action-btn');
                    if (btn) {
                        btn.disabled = true;
                        btn.innerHTML = '<span class="spin-icon">⏳</span> Отправка...';
                    }
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 4, , 5]);
                    // submitReviewProof() → /api/task/submit (пока без загрузки файлов)
                    return [4 /*yield*/, apiPost("/api/task/submit", {
                            task_id: id,
                            proof_text: user,
                            proof_url: proofUrl || ""
                        })];
                case 2:
                    // submitReviewProof() → /api/task/submit (пока без загрузки файлов)
                    _b.sent();
                    return [4 /*yield*/, loadData()];
                case 3:
                    _b.sent();
                    render();
                    closeModal();
                    tg.showAlert('✅ Отчет отправлен!\nДальше — модерация/автопроверка на сервере.');
                    return [3 /*break*/, 5];
                case 4:
                    e_8 = _b.sent();
                    console.error(e_8);
                    tg.showAlert('Ошибка отправки: ' + (e_8 && e_8.message ? e_8.message : 'unknown'));
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = '📤 Отправить отчет';
                    }
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
};
function completeTaskLogic(id, msg, isAuto) {
    var task = state.tasks.find(function (t) { return t.id === id; });
    if (task) {
        var reward = parseInt(task.price);
        state.user.rub += reward;
        addHistory('earn', reward, "\u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E: ".concat(task.name));
        addXP(reward); // XP = Earned Amount
        saveData();
        render();
        closeModal();
        tg.showAlert("\u2705 ".concat(msg, "\n+").concat(reward, " \u20BD \u043D\u0430\u0447\u0438\u0441\u043B\u0435\u043D\u043E."));
    }
}
window.updateFileName = function (input) {
    if (input.files && input.files[0]) {
        selectedProofFile = input.files[0];
        var name = input.files[0].name;
        document.getElementById('p-filename').innerText = '📄 ' + (name.length > 20 ? name.substr(0, 18) + '...' : name);
        document.getElementById('p-filename').style.color = 'var(--text-main)';
    }
};
// --- ADMIN / MODERATION SYSTEM ---
window.openAdminPanel = function () {
    switchAdminTab('proofs');
    openModal('m-admin');
};
window.switchAdminTab = function (tab) {
    activeAdminTab = tab;
    document.getElementById('at-proofs').classList.toggle('active', tab === 'proofs');
    document.getElementById('at-withdrawals').classList.toggle('active', tab === 'withdrawals');
    document.getElementById('admin-view-proofs').classList.toggle('hidden', tab !== 'proofs');
    document.getElementById('admin-view-withdrawals').classList.toggle('hidden', tab !== 'withdrawals');
    renderAdmin();
};
window.renderAdmin = function () {
    if (activeAdminTab === 'proofs')
        renderAdminProofs();
    else
        renderAdminWithdrawals();
};
function renderAdminProofs() {
    var list = document.getElementById('admin-list');
    list.innerHTML = '';
    if (state.moderation.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Нет отчетов на проверку</div>';
        return;
    }
    state.moderation.forEach(function (item) {
        var div = document.createElement('div');
        div.className = 'card';
        div.style.padding = '15px';
        div.style.marginBottom = '0';
        div.innerHTML = "\n            <div style=\"font-weight:700; font-size:14px; margin-bottom:5px;\">".concat(item.taskName, "</div>\n            <div style=\"font-size:12px; color:var(--text-dim); margin-bottom:5px;\">\n                \uD83D\uDCC5 ").concat(item.timestamp, "<br>\n                \uD83D\uDC64 \u041D\u0438\u043A: <span style=\"color:var(--text-main); font-weight:700;\">").concat(item.workerName, "</span>\n            </div>\n            \n            <div style=\"display:flex; gap:10px; margin-top:10px;\">\n                <button class=\"btn btn-secondary btn-sm\" onclick=\"window.open('").concat(item.targetUrl, "', '_blank')\">\uD83D\uDD17 \u0421\u0441\u044B\u043B\u043A\u0430</button>\n                <button class=\"btn btn-secondary btn-sm\" onclick=\"window.open('").concat(item.screenshotUrl, "', '_blank')\">\uD83D\uDCF7 \u0421\u043A\u0440\u0438\u043D\u0448\u043E\u0442</button>\n            </div>\n\n            <div style=\"display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:15px;\">\n                <button class=\"btn\" style=\"background:rgba(255,75,75,0.1); color:#ff4b4b; padding:10px;\" onclick=\"adminDecision(").concat(item.id, ", false)\">\u274C \u041E\u0442\u043A\u0430\u0437</button>\n                <button class=\"btn\" style=\"background:rgba(0,255,136,0.1); color:var(--accent-green); padding:10px;\" onclick=\"adminDecision(").concat(item.id, ", true)\">\u2705 \u041F\u0440\u0438\u043D\u044F\u0442\u044C</button>\n            </div>\n        ");
        list.appendChild(div);
    });
}
function renderAdminWithdrawals() {
    var list = document.getElementById('admin-withdraw-list');
    list.innerHTML = '';
    // Filter only pending for action, or show all? Let's show all but sort pending first
    var items = __spreadArray([], __read(state.adminWithdrawals), false).sort(function (a, b) {
        if (a.status === 'pending' && b.status !== 'pending')
            return -1;
        if (a.status !== 'pending' && b.status === 'pending')
            return 1;
        return b.id - a.id;
    });
    if (items.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Нет заявок</div>';
        return;
    }
    items.forEach(function (w) {
        var badge = '<span class="status-badge st-pending">⏳ Ожидание</span>';
        var actions = '';
        if (w.status === 'paid')
            badge = '<span class="status-badge st-paid">✅ Выплачено</span>';
        if (w.status === 'rejected')
            badge = '<span class="status-badge st-rejected">❌ Отменено</span>';
        if (w.status === 'pending') {
            actions = "\n                <div style=\"display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:15px; border-top:1px solid var(--glass-border); padding-top:15px;\">\n                     <button class=\"btn\" style=\"background:rgba(255,75,75,0.1); color:#ff4b4b; padding:8px; font-size:12px;\" onclick=\"adminProcessWithdrawal(".concat(w.id, ", false)\">\u041E\u0442\u043A\u043B\u043E\u043D\u0438\u0442\u044C</button>\n                     <button class=\"btn\" style=\"background:rgba(0,255,136,0.1); color:var(--accent-green); padding:8px; font-size:12px;\" onclick=\"adminProcessWithdrawal(").concat(w.id, ", true)\">\u0412\u044B\u043F\u043B\u0430\u0442\u0438\u0442\u044C</button>\n                </div>\n            ");
        }
        var div = document.createElement('div');
        div.className = 'card';
        div.style.padding = '15px';
        div.style.marginBottom = '0';
        div.innerHTML = "\n            <div style=\"display:flex; justify-content:space-between; align-items:flex-start;\">\n                <div>\n                    <div style=\"font-weight:800; font-size:16px; margin-bottom:5px;\">".concat(w.amount, " \u20BD</div>\n                    <div style=\"font-size:12px; color:var(--text-dim);\">").concat(w.details, "</div>\n                    <div style=\"font-size:10px; color:var(--text-dim); margin-top:4px;\">").concat(w.date, "</div>\n                </div>\n                ").concat(badge, "\n            </div>\n            ").concat(actions, "\n        ");
        list.appendChild(div);
    });
}
window.adminDecision = function (itemId, approved) {
    return __awaiter(this, void 0, void 0, function () {
        var e_9;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 4, , 5]);
                    return [4 /*yield*/, apiPost("/api/admin/proof/decision", {
                            proof_id: itemId,
                            approved: !!approved
                        })];
                case 1:
                    _a.sent();
                    // Обновим данные (и админские, и пользовательский баланс/таски)
                    return [4 /*yield*/, loadAdminData()];
                case 2:
                    // Обновим данные (и админские, и пользовательский баланс/таски)
                    _a.sent();
                    return [4 /*yield*/, loadData()];
                case 3:
                    _a.sent();
                    tg.showAlert(approved ? '✅ Отчет принят.' : '❌ Отчет отклонен.');
                    render();
                    renderAdmin();
                    updateAdminBadge();
                    if (state.moderation.length === 0 && (state.adminWithdrawals || []).filter(function (w) { return w.status === 'pending'; }).length === 0) {
                        closeModal();
                    }
                    return [3 /*break*/, 5];
                case 4:
                    e_9 = _a.sent();
                    console.error(e_9);
                    tg.showAlert('Ошибка: ' + (e_9 && e_9.message ? e_9.message : 'не удалось выполнить действие'));
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
};
window.adminProcessWithdrawal = function (id, approved) {
    return __awaiter(this, void 0, void 0, function () {
        var e_10;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 4, , 5]);
                    return [4 /*yield*/, apiPost("/api/admin/withdraw/decision", {
                            withdraw_id: id,
                            approved: !!approved
                        })];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, loadAdminData()];
                case 2:
                    _a.sent();
                    return [4 /*yield*/, loadData()];
                case 3:
                    _a.sent();
                    tg.showAlert(approved ? '✅ Выплата подтверждена.' : '❌ Выплата отклонена.');
                    render();
                    renderAdmin();
                    updateAdminBadge();
                    return [3 /*break*/, 5];
                case 4:
                    e_10 = _a.sent();
                    console.error(e_10);
                    tg.showAlert('Ошибка: ' + (e_10 && e_10.message ? e_10.message : 'не удалось выполнить действие'));
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
};
function updateAdminBadge() {
    var badge = document.getElementById('admin-badge');
    if (!badge)
        return;
    // Count pending tasks
    var count = state.moderation.length;
    var pendingW = (state.adminWithdrawals || []).filter(function (w) { return w.status === 'pending'; }).length;
    var total = count + pendingW;
    badge.innerText = total;
    badge.style.opacity = total > 0 ? '1' : '0';
}
window.recalc = function () {
    var typeSelect = document.getElementById('t-type');
    var subtypeSelect = document.getElementById('t-tg-subtype');
    var subtypeWrapper = document.getElementById('tg-subtype-wrapper');
    var tgOptions = document.getElementById('tg-options');
    if (!typeSelect)
        return;
    var typeVal = typeSelect.value;
    var pricePerItem = 0;
    if (typeVal === 'tg') {
        subtypeWrapper.classList.remove('hidden');
        tgOptions.classList.remove('hidden');
        // Get price from subtype
        var stKey = subtypeSelect.value;
        if (TG_TASK_TYPES[stKey]) {
            pricePerItem = TG_TASK_TYPES[stKey].cost;
        }
    }
    else {
        subtypeWrapper.classList.add('hidden');
        tgOptions.classList.add('hidden');
        // Get price from main select
        pricePerItem = parseInt(typeSelect.selectedOptions[0].dataset.p);
    }
    var q = parseInt(document.getElementById('t-qty').value || 0);
    var cur = document.getElementById('t-cur').value;
    var totalRub = pricePerItem * q;
    var el = document.getElementById('t-total');
    if (cur === 'star') {
        var stars = Math.ceil(totalRub / 1.5);
        el.innerText = stars + ' ⭐';
        el.style.color = 'var(--accent-gold)';
    }
    else {
        el.innerText = totalRub + ' ₽';
        el.style.color = 'var(--accent-cyan)';
    }
};
window.copyLink = function () {
    var url = document.getElementById('td-link').innerText;
    navigator.clipboard.writeText(url).then(function () { return tg.showAlert('Ссылка скопирована'); });
};
window.copyText = function () {
    var txt = document.getElementById('td-text').innerText;
    navigator.clipboard.writeText(txt).then(function () { return tg.showAlert('Текст скопирован'); });
};
window.toggleTheme = function () {
    document.body.classList.toggle('light-mode');
    var isLight = document.body.classList.contains('light-mode');
    if (tg.setHeaderColor)
        tg.setHeaderColor(isLight ? '#f2f4f7' : '#05070a');
};
// NAVIGATION & VIEW LOGIC
window.showTab = function (t) {
    document.querySelectorAll('.nav-item').forEach(function (i) { return i.classList.remove('active'); });
    var navBtn = document.getElementById('tab-' + t);
    if (navBtn)
        navBtn.classList.add('active');
    document.getElementById('view-tasks').classList.toggle('hidden', t !== 'tasks');
    document.getElementById('view-friends').classList.toggle('hidden', t !== 'friends');
    document.getElementById('view-profile').classList.toggle('hidden', t !== 'profile');
    document.getElementById('view-history').classList.add('hidden'); // Ensure history is hidden when switching tabs
};
window.showHistory = function () {
    // Hide all main tabs
    document.getElementById('view-tasks').classList.add('hidden');
    document.getElementById('view-friends').classList.add('hidden');
    document.getElementById('view-profile').classList.add('hidden');
    // Show history
    document.getElementById('view-history').classList.remove('hidden');
    renderHistory();
};
window.closeHistory = function () {
    document.getElementById('view-history').classList.add('hidden');
    // Return to profile
    document.getElementById('view-profile').classList.remove('hidden');
    document.getElementById('tab-profile').classList.add('active');
};
function render() {
    // 1. Balance
    document.getElementById('u-bal-rub').innerText = Math.floor(state.user.rub).toLocaleString() + ' ₽';
    document.getElementById('u-bal-star').innerText = Math.floor(state.user.stars).toLocaleString() + ' ⭐';
    // 2. XP & Level
    var xpPerLevel = 100;
    var currentLevel = state.user.level;
    var nextLevelXP = currentLevel * xpPerLevel;
    var prevLevelXP = (currentLevel - 1) * xpPerLevel;
    var xpInCurrentLevel = state.user.xp - prevLevelXP;
    var xpNeededForNext = nextLevelXP - prevLevelXP;
    var progressPct = Math.min(100, Math.max(0, (xpInCurrentLevel / xpNeededForNext) * 100));
    document.getElementById('u-lvl-badge').innerText = "LVL ".concat(currentLevel);
    document.getElementById('u-xp-cur').innerText = "".concat(state.user.xp, " XP");
    document.getElementById('u-xp-next').innerText = "".concat(nextLevelXP, " XP");
    document.getElementById('u-xp-fill').style.width = "".concat(progressPct, "%");
    // 3. Tasks
    var box = document.getElementById('tasks-list');
    if (box) {
        box.innerHTML = '';
        var list = state.tasks.filter(function (t) { return state.filter === 'all' ? t.owner === 'other' : t.owner === 'me'; });
        if (list.length === 0) {
            box.innerHTML = "\n                <div style=\"text-align:center; padding: 60px 20px; color: var(--text-dim); opacity: 0.6;\" class=\"anim-entry\">\n                    <div style=\"font-size: 48px; margin-bottom: 15px; filter: grayscale(1);\">\uD83D\uDCED</div>\n                    <div style=\"font-weight:600;\">\u0417\u0430\u0434\u0430\u0447 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442</div>\n                    <div style=\"font-size:12px; margin-top:5px;\">\u0417\u0430\u0445\u043E\u0434\u0438\u0442\u0435 \u043F\u043E\u0437\u0436\u0435 \u0438\u043B\u0438 \u0441\u043E\u0437\u0434\u0430\u0439\u0442\u0435 \u0441\u0432\u043E\u044E</div>\n                </div>\n            ";
        }
        else {
            list.forEach(function (t, index) {
                var icon = '';
                // Resolve Icon
                if (t.type === 'tg' && t.subType && TG_TASK_TYPES[t.subType]) {
                    icon = TG_TASK_TYPES[t.subType].icon;
                }
                else if (ASSETS[t.type]) {
                    icon = "<img src=\"".concat(ASSETS[t.type], "\" style=\"width:100%; height:100%; object-fit:contain;\">");
                }
                else {
                    icon = '📄';
                }
                // Wrap text icon if needed
                if (!icon.includes('<img')) {
                    icon = "<div style=\"font-size:24px;\">".concat(icon, "</div>");
                }
                box.insertAdjacentHTML('beforeend', "\n                    <div class=\"task-item anim-entry\" style=\"animation-delay: ".concat(0.05 * index, "s\">\n                        <div style=\"display:flex; align-items:center;\">\n                            <div class=\"brand-box\">").concat(icon, "</div>\n                            <div style=\"margin-left:15px;\">\n                                <div style=\"font-weight:700;\">").concat(t.name, "</div>\n                                <div style=\"color:var(--accent-cyan); font-weight:800; font-size:14px;\">+").concat(t.price, " \u20BD</div>\n                            </div>\n                        </div>\n                        <button class=\"btn btn-action\" onclick=\"handleTask(this, '").concat(t.owner, "', ").concat(t.id, ")\">\n                            ").concat(t.owner === 'me' ? 'Удалить' : 'Выполнить', "\n                        </button>\n                    </div>\n                "));
            });
        }
    }
    // 4. Referrals
    renderReferrals();
}
window.render = render;
function renderReferrals() {
    var _a;
    var refCount = document.getElementById('ref-count');
    var refEarn = document.getElementById('ref-earn');
    // Leaderboard logic removed
    if (refCount)
        refCount.innerText = state.referrals.count;
    if (refEarn)
        refEarn.innerText = state.referrals.earned + ' ₽';
    // Invite Link
    var uid = ((_a = getTgUser()) === null || _a === void 0 ? void 0 : _a.id) || '12345';
    var inviteLink = "t.me/ReviewCashBot?start=".concat(uid);
    var linkEl = document.getElementById('invite-link');
    if (linkEl)
        linkEl.innerText = inviteLink;
}
window.copyInviteLink = function () {
    var _a;
    var uid = ((_a = getTgUser()) === null || _a === void 0 ? void 0 : _a.id) || '12345';
    var inviteLink = "https://t.me/ReviewCashBot?start=".concat(uid);
    navigator.clipboard.writeText(inviteLink).then(function () { return tg.showAlert('🔗 Ссылка скопирована!'); });
};
window.shareInvite = function () {
    var _a;
    var uid = ((_a = getTgUser()) === null || _a === void 0 ? void 0 : _a.id) || '12345';
    var inviteLink = "https://t.me/ReviewCashBot?start=".concat(uid);
    tg.openTelegramLink("https://t.me/share/url?url=".concat(encodeURIComponent(inviteLink), "&text=\u0417\u0430\u0440\u0430\u0431\u0430\u0442\u044B\u0432\u0430\u0439 \u043D\u0430 \u0437\u0430\u0434\u0430\u043D\u0438\u044F\u0445 \u0432\u043C\u0435\u0441\u0442\u0435 \u0441\u043E \u043C\u043D\u043E\u0439!"));
};
window.setFilter = function (f) {
    state.filter = f;
    document.getElementById('f-all').classList.toggle('active', f === 'all');
    document.getElementById('f-my').classList.toggle('active', f === 'my');
    render();
};
window.processPay = function (method) {
    return __awaiter(this, void 0, void 0, function () {
        var val, r, url, e_11, payload;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    val = Number(document.getElementById('sum-input').value || 0);
                    if (val < 300)
                        return [2 /*return*/, tg.showAlert('Минимальная сумма пополнения — 300 ₽')];
                    if (!(method === 'pay_crypto')) return [3 /*break*/, 4];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, apiPost("/api/pay/cryptobot/create", { amount_rub: val })];
                case 2:
                    r = _a.sent();
                    url = r.pay_url;
                    try {
                        tg.openTelegramLink(url);
                    }
                    catch (e) {
                        window.open(url, "_blank");
                    }
                    return [2 /*return*/, tg.showAlert('✅ Счёт CryptoBot создан. Оплати по ссылке — баланс обновится автоматически.')];
                case 3:
                    e_11 = _a.sent();
                    return [2 /*return*/, tg.showAlert('❌ Ошибка CryptoBot: ' + (e_11.message || e_11))];
                case 4:
                    payload = { action: method, amount: String(val) };
                    tg.sendData(JSON.stringify(payload));
                    return [2 /*return*/];
            }
        });
    });
};
var tbankAmount = 0;
window.openTBankPay = function () {
    var _a;
    var val = document.getElementById('sum-input').value;
    if (val < 300)
        return tg.showAlert('Минимальная сумма пополнения — 300 ₽');
    tbankAmount = val;
    document.getElementById('tb-amount-display').innerText = val + ' ₽';
    var uId = ((_a = getTgUser()) === null || _a === void 0 ? void 0 : _a.id) || 'TEST';
    var rand = Math.floor(1000 + Math.random() * 9000);
    var code = "PAY-".concat(uId, "-").concat(rand);
    document.getElementById('tb-code').innerText = code;
    closeModal();
    openModal('m-pay-tbank');
};
window.copyCode = function () {
    var code = document.getElementById('tb-code').innerText;
    navigator.clipboard.writeText(code).then(function () {
        tg.showAlert('Код скопирован!');
    });
};
window.confirmTBank = function () {
    var sender = document.getElementById('tb-sender').value;
    var code = document.getElementById('tb-code').innerText;
    if (!sender)
        return tg.showAlert('Укажите ваше имя отправителя');
    var payload = { action: 'pay_tbank', amount: tbankAmount, sender: sender, code: code };
    tg.sendData(JSON.stringify(payload));
};
// WITHDRAWAL LOGIC
window.requestWithdraw = function () {
    return __awaiter(this, void 0, void 0, function () {
        var amount, details, amt, r, e_12;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    amount = (((_a = document.getElementById('w-amount')) === null || _a === void 0 ? void 0 : _a.value) || '').trim();
                    details = (((_b = document.getElementById('w-details')) === null || _b === void 0 ? void 0 : _b.value) || '').trim();
                    if (!amount || !details)
                        return [2 /*return*/, tg.showAlert('Заполните все поля')];
                    amt = Number(amount);
                    if (!Number.isFinite(amt) || amt <= 0)
                        return [2 /*return*/, tg.showAlert('Некорректная сумма')];
                    if (amt < 300)
                        return [2 /*return*/, tg.showAlert('Минимальная сумма: 300 ₽')];
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 5, , 6]);
                    return [4 /*yield*/, apiPost("/api/withdraw/create", {
                            amount_rub: amt,
                            details: details
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, apiPost("/api/withdraw/list", {})];
                case 3:
                    r = _c.sent();
                    state.withdrawals = r.withdrawals || [];
                    renderWithdrawals();
                    // и баланс/таски
                    return [4 /*yield*/, loadData()];
                case 4:
                    // и баланс/таски
                    _c.sent();
                    render();
                    tg.showAlert('✅ Заявка создана! Ожидайте обработки.');
                    return [3 /*break*/, 6];
                case 5:
                    e_12 = _c.sent();
                    console.error(e_12);
                    tg.showAlert('Ошибка вывода: ' + (e_12 && e_12.message ? e_12.message : 'unknown'));
                    return [3 /*break*/, 6];
                case 6: return [2 /*return*/];
            }
        });
    });
};
function renderWithdrawals() {
    var list = document.getElementById('withdrawals-list');
    if (!list)
        return;
    list.innerHTML = '';
    var items = Array.isArray(state.withdrawals) ? state.withdrawals : [];
    if (items.length === 0) {
        list.innerHTML = '<div style="font-size:12px; color:var(--text-dim); text-align:center;">Нет активных заявок</div>';
        return;
    }
    var fmtDate = function (v) {
        if (!v)
            return '';
        try {
            var d = new Date(v);
            if (isNaN(d.getTime()))
                return String(v);
            return d.toLocaleString('ru-RU', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });
        }
        catch (_a) {
            return String(v);
        }
    };
    items.forEach(function (w) {
        var _a, _b, _c, _d, _e, _f;
        var amount = Number((_c = (_b = (_a = w.amount_rub) !== null && _a !== void 0 ? _a : w.amount) !== null && _b !== void 0 ? _b : w.sum) !== null && _c !== void 0 ? _c : 0);
        var created = (_f = (_e = (_d = w.created_at) !== null && _d !== void 0 ? _d : w.date) !== null && _e !== void 0 ? _e : w.created) !== null && _f !== void 0 ? _f : '';
        var status = String(w.status || 'pending');
        var stClass = 'st-pending';
        var stText = 'Ожидание';
        if (status === 'paid') {
            stClass = 'st-paid';
            stText = 'Выплачено';
        }
        if (status === 'rejected') {
            stClass = 'st-rejected';
            stText = 'Отклонено';
        }
        list.insertAdjacentHTML('beforeend', "\n            <div style=\"background:var(--glass); padding:10px; border-radius:12px; display:flex; justify-content:space-between; align-items:center;\">\n                <div>\n                    <div style=\"font-weight:700; font-size:13px;\">".concat(amount.toFixed(0), " \u20BD</div>\n                    <div style=\"font-size:10px; color:var(--text-dim);\">").concat(fmtDate(created), "</div>\n                </div>\n                <div class=\"status-badge ").concat(stClass, "\">").concat(stText, "</div>\n            </div>\n        "));
    });
}
window.openModal = function (id) {
    document.getElementById(id).classList.add('active');
    if (id === 'm-create') {
        document.getElementById('t-target').value = '';
        document.getElementById('t-text').value = '';
        document.getElementById('t-target-status').className = 'input-status';
        document.getElementById('t-target-status').innerHTML = '';
        isLinkValid = false;
        recalc();
    }
    if (id === 'm-withdraw') {
        renderWithdrawals();
    }
};

window.closeModal = function () {
    document.querySelectorAll('.overlay').forEach(function (o) { return o.classList.remove('active'); });
};

function (id) {
    document.getElementById(id).classList.add('active');
    if (id === 'm-create') {
        document.getElementById('t-target').value = '';
        document.getElementById('t-text').value = '';
        document.getElementById('t-target-status').className = 'input-status';
        document.getElementById('t-target-status').innerHTML = '';
        isLinkValid = false;
        recalc();
    }
    if (id === 'm-withdraw') {
        renderWithdrawals();
    }
}
;
window.closeModal = function () {
    document.querySelectorAll('.overlay').forEach(function (o) { return o.classList.remove('active'); });
};
