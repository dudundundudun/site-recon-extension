// recorder_bridge.js — работает в ISOLATED world, пересылает сетевые события из MAIN world, клики и переходы в background.js

(function () {
  if (window.__AI_RECON_BRIDGE__) return;
  window.__AI_RECON_BRIDGE__ = true;

  let isRecording = false;
  let lastUrl = location.href;

  function getCompactSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    const tag = el.tagName.toLowerCase();
    const testAttrs = [
      "data-testid",
      "data-test",
      "data-qa",
      "data-widget",
      "data-autotest-id",
    ];
    for (const attr of testAttrs) {
      const val = el.getAttribute(attr);
      if (val) return `${tag}[${attr}="${val.replace(/"/g, '\\"')}"]`;
    }
    if (el.id && !/^\d/.test(el.id)) return `${tag}#${el.id}`;
    const aria = el.getAttribute("aria-label");
    if (aria && aria.length <= 60) {
      return `${tag}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
    }
    const classes = Array.from(el.classList || [])
      .filter((c) => c && !c.includes(":") && !c.includes("["))
      .slice(0, 3)
      .join(".");
    return `${tag}${classes ? "." + classes : ""}`;
  }

  function getNearestContext(el) {
    let cur = el?.parentElement;
    let steps = 0;
    while (cur && cur !== document.body && steps < 6) {
      const w =
        cur.getAttribute("data-widget") ||
        cur.getAttribute("data-testid") ||
        cur.getAttribute("data-component");
      if (w) return `${cur.tagName.toLowerCase()}[${w}]`;
      if (cur.id && !/^\d/.test(cur.id)) return `#${cur.id}`;
      cur = cur.parentElement;
      steps++;
    }
    return undefined;
  }

  function collectWidgetsSnapshot() {
    const set = new Set();
    try {
      for (const el of document.querySelectorAll("[data-widget], [data-component], [data-block]")) {
        const w =
          el.getAttribute("data-widget") ||
          el.getAttribute("data-component") ||
          el.getAttribute("data-block");
        if (w) set.add(w);
        if (set.size >= 50) break;
      }
    } catch (_) {}
    return Array.from(set);
  }

  function sendEvent(kind, payload) {
    if (!isRecording) return;
    try {
      chrome.runtime.sendMessage({ type: "RECON_EVENT", kind, payload }).catch(() => {});
    } catch (_) {}
  }

  function sendPageVisit() {
    if (!isRecording) return;
    sendEvent("page_visit", {
      url: location.href,
      pathname: location.pathname,
      title: document.title || "",
      timestamp: new Date().toISOString(),
      widgets: collectWidgetsSnapshot(),
    });
  }

  // Проверяем статус записи при загрузке страницы
  try {
    chrome.runtime.sendMessage({ type: "RECON_GET_STATUS" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.active) {
        isRecording = true;
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", () => setTimeout(sendPageVisit, 400), { once: true });
        } else {
          setTimeout(sendPageVisit, 400);
        }
      }
    });
  } catch (_) {}

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "RECON_RECORDING_STATE") {
      isRecording = Boolean(msg.active);
      if (isRecording) {
        sendPageVisit();
      }
    }
  });

  // Мост от MAIN world (interceptor.js)
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || !event.data.__aiReconEvent) return;
    if (!isRecording) return;
    if (event.data.kind === "net") {
      sendEvent("net", event.data.entry);
    } else if (event.data.kind === "ws") {
      sendEvent("ws", event.data.ws);
    }
  });

  // Запись кликов по интерактивным элементам
  document.addEventListener(
    "click",
    (e) => {
      if (!isRecording) return;
      const target = e.target?.closest?.("button, a, input, select, [role='button'], [data-widget], [data-testid]");
      if (!target) return;
      const text = (target.innerText || target.value || "").trim().replace(/\s+/g, " ").slice(0, 50);
      sendEvent("action", {
        type: "click",
        selector: getCompactSelector(target),
        text: text || undefined,
        context: getNearestContext(target),
        pathname: location.pathname,
        timestamp: new Date().toISOString(),
      });
    },
    true
  );

  // Запись отправки форм
  document.addEventListener(
    "submit",
    (e) => {
      if (!isRecording) return;
      sendEvent("action", {
        type: "submit",
        selector: getCompactSelector(e.target),
        pathname: location.pathname,
        timestamp: new Date().toISOString(),
      });
    },
    true
  );

  // Отслеживание SPA-переходов (History API / hashchange)
  const checkNavigation = () => {
    if (!isRecording) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(sendPageVisit, 600);
    }
  };
  window.addEventListener("popstate", checkNavigation);
  window.addEventListener("hashchange", checkNavigation);
  setInterval(checkNavigation, 1000);
})();
