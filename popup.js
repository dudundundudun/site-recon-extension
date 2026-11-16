// popup.js — логика сбора полного слепка страницы и генерации отчета для ИИ

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
  const getSelector = (el) => {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `#${el.id}`;
    const classes = Array.from(el.classList || [])
      .filter((c) => c && !c.includes(":"))
      .slice(0, 3)
      .join(".");
    return `${el.tagName.toLowerCase()}${classes ? "." + classes : ""}`;
  };

  // 1. Определение фреймворков и глобальных объектов
  const frameworks = [];
  if (window.React || document.querySelector("[data-reactroot], [data-reactid]")) frameworks.push("React");
  if (window.__NEXT_DATA__) frameworks.push("Next.js (__NEXT_DATA__ present)");
  if (window.__NUXT__ || window.$nuxt) frameworks.push("Nuxt.js");
  if (window.Vue || document.querySelector("[data-v-app]")) frameworks.push("Vue");
  if (window.angular || document.querySelector("[ng-version]")) frameworks.push("Angular");
  if (window.jQuery || window.$?.fn?.jquery) frameworks.push("jQuery");
  if (window.Shopify) frameworks.push("Shopify");

  // Интересные не-стандартные переменные в window (полезно для поиска скрытых конфигов/API/читалок)
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
    "onscrollsnapchanging", "__AI_RECON_HOOKED__", "__AI_RECON_NET_LOG__"
  ]);

  const customWindowKeys = Object.keys(window)
    .filter((k) => !defaultGlobals.has(k) && !k.startsWith("webkit"))
    .slice(0, 60);

  // 2. Сбор ключевых DOM-узлов и селекторов
  const buildSkeleton = (root, depth = 0, maxDepth = 4) => {
    if (!root || depth > maxDepth) return null;
    const children = Array.from(root.children || [])
      .filter((el) => !["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "LINK", "META"].includes(el.tagName))
      .slice(0, 15);

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

  // 3. Сбор интерактивных элементов (кнопки, инпуты, формы)
  const interactiveElements = Array.from(
    document.querySelectorAll("button, input, select, textarea, a[href], [role='button']")
  )
    .slice(0, 50)
    .map((el) => ({
      selector: getSelector(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      name: el.getAttribute("name") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      text: (el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 60),
      href: el.getAttribute("href") ? el.getAttribute("href").slice(0, 120) : undefined,
    }));

  // 4. Сбор медиа-элементов и картинок (особенно важно для парсеров манги/видео)
  const images = Array.from(document.querySelectorAll("img, canvas, picture source"))
    .slice(0, 40)
    .map((el) => ({
      selector: getSelector(el),
      parentSelector: getSelector(el.parentElement),
      src: el.currentSrc || el.src || el.getAttribute("data-src") || el.getAttribute("srcset") || null,
      width: el.width || el.clientWidth || 0,
      height: el.height || el.clientHeight || 0,
      loading: el.getAttribute("loading") || undefined,
    }));

  const videosAndStreams = Array.from(document.querySelectorAll("video, audio, video source, iframe"))
    .slice(0, 25)
    .map((el) => ({
      selector: getSelector(el),
      src: el.currentSrc || el.src || el.getAttribute("data-src") || null,
    }));

  // 5. Сетевая активность из Performance API (включая m3u8, mp4, webp, json, api)
  const perfResources = (performance.getEntriesByType("resource") || [])
    .filter((r) => {
      const u = r.name.toLowerCase();
      return (
        r.initiatorType === "fetch" ||
        r.initiatorType === "xmlhttprequest" ||
        u.includes(".m3u8") ||
        u.includes(".mpd") ||
        u.includes(".mp4") ||
        u.includes("/api/") ||
        u.includes("graphql") ||
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

  // 6. Хранилища: localStorage и sessionStorage (только ключи и превью значений)
  const dumpStorage = (store) => {
    const out = {};
    try {
      for (let i = 0; i < Math.min(store.length, 35); i++) {
        const key = store.key(i);
        const val = store.getItem(key) || "";
        out[key] = val.length > 250 ? val.slice(0, 250) + "... [обрезано]" : val;
      }
    } catch (_) {}
    return out;
  };

  // 7. JSON-скрипты внутри страницы (__NEXT_DATA__, application/ld+json и т.д.)
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
      detectedFrameworks: frameworks,
      customWindowGlobals: customWindowKeys,
      inlineJsonScripts,
    },
    domStructure: {
      skeleton: buildSkeleton(document.body, 0, 3),
      interactiveElements,
    },
    mediaAndAssets: {
      images,
      videosAndStreams,
    },
    network: {
      interceptedRequests: window.__AI_RECON_NET_LOG__ || [],
      performanceResourceEntries: perfResources,
    },
    storage: {
      localStorage: dumpStorage(window.localStorage),
      sessionStorage: dumpStorage(window.sessionStorage),
      cookieNames: document.cookie
        ? document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean)
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
    "Ниже находится полный технический слепок веб-страницы (DOM-селекторы, медиа-контейнеры, перехваченные запросы Fetch/XHR с заголовками и ответами, а также ключи localStorage/cookies). Используй эти реальные селекторы и эндпоинты для написания расширения, парсера или пользовательского скрипта без выдумывания несуществующих классов.",
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
  ].join("\n");
}

scanBtn.addEventListener("click", async () => {
  statusEl.textContent = "⏳ Сканирую DOM, сеть и хранилища...";
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

    // Дополним именами httpOnly кук через chrome.cookies API, если есть доступ
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

    // Автоматически копируем готовый промпт в буфер обмена сразу после нажатия большой кнопки!
    await navigator.clipboard.writeText(latestMarkdown);

    const netCount =
      (report.network.interceptedRequests?.length || 0) +
      (report.network.performanceResourceEntries?.length || 0);
    const imgCount = report.mediaAndAssets.images?.length || 0;

    statusEl.textContent = `✅ Готово! Скопировано в буфер (Сеть: ${netCount}, Медиа: ${imgCount})`;
    previewEl.style.display = "block";
    previewEl.textContent = JSON.stringify(
      {
        url: report.meta.url,
        frameworks: report.techStack.detectedFrameworks,
        interceptedRequests: report.network.interceptedRequests.length,
        perfEntries: report.network.performanceResourceEntries.length,
        imagesSampled: imgCount,
        globalsSample: report.techStack.customWindowGlobals.slice(0, 10),
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
