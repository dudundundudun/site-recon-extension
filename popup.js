// popup.js — логика сбора полного слепка страницы и генерации отчета для ИИ (v1.2 — с поддержкой WebSocket)

let latestReport = null;
let latestMarkdown = "";

const scanBtn = document.getElementById("scanBtn");
const copyAiBtn = document.getElementById("copyAiBtn");
const copyJsonBtn = document.getElementById("copyJsonBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");

// Функция, которая выполняется внутри страницы (в MAIN world), чтобы иметь доступ к window и перехваченным логам
function collectPageReconInMainWorld() {
  // 1. Умный генератор селекторов: приоритет data-testid, id, role и aria-label
  const getSelector = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const tag = el.tagName.toLowerCase();
    const testId =
      el.getAttribute("data-testid") ||
      el.getAttribute("data-test") ||
      el.getAttribute("data-qa") ||
      el.getAttribute("data-cy");
    if (testId) return `${tag}[data-testid="${testId}"]`;
    if (el.id && !/^\d/.test(el.id)) return `${tag}#${el.id}`;

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.length <= 36) {
      return `${tag}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
    }

    const classes = Array.from(el.classList || [])
      .filter((c) => c && !c.includes(":"))
      .slice(0, 3)
      .join(".");
    return `${tag}${classes ? "." + classes : ""}`;
  };

  // 2. Детектор современных фреймворков (React 18+ Fiber, Vue 3, Next.js, Nuxt, Webpack/Vite)
  const frameworks = new Set();
  if (
    window.React ||
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ||
    window.__reactResponderSystemActive ||
    document.querySelector("[data-reactroot], [data-reactid], #react-root")
  ) {
    frameworks.add("React");
  }

  // Проверка DOM-корней на внутренние ключи React Fiber / Vue 3
  const rootCandidates = [
    document.getElementById("root"),
    document.getElementById("app"),
    document.getElementById("react-root"),
    document.getElementById("__next"),
    document.body?.firstElementChild,
  ].filter(Boolean);

  for (const node of rootCandidates) {
    const keys = Object.keys(node);
    if (keys.some((k) => k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$"))) {
      frameworks.add("React (Fiber 18+)");
    }
    if (keys.some((k) => k.startsWith("__vue_app__") || k === "__vue__")) {
      frameworks.add("Vue.js");
    }
  }

  if (window.__NEXT_DATA__) frameworks.add("Next.js (__NEXT_DATA__)");
  if (window.__NUXT__ || window.$nuxt) frameworks.add("Nuxt.js");
  if (window.Vue || document.querySelector("[data-v-app]")) frameworks.add("Vue.js");
  if (window.angular || document.querySelector("[ng-version]")) frameworks.add("Angular");
  if (window.jQuery || window.$?.fn?.jquery) frameworks.add("jQuery");
  if (window.Shopify) frameworks.add("Shopify");
  if (Object.keys(window).some((k) => k.startsWith("webpackChunk"))) frameworks.add("Webpack Bundler");

  // Интересные нестандартные переменные в window
  const defaultGlobals = new Set([
    "window", "self", "document", "name", "location", "customElements", "history",
    "navigation", "locationbar", "menubar", "personalbar", "scrollbars", "statusbar",
    "toolbar", "status", "closed", "frames", "length", "top", "opener", "parent",
    "frameElement", "navigator", "origin", "external", "screen", "innerWidth",
    "innerHeight", "scrollX", "pageXOffset", "scrollY", "pageYOffset", "visualViewport",
    "screenX", "screenY", "outerWidth", "outerHeight", "devicePixelRatio", "clientInformation",
    "screenLeft", "screenTop", "styleMedia", "onsearch", "isSecureContext", "trustedTypes",
    "performance", "onappinstalled", "onbeforeinstallprompt", "crypto", "indexedDB",
    "sessionStorage", "localStorage", "onbeforexrselect", "onabort", "onbeforeinput",
    "onbeforematch", "onbeforetoggle", "onblur", "oncancel", "oncanplay", "oncanplaythrough",
    "onchange", "onclick", "onclose", "oncontentvisibilityautostatechange", "oncontextlost",
    "oncontextmenu", "oncontextrestored", "oncuechange", "ondblclick", "ondrag", "ondragend",
    "ondragenter", "ondragleave", "ondragover", "ondragstart", "ondrop", "ondurationchange",
    "onemptied", "onended", "onerror", "onfocus", "onformdata", "oninput", "oninvalid",
    "onkeydown", "onkeypress", "onkeyup", "onload", "onloadeddata", "onloadedmetadata",
    "onloadstart", "onmousedown", "onmouseenter", "onmouseleave", "onmousemove", "onmouseout",
    "onmouseover", "onmouseup", "onmousewheel", "onpause", "onplay", "onplaying", "onprogress",
    "onratechange", "onreset", "onresize", "onscroll", "onscrollend", "onsecuritypolicyviolation",
    "onseeked", "onseeking", "onselect", "onslotchange", "onstalled", "onsubmit", "onsuspend",
    "ontimeupdate", "ontoggle", "onvolumechange", "onwaiting", "onwebkitanimationend",
    "onwebkitanimationiteration", "onwebkitanimationstart", "onwebkittransitionend", "onwheel",
    "onauxclick", "ongotpointercapture", "onlostpointercapture", "onpointerdown", "onpointermove",
    "onpointerrawupdate", "onpointerup", "onpointercancel", "onpointerover", "onpointerout",
    "onpointerenter", "onpointerleave", "onselectstart", "onselectionchange", "onanimationend",
    "onanimationiteration", "onanimationstart", "ontransitionrun", "ontransitionstart",
    "ontransitionend", "ontransitioncancel", "onafterprint", "onbeforeprint", "onbeforeunload",
    "onhashchange", "onlanguagechange", "onmessage", "onmessageerror", "onoffline", "ononline",
    "onpagehide", "onpageshow", "onpopstate", "onrejectionhandled", "onstorage", "onunhandledrejection",
    "onunload", "crossOriginIsolated", "scheduler", "alert", "atob", "blur", "btoa", "cancelAnimationFrame",
    "cancelIdleCallback", "captureEvents", "clearInterval", "clearTimeout", "close", "confirm",
    "createImageBitmap", "fetch", "find", "focus", "getComputedStyle", "getSelection", "matchMedia",
    "moveBy", "moveTo", "open", "postMessage", "print", "prompt", "queueMicrotask", "releaseEvents",
    "reportError", "requestAnimationFrame", "requestIdleCallback", "resizeBy", "resizeTo", "scroll",
    "scrollBy", "scrollTo", "setInterval", "setTimeout", "stop", "structuredClone", "webkitCancelAnimationFrame",
    "webkitRequestAnimationFrame", "chrome", "caches", "cookieStore", "ondevicemotion", "ondeviceorientation",
    "ondeviceorientationabsolute", "launchQueue", "sharedStorage", "documentPictureInPicture",
    "ontouchcancel", "ontouchend", "ontouchmove", "ontouchstart", "getScreenDetails", "queryLocalFonts",
    "showDirectoryPicker", "showOpenFilePicker", "showSaveFilePicker", "originAgentCluster",
    "onpageswap", "onpagereveal", "credentialless", "fence", "speechSynthesis", "onscrollsnapchange",
    "onscrollsnapchanging", "event", "oncommand", "onanimationcancel", "fetchLater", "viewport",
    "ongamepadconnected", "ongamepaddisconnected", "__AI_RECON_HOOKED__", "__AI_RECON_NET_LOG__", "__AI_RECON_WS_LOG__"
  ]);

  const customWindowKeys = Object.keys(window)
    .filter((k) => !defaultGlobals.has(k) && !k.startsWith("webkit") && !/^\d+$/.test(k))
    .slice(0, 60);

  // 3. Сбор ключевых семантических контейнеров и зон с data-testid (вместо пустых div-оберток)
  const semanticLandmarks = Array.from(
    document.querySelectorAll("main, nav, header, footer, article, section, [data-testid], [role='main'], [role='feed'], [role='region']")
  )
    .slice(0, 45)
    .map((el) => ({
      selector: getSelector(el),
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute("data-testid") || undefined,
      role: el.getAttribute("role") || undefined,
      ariaLabel: el.getAttribute("aria-label") || undefined,
      childCount: el.children.length,
    }));

  const buildSkeleton = (root, depth = 0, maxDepth = 3) => {
    if (!root || depth > maxDepth) return null;
    const children = Array.from(root.children || [])
      .filter((el) => !["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "LINK", "META"].includes(el.tagName))
      .slice(0, 12);

    return {
      selector: getSelector(root),
      attrs: {
        role: root.getAttribute?.("role") || undefined,
        dataAttrs: Array.from(root.attributes || [])
          .filter((a) => a.name.startsWith("data-"))
          .map((a) => `${a.name}="${a.value.slice(0, 40)}"`)
          .slice(0, 5),
      },
      children: children.map((c) => buildSkeleton(c, depth + 1, maxDepth)).filter(Boolean),
    };
  };

  // 4. Сбор интерактивных элементов с извлечением data-testid, aria-label и title
  const interactiveElements = Array.from(
    document.querySelectorAll("button, input, select, textarea, a[href], [role='button'], [data-testid]")
  )
    .filter((el) => {
      const tag = el.tagName.toLowerCase();
      return ["button", "input", "select", "textarea", "a"].includes(tag) || el.getAttribute("role") === "button";
    })
    .slice(0, 55)
    .map((el) => ({
      selector: getSelector(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      testId: el.getAttribute("data-testid") || undefined,
      ariaLabel: el.getAttribute("aria-label") || el.getAttribute("title") || undefined,
      name: el.getAttribute("name") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      text: (el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 60),
      href: el.getAttribute("href") ? el.getAttribute("href").slice(0, 120) : undefined,
    }));

  // 5. Сбор медиа-элементов с фильтрацией мелких иконок/эмодзи и дедупликацией
  const seenImgSrc = new Set();
  const contentImages = [];
  const smallIconsOrAvatars = [];

  for (const el of document.querySelectorAll("img, canvas, picture source")) {
    const src = el.currentSrc || el.src || el.getAttribute("data-src") || el.getAttribute("srcset") || null;
    if (!src || seenImgSrc.has(src)) continue;
    if (src.includes("/emoji/") || src.startsWith("data:image/svg")) continue;
    seenImgSrc.add(src);

    const w = el.naturalWidth || el.width || el.clientWidth || 0;
    const h = el.naturalHeight || el.height || el.clientHeight || 0;
    const item = {
      selector: getSelector(el),
      parentSelector: getSelector(el.parentElement),
      src,
      width: w,
      height: h,
      alt: el.getAttribute("alt") ? el.getAttribute("alt").slice(0, 40) : undefined,
    };

    if (w >= 100 || h >= 100) {
      if (contentImages.length < 30) contentImages.push(item);
    } else {
      if (smallIconsOrAvatars.length < 15) smallIconsOrAvatars.push(item);
    }
  }

  const videosAndStreams = Array.from(document.querySelectorAll("video, audio, video source, iframe"))
    .slice(0, 25)
    .map((el) => ({
      selector: getSelector(el),
      parentSelector: getSelector(el.parentElement),
      src: el.currentSrc || el.src || el.getAttribute("data-src") || null,
      poster: el.getAttribute("poster") || undefined,
    }));

  // 6. Сетевая активность из Performance API (расширенный фильтр: graphql, /i/api/, m4s, m3u8, mpd)
  const perfResources = (performance.getEntriesByType("resource") || [])
    .filter((r) => {
      const u = r.name.toLowerCase();
      return (
        r.initiatorType === "fetch" ||
        r.initiatorType === "xmlhttprequest" ||
        u.includes("graphql") ||
        u.includes("api") ||
        u.includes(".m3u8") ||
        u.includes(".mpd") ||
        u.includes(".m4s") ||
        u.includes(".mp4") ||
        u.includes(".json")
      );
    })
    .slice(-60)
    .map((r) => ({
      initiatorType: r.initiatorType,
      url: r.name,
      durationMs: Math.round(r.duration),
      transferSize: r.transferSize || 0,
    }));

  // 7. Хранилища с автоматической маскировкой приватных токенов (JWT, auth, session, secret)
  const SENSITIVE_KEY_RE = /(token|jwt|auth|secret|password|passwd|session|sess|cookie|apikey|api_key|bearer)/i;
  const JWT_VALUE_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

  const maskValueIfNeeded = (key, val) => {
    if (typeof val !== "string") return val;
    if (SENSITIVE_KEY_RE.test(key) || JWT_VALUE_RE.test(val.trim())) {
      return `[REDACTED_SENSITIVE_VALUE (len=${val.length})]`;
    }
    return val.length > 250 ? val.slice(0, 250) + "... [обрезано]" : val;
  };

  const dumpStorage = (store) => {
    const out = {};
    try {
      for (let i = 0; i < Math.min(store.length, 35); i++) {
        const key = store.key(i);
        const val = store.getItem(key) || "";
        out[key] = maskValueIfNeeded(key, val);
      }
    } catch (_) {}
    return out;
  };

  // 8. JSON-скрипты внутри страницы (__NEXT_DATA__, application/ld+json и т.д.)
  const inlineJsonScripts = Array.from(
    document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__')
  )
    .slice(0, 10)
    .map((s) => ({
      id: s.id || null,
      type: s.type || null,
      preview: (s.textContent || "").trim().slice(0, 800),
    }));

  return {
    meta: {
      url: location.href,
      origin: location.origin,
      pathname: location.pathname,
      title: document.title,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    },
    techStack: {
      detectedFrameworks: Array.from(frameworks),
      customWindowGlobals: customWindowKeys,
      inlineJsonScripts,
    },
    domStructure: {
      semanticLandmarks,
      interactiveElements,
      skeleton: buildSkeleton(document.body, 0, 3),
    },
    mediaAndAssets: {
      contentImages,
      smallIconsOrAvatars,
      videosAndStreams,
    },
    network: {
      interceptedRequests: window.__AI_RECON_NET_LOG__ || [],
      webSockets: window.__AI_RECON_WS_LOG__ || [],
      performanceResourceEntries: perfResources,
    },
    storage: {
      localStorage: dumpStorage(window.localStorage),
      sessionStorage: dumpStorage(window.sessionStorage),
      cookieNames: document.cookie
        ? Array.from(new Set(document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean)))
        : [],
    },
  };
}

// Форматирование отчета в готовый промпт для ИИ (Claude / GPT / Gemini / DeepSeek)
function formatAsAiMarkdown(report) {
  return [
    `# AI Site Recon Report: ${report.meta.title || report.meta.url}`,
    `- **URL**: ${report.meta.url}`,
    `- **Timestamp**: ${report.meta.timestamp}`,
    `- **Detected Stack**: ${report.techStack.detectedFrameworks.join(", ") || "Vanilla / Unknown"}`,
    `- **Custom Window Globals**: \`${report.techStack.customWindowGlobals.slice(0, 30).join("`, `")}\``,
    "",
    "## Контекст для ИИ",
    "Ниже находится полный технический слепок веб-страницы (семантические узлы с `data-testid` и `aria-label`, крупные медиа-контейнеры, перехваченные запросы Fetch/XHR/GraphQL, соединения WebSocket с примерами фреймов, а также ключи localStorage/cookies с замаскированными секретами). Используй эти реальные селекторы и эндпоинты для написания расширения, парсера или пользовательского скрипта без выдумывания несуществующих классов.",
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
  ].join("\n");
}

scanBtn.addEventListener("click", async () => {
  statusEl.textContent = "⏳ Сканирую DOM, Fiber, сеть и WebSocket...";
  scanBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error("Не удалось получить активную вкладку.");
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: collectPageReconInMainWorld,
    });

    const report = results?.[0]?.result;
    if (!report) {
      throw new Error("Не удалось собрать данные со страницы (возможно, это системная страница chrome://).");
    }

    // Дополним метаданными кук через chrome.cookies API (без значений, только имена и флаги)
    try {
      const allCookies = await chrome.cookies.getAll({ url: tab.url });
      report.storage.allCookieMeta = allCookies.map((c) => ({
        name: c.name,
        domain: c.domain,
        httpOnly: c.httpOnly,
        secure: c.secure,
      }));
    } catch (_) {}

    latestReport = report;
    latestMarkdown = formatAsAiMarkdown(report);

    // Автоматически копируем готовый промпт в буфер обмена сразу после нажатия большой кнопки
    await navigator.clipboard.writeText(latestMarkdown);

    const netCount =
      (report.network.interceptedRequests?.length || 0) +
      (report.network.performanceResourceEntries?.length || 0);
    const wsCount = report.network.webSockets?.length || 0;
    const imgCount = report.mediaAndAssets.contentImages?.length || 0;

    statusEl.textContent = `✅ Скопировано! (HTTP: ${netCount}, WS: ${wsCount}, Медиа: ${imgCount})`;
    previewEl.style.display = "block";
    previewEl.textContent = JSON.stringify(
      {
        url: report.meta.url,
        frameworks: report.techStack.detectedFrameworks,
        landmarksFound: report.domStructure.semanticLandmarks.length,
        interceptedHttp: report.network.interceptedRequests.length,
        webSockets: wsCount,
        perfEntries: report.network.performanceResourceEntries.length,
        contentImages: imgCount,
      },
      null,
      2
    );

    copyAiBtn.disabled = false;
    copyJsonBtn.disabled = false;
    downloadBtn.disabled = false;
  } catch (err) {
    statusEl.textContent = `❌ Ошибка: ${err.message}`;
  } finally {
    scanBtn.disabled = false;
  }
});

copyAiBtn.addEventListener("click", async () => {
  if (!latestMarkdown) return;
  await navigator.clipboard.writeText(latestMarkdown);
  statusEl.textContent = "📋 Промпт для ИИ (Markdown + JSON) скопирован!";
});

copyJsonBtn.addEventListener("click", async () => {
  if (!latestReport) return;
  await navigator.clipboard.writeText(JSON.stringify(latestReport, null, 2));
  statusEl.textContent = "{ } Чистый JSON скопирован в буфер обмена!";
});

downloadBtn.addEventListener("click", () => {
  if (!latestMarkdown) return;
  const blob = new Blob([latestMarkdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const host = new URL(latestReport.meta.url).hostname.replace(/[^a-z0-9.-]/gi, "_");
  const a = document.createElement("a");
  a.href = url;
  a.download = `site-recon-${host}-${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
  statusEl.textContent = "💾 Файл отчета сохранен!";
});