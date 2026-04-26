(function () {
  "use strict";

  // --- Performance Mode Detection ---
  try {
    var saved = '';
    try { saved = String(localStorage.getItem('rc_perf_mode_v1') || '').trim(); } catch (e) {}
    var isLow = saved === 'low';
    if (!isLow && saved !== 'normal') {
      var score = 0;
      var mm = false;
      try { mm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
      if (mm) score += 3;

      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
      var effectiveType = conn && conn.effectiveType ? String(conn.effectiveType) : '';
      if (conn && conn.saveData) score += 3;
      if (/2g|3g/i.test(effectiveType)) score += 2;

      var mem = Number(navigator.deviceMemory || 0);
      if (mem && mem <= 2) score += 3;
      else if (mem && mem <= 4) score += 2;

      var cores = Number(navigator.hardwareConcurrency || 0);
      if (cores && cores <= 4) score += 2;
      else if (cores && cores <= 6) score += 1;

      var sw = Math.min(Number((window.screen && window.screen.width) || 0), Number(window.innerWidth || 0)) || Number((window.screen && window.screen.width) || 0) || Number(window.innerWidth || 0) || 0;
      if (sw && sw <= 430) score += 1;

      var ua = String(navigator.userAgent || '');
      if (/Android/i.test(ua) && (!cores || cores <= 8)) score += 1;

      isLow = score >= 2;
    }
    if (isLow) document.documentElement.classList.add('perf-low');
  } catch (e) {}

  // --- Global Error Handling ---
  function box() { return document.getElementById("global-error-box"); }
  function hideLoader() { var l = document.getElementById("loader"); if (l) l.style.display = "none"; }

  window.__showError = function (msg, err) {
    try {
      var b = box();
      if (b) {
        b.style.display = "block";
        b.textContent = String(msg) + (err ? ("\n\n" + (err.stack || err.message || String(err))) : "");
      }
    } catch (e) {}
    hideLoader();
    try { console.error(msg, err); } catch (e2) {}
  };

  window.addEventListener("error", function (event) {
    var t = event && event.target;
    var tag = t && t.tagName ? String(t.tagName).toUpperCase() : "";
    var url = t && (t.src || t.href);

    // FIX: не показываем красную плашку из-за картинок/шрифтов/фавикона
    if (url) {
      var u = String(url);
      if (tag === "IMG") return;
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(u)) return;
      if (/\/favicon\.ico(\?|$)/i.test(u)) return;
      return window.__showError("Не удалось загрузить ресурс: " + u);
    }

    window.__showError("Ошибка: " + (event.message || "Unknown error"), event.error);
  }, true);

  window.addEventListener("unhandledrejection", function (event) {
    window.__showError("Unhandled Promise rejection: " + ((event.reason && event.reason.message) || String(event.reason)), event.reason);
  });

})();
