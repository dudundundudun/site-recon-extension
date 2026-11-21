// popup.js — логика сбора полного слепка страницы, режима записи сессии и генерации отчета для ИИ (v1.4.0)

const EXTENSION_VERSION = "1.4.0";
const MAX_REPORT_BYTES = 180 * 1024;

let latestReport = null;
let latestMarkdown = "";
let isRecordingActive = false;

const scanBtn = document.getElementById("scanBtn");
const recordBtn = document.getElementById("recordBtn");
const copyAiBtn = document.getElementById("copyAiBtn");
const copyJsonBtn = document.getElementById("copyJsonBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");

// Функция, которая выполняется внутри страницы (в MAIN world), чтобы иметь доступ к window и перехваченным логам
function collectPageReconInMainWorld() {
  const MAX_SHADOW_DEPTH = 3;
  const MAX_SHADOW_ROOTS = 60;
  const EXT_NODE_RE = /^(protonpass-|grammarly-|lt-highlighter|darkreader|__darkreader)/i;
  const isExtensionNode = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (EXT_NODE_RE.test(tag)) return true;
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith("data-protonpass") || attr.name.startsWith("data-grammarly")) {
        return true;
      }
    }
    return false;
  };

  const collectShadowRoots = (rootNode = document, maxDepth = MAX_SHADOW_DEPTH) => {
    const roots = [rootNode];
    const seen = new Set([rootNode]);
    const queue = [{ root: rootNode, depth: 0 }];

    while (queue.length > 0 && roots.length < MAX_SHADOW_ROOTS) {
      const { root, depth } = queue.shift();
      if (depth >= maxDepth) continue;
      let elements;
      try {
        elements = root.querySelectorAll("*");
      } catch (_) {
        continue;
      }
      for (const el of elements) {
        if (isExtensionNode(el)) continue;
        const sr = el.shadowRoot;
        if (sr && !seen.has(sr)) {
          seen.add(sr);
          roots.push(sr);
          if (roots.length >= MAX_SHADOW_ROOTS) break;
          queue.push({ root: sr, depth: depth + 1 });
        }
      }
    }
    return roots;
  };

  const allDomRoots = collectShadowRoots(document, MAX_SHADOW_DEPTH);

  const queryAllDeep = (selector) => {
    const results = [];
    for (const root of allDomRoots) {
      try {
        for (const el of root.querySelectorAll(selector)) {
          results.push(el);
        }
      } catch (_) {}
    }
    return results;
  };

  const isInsideShadowDom = (el) => {
    try {
      const root = el?.getRootNode?.();
      return Boolean(root && root !== document && root.host);
    } catch (_) {
      return false;
    }
  };

  const getParentOrHost = (node) => {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    try {
      const root = node.getRootNode?.();
      if (root && root !== document && root.host) return root.host;
    } catch (_) {}
    return null;
  };

  const SENSITIVE_INPUT_TYPE_RE = /^(password|email|tel|hidden)$/i;
  const SENSITIVE_INPUT_ATTR_RE = /(password|pass|token|secret|csrf|otp|card|cvv|cc-)/i;
  const SENSITIVE_QUERY_PARAM_RE =
    /^(token|access_token|refresh_token|api_key|apikey|key|auth|secret|sig|signature|session|password)$/i;
  const INLINE_SECRET_RE =
    /(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|"(?:token|access_token|refresh_token|auth|password|passwd|api_key|apiKey|secret|csrf|session|sessionId)"\s*:\s*"[^"]*")/gi;

  const isSensitiveInput = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;
    const type = (el.getAttribute("type") || "").trim();
    if (SENSITIVE_INPUT_TYPE_RE.test(type)) return true;
    const attrs = [
      el.getAttribute("name") || "",
      el.getAttribute("id") || "",
      el.getAttribute("autocomplete") || "",
    ].join(" ");
    return SENSITIVE_INPUT_ATTR_RE.test(attrs);
  };

  const sanitizeUrl = (rawUrl) => {
    if (typeof rawUrl !== "string" || !rawUrl) return rawUrl;
    if (!rawUrl.includes("?") && !rawUrl.includes("#")) return rawUrl;
    try {
      const isRelative = !/^[a-z][a-z0-9+.-]*:/i.test(rawUrl);
      const u = new URL(rawUrl, location.href);
      let changed = false;
      for (const [k] of Array.from(u.searchParams.entries())) {
        if (SENSITIVE_QUERY_PARAM_RE.test(k)) {
          u.searchParams.set(k, "[REDACTED]");
          changed = true;
        }
      }
      if (!changed) return rawUrl;
      return isRelative ? `${u.pathname}${u.search}${u.hash}` : u.toString();
    } catch (_) {
      return rawUrl.replace(
        /([?&](?:token|access_token|refresh_token|api_key|apikey|key|auth|secret|sig|signature|session|password)=)[^&#]*/gi,
        "$1[REDACTED]"
      );
    }
  };

  const redactSecretsInText = (text) => {
    if (typeof text !== "string") return "";
    return text.replace(INLINE_SECRET_RE, "[REDACTED_SECRET]");
  };

  const formatIdSelector = (tag, id) => {
    if (/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(id)) return `${tag}#${id}`;
    return `${tag}[id="${id.replace(/"/g, '\\"')}"]`;
  };

  // 1. Умный генератор селекторов: приоритет testid, auto, widget/apiary/zone, id, aria-label, name, классы
  const getSelector = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const tag = el.tagName.toLowerCase();

    const testAttrs = [
      "data-testid",
      "data-test",
      "data-qa",
      "data-cy",
      "data-auto",
      "data-autotest-id",
      "data-e2e",
      "data-automation-id",
    ];
    for (const attr of testAttrs) {
      const val = el.getAttribute(attr);
      if (val) return `${tag}[${attr}="${val.replace(/"/g, '\\"')}"]`;
    }

    const widgetAttrs = ["data-widget", "data-apiary-widget-name", "data-zone-name"];
    for (const attr of widgetAttrs) {
      const val = el.getAttribute(attr);
      if (val) return `${tag}[${attr}="${val.replace(/"/g, '\\"')}"]`;
    }

    if (el.id && !/^\d/.test(el.id)) return formatIdSelector(tag, el.id);

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.length <= 60) {
      return `${tag}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
    }

    const nameAttr = el.getAttribute("name");
    if (nameAttr) return `${tag}[name="${nameAttr.replace(/"/g, '\\"')}"]`;

    const classes = Array.from(el.classList || [])
      .filter((c) => c && !c.includes(":") && !c.includes("["))
      .slice(0, 3)
      .join(".");
    return `${tag}${classes ? "." + classes : ""}`;
  };

  const getNearestContext = (el) => {
    let cur = getParentOrHost(el);
    let steps = 0;
    while (cur && cur !== document.body && steps < 6) {
      const w =
        cur.getAttribute?.("data-widget") ||
        cur.getAttribute?.("data-apiary-widget-name") ||
        cur.getAttribute?.("data-zone-name") ||
        cur.getAttribute?.("data-testid") ||
        cur.getAttribute?.("data-auto") ||
        cur.getAttribute?.("data-component");
      if (w) return `${cur.tagName.toLowerCase()}[${w}]`;
      if (cur.id && !/^\d/.test(cur.id)) {
        return /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(cur.id) ? `#${cur.id}` : `[id="${cur.id}"]`;
      }
      if (["HEADER", "NAV", "MAIN", "FOOTER", "SECTION", "ARTICLE", "FORM"].includes(cur.tagName)) {
        return cur.tagName.toLowerCase();
      }
      if (cur.shadowRoot) {
        return `${cur.tagName.toLowerCase()}[shadow]`;
      }
      cur = getParentOrHost(cur);
      steps++;
    }
    return undefined;
  };

  // 2. Детектор современных фреймворков
  const frameworks = new Set();
  if (
    window.React ||
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ||
    window.__reactResponderSystemActive ||
    document.querySelector("[data-reactroot], [data-reactid], #react-root")
  ) {
    frameworks.add("React");
  }

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
    "ongamepadconnected", "ongamepaddisconnected", "__AI_RECON_HOOKED__", "__AI_RECON_NET_LOG__",
    "__AI_RECON_WS_LOG__", "__AI_RECON_FILTERED_COUNT__"
  ]);

  const customWindowKeys = Object.keys(window)
    .filter((k) => !defaultGlobals.has(k) && !k.startsWith("webkit") && !/^\d+$/.test(k))
    .slice(0, 60);

  // 3. Сбор семантических зон, виджетов (включая открытый Shadow DOM до 3 уровней) и скелета DOM
  const semanticLandmarks = queryAllDeep(
    "main, nav, header, footer, article, section, [data-testid], [role='main'], [role='feed'], [role='region']"
  )
    .filter((el) => !isExtensionNode(el))
    .slice(0, 45)
    .map((el) => ({
      selector: getSelector(el),
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute("data-testid") || undefined,
      role: el.getAttribute("role") || undefined,
      ariaLabel: el.getAttribute("aria-label") || undefined,
      childCount: el.children.length,
      inShadowDom: isInsideShadowDom(el) || undefined,
    }));

  const seenWidgets = new Set();
  const widgetContainers = [];
  const widgetQuery =
    "[data-widget], [data-component], [data-block], [data-apiary-widget-name], [data-zone-name], [data-auto]";
  for (const el of queryAllDeep(widgetQuery)) {
    if (isExtensionNode(el)) continue;
    const name =
      el.getAttribute("data-widget") ||
      el.getAttribute("data-apiary-widget-name") ||
      el.getAttribute("data-zone-name") ||
      el.getAttribute("data-component") ||
      el.getAttribute("data-block") ||
      el.getAttribute("data-auto");
    if (!name || seenWidgets.has(name)) continue;
    seenWidgets.add(name);
    widgetContainers.push({
      widget: name,
      selector: getSelector(el),
      childCount: el.children.length,
      textPreview: (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80) || undefined,
      inShadowDom: isInsideShadowDom(el) || undefined,
    });
    if (widgetContainers.length >= 45) break;
  }

  const buildSkeleton = (root, depth = 0, maxDepth = 5, shadowDepth = 0) => {
    if (!root || depth > maxDepth || isExtensionNode(root)) return null;
    const filterNodes = (list, limit) =>
      Array.from(list || [])
        .filter((el) => !["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "LINK", "META"].includes(el.tagName) && !isExtensionNode(el))
        .slice(0, limit);

    const children = filterNodes(root.children, 10)
      .map((c) => buildSkeleton(c, depth + 1, maxDepth, shadowDepth))
      .filter(Boolean);

    const node = {
      selector: getSelector(root),
      attrs: {
        role: root.getAttribute?.("role") || undefined,
        dataAttrs: Array.from(root.attributes || [])
          .filter((a) => a.name.startsWith("data-") && !a.name.startsWith("data-protonpass"))
          .map((a) => `${a.name}="${a.value.slice(0, 60)}"`)
          .slice(0, 5),
      },
      children,
    };

    if (root.shadowRoot && shadowDepth < MAX_SHADOW_DEPTH && depth < maxDepth) {
      const shadowChildren = filterNodes(root.shadowRoot.children, 6)
        .map((c) => buildSkeleton(c, depth + 1, maxDepth, shadowDepth + 1))
        .filter(Boolean);
      if (shadowChildren.length > 0) {
        node.shadowChildren = shadowChildren;
      }
    }

    return node;
  };

  // 4. Сбор интерактивных элементов с дедупликацией (включая открытый Shadow DOM)
  const selectorPatternCounts = new Map();
  const interactiveElements = [];

  for (const el of queryAllDeep("button, input, select, textarea, a[href], [role='button'], [data-testid]")) {
    if (isExtensionNode(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (!(["button", "input", "select", "textarea", "a"].includes(tag) || el.getAttribute("role") === "button")) {
      continue;
    }

    const selector = getSelector(el);
    const rawText = isSensitiveInput(el)
      ? (el.value ? "[REDACTED_INPUT]" : "")
      : (el.innerText || el.value || "");
    const text = rawText.trim().replace(/\s+/g, " ").slice(0, 60);
    const patternKey = `${selector}::${text ? "hasText" : "empty"}`;
    const count = selectorPatternCounts.get(patternKey) || 0;

    if (count >= 2) continue;
    selectorPatternCounts.set(patternKey, count + 1);

    interactiveElements.push({
      selector,
      tag,
      context: getNearestContext(el),
      type: el.getAttribute("type") || undefined,
      testId: el.getAttribute("data-testid") || el.getAttribute("data-auto") || undefined,
      ariaLabel: el.getAttribute("aria-label") || el.getAttribute("title") || undefined,
      name: el.getAttribute("name") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      text,
      href: el.getAttribute("href") ? el.getAttribute("href").slice(0, 120) : undefined,
      inShadowDom: isInsideShadowDom(el) || undefined,
    });

    if (interactiveElements.length >= 65) break;
  }

  // 5. Сбор медиа-элементов (включая открытый Shadow DOM)
  const seenImgSrc = new Set();
  const contentImages = [];
  const smallIconsOrAvatars = [];

  for (const el of queryAllDeep("img, canvas, picture source")) {
    const src = el.currentSrc || el.src || el.getAttribute("data-src") || el.getAttribute("srcset") || null;
    if (!src || seenImgSrc.has(src)) continue;
    if (src.includes("/emoji/") || src.startsWith("data:image/svg")) continue;
    seenImgSrc.add(src);

    const w = el.naturalWidth || el.width || el.clientWidth || 0;
    const h = el.naturalHeight || el.height || el.clientHeight || 0;
    const item = {
      selector: getSelector(el),
      parentSelector: getSelector(getParentOrHost(el)),
      src,
      width: w,
      height: h,
      alt: el.getAttribute("alt") ? el.getAttribute("alt").slice(0, 40) : undefined,
      inShadowDom: isInsideShadowDom(el) || undefined,
    };

    if (w >= 100 || h >= 100) {
      if (contentImages.length < 30) contentImages.push(item);
    } else {
      if (smallIconsOrAvatars.length < 15) smallIconsOrAvatars.push(item);
    }
  }

  const videosAndStreams = queryAllDeep("video, audio, video source, iframe")
    .slice(0, 25)
    .map((el) => ({
      selector: getSelector(el),
      parentSelector: getSelector(getParentOrHost(el)),
      src: el.currentSrc || el.src || el.getAttribute("data-src") || null,
      poster: el.getAttribute("poster") || undefined,
      inShadowDom: isInsideShadowDom(el) || undefined,
    }));

  // 6. Сетевая активность из Performance API с фильтрацией шума
  const PERF_NOISE_RE =
    /(empty\.gif|pop-stats-collector|perf-metrics-collector|\/rum\/|yandex\.ru\/clck\/|media-adv\.market\.yandex\.ru\/events|em\.market\.yandex\.ru\/|safeclick|static-mon\.yandex\.net)/i;
  const perfResources = (performance.getEntriesByType("resource") || [])
    .filter((r) => {
      const u = r.name.toLowerCase();
      if (PERF_NOISE_RE.test(u)) return false;
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
      url: sanitizeUrl(r.name),
      durationMs: Math.round(r.duration),
      transferSize: r.transferSize || 0,
    }));

  // 7. Хранилища с маскировкой секретов
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
        if (key && key.startsWith("__darkreader")) continue;
        const val = store.getItem(key) || "";
        out[key] = maskValueIfNeeded(key, val);
      }
    } catch (_) {}
    return out;
  };

  // 8. JSON-скрипты внутри страницы
  const inlineJsonScripts = Array.from(
    document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__')
  )
    .slice(0, 10)
    .map((s) => ({
      id: s.id || null,
      type: s.type || null,
      preview: redactSecretsInText((s.textContent || "").trim()).slice(0, 800),
    }));

  return {
    meta: {
      url: sanitizeUrl(location.href),
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
      shadowRootsFound: Math.max(0, allDomRoots.length - 1),
      semanticLandmarks,
      widgetContainers,
      interactiveElements,
      skeleton: buildSkeleton(document.body, 0, 5, 0),
    },
    mediaAndAssets: {
      contentImages,
      smallIconsOrAvatars,
      videosAndStreams,
    },
    network: {
      filteredNoiseCount: window.__AI_RECON_FILTERED_COUNT__ || 0,
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

function isSystemTabUrl(url) {
  return !url || /^(chrome|edge|about|chrome-extension):/i.test(url);
}

function getUtf8ByteLength(str) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str).length;
  }
  return str.length * 2;
}

function truncateStringField(val, maxLen) {
  if (typeof val !== "string" || val.length <= maxLen) return val;
  return val.slice(0, maxLen) + "... [trimmed]";
}

function pruneSkeletonTree(node, maxDepth, maxChildren, depth = 0) {
  if (!node || depth > maxDepth) return null;
  const pruned = {
    selector: node.selector,
    attrs: node.attrs,
    children: [],
  };
  if (depth < maxDepth && Array.isArray(node.children)) {
    pruned.children = node.children
      .slice(0, maxChildren)
      .map((child) => pruneSkeletonTree(child, maxDepth, maxChildren, depth + 1))
      .filter(Boolean);
  }
  if (depth < maxDepth && Array.isArray(node.shadowChildren) && node.shadowChildren.length > 0) {
    pruned.shadowChildren = node.shadowChildren
      .slice(0, Math.min(4, maxChildren))
      .map((child) => pruneSkeletonTree(child, maxDepth, maxChildren, depth + 1))
      .filter(Boolean);
  }
  return pruned;
}

function trimStorageObject(obj, maxKeys, maxValLen) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const key of Object.keys(obj).slice(0, maxKeys)) {
    out[key] = truncateStringField(obj[key], maxValLen);
  }
  return out;
}

function enforceReportSizeBudget(report, maxBytes = MAX_REPORT_BYTES) {
  const measure = (r) => getUtf8ByteLength(formatAsAiMarkdown(r));
  const originalBytes = measure(report);
  if (originalBytes <= maxBytes) {
    return report;
  }

  const appliedStages = [];
  const targetBytes = Math.max(4096, maxBytes - 512);

  // Этап 1: укорачиваем длинные превью тел запросов/ответов и встроенных JSON-скриптов
  if (measure(report) > targetBytes) {
    for (const req of report.network?.interceptedRequests || []) {
      if (req.responsePreview) req.responsePreview = truncateStringField(req.responsePreview, 300);
      if (req.requestBody) req.requestBody = truncateStringField(req.requestBody, 300);
    }
    for (const ep of report.sessionFlow?.uniqueEndpoints || []) {
      if (ep.responsePreview) ep.responsePreview = truncateStringField(ep.responsePreview, 300);
      if (ep.requestBodyPreview) ep.requestBodyPreview = truncateStringField(ep.requestBodyPreview, 300);
    }
    for (const s of report.techStack?.inlineJsonScripts || []) {
      if (s.preview) s.preview = truncateStringField(s.preview, 300);
    }
    appliedStages.push("shortened_previews");
  }

  // Этап 2: уменьшаем глубину DOM-скелета и второстепенные списки
  if (measure(report) > targetBytes) {
    if (report.domStructure?.skeleton) {
      report.domStructure.skeleton = pruneSkeletonTree(report.domStructure.skeleton, 3, 6);
    }
    if (report.mediaAndAssets?.smallIconsOrAvatars) {
      report.mediaAndAssets.smallIconsOrAvatars = report.mediaAndAssets.smallIconsOrAvatars.slice(0, 5);
    }
    if (report.network?.performanceResourceEntries) {
      report.network.performanceResourceEntries = report.network.performanceResourceEntries.slice(-25);
    }
    if (report.storage?.allCookieMeta) {
      report.storage.allCookieMeta = report.storage.allCookieMeta.slice(0, 20);
    }
    appliedStages.push("pruned_skeleton_and_secondary_lists");
  }

  // Этап 3: сжимаем сетевые превью и ограничиваем объёмные массивы
  if (measure(report) > targetBytes) {
    if (Array.isArray(report.network?.interceptedRequests)) {
      report.network.interceptedRequests = report.network.interceptedRequests.slice(-25).map((req) => ({
        ...req,
        requestBody: req.requestBody ? "[Trimmed for size budget]" : req.requestBody,
        responsePreview: req.responsePreview ? "[Trimmed for size budget]" : req.responsePreview,
      }));
    }
    if (Array.isArray(report.sessionFlow?.uniqueEndpoints)) {
      report.sessionFlow.uniqueEndpoints = report.sessionFlow.uniqueEndpoints.slice(0, 40).map((ep) => ({
        ...ep,
        requestBodyPreview: ep.requestBodyPreview ? "[Trimmed for size budget]" : ep.requestBodyPreview,
        responsePreview: ep.responsePreview ? "[Trimmed for size budget]" : ep.responsePreview,
      }));
    }
    if (report.domStructure?.interactiveElements) {
      report.domStructure.interactiveElements = report.domStructure.interactiveElements.slice(0, 35);
    }
    if (report.domStructure?.semanticLandmarks) {
      report.domStructure.semanticLandmarks = report.domStructure.semanticLandmarks.slice(0, 25);
    }
    if (report.domStructure?.widgetContainers) {
      report.domStructure.widgetContainers = report.domStructure.widgetContainers.slice(0, 25);
    }
    if (report.mediaAndAssets?.contentImages) {
      report.mediaAndAssets.contentImages = report.mediaAndAssets.contentImages.slice(0, 15);
    }
    appliedStages.push("compacted_network_and_dom_lists");
  }

  // Этап 4: жёсткое усечение, если отчёт всё ещё превышает бюджет
  if (measure(report) > targetBytes) {
    if (report.domStructure) {
      report.domStructure.skeleton = null;
    }
    if (report.techStack?.inlineJsonScripts) {
      report.techStack.inlineJsonScripts = report.techStack.inlineJsonScripts.slice(0, 3).map((s) => ({
        ...s,
        preview: truncateStringField(s.preview, 120),
      }));
    }
    if (report.storage) {
      report.storage.localStorage = trimStorageObject(report.storage.localStorage, 15, 100);
      report.storage.sessionStorage = trimStorageObject(report.storage.sessionStorage, 15, 100);
    }
    if (Array.isArray(report.network?.interceptedRequests)) {
      report.network.interceptedRequests = report.network.interceptedRequests.slice(-15).map((req) => ({
        ...req,
        requestHeaders: {},
      }));
    }
    if (report.sessionFlow) {
      if (Array.isArray(report.sessionFlow.uniqueEndpoints)) {
        report.sessionFlow.uniqueEndpoints = report.sessionFlow.uniqueEndpoints.slice(0, 25).map((ep) => ({
          ...ep,
          requestHeaders: {},
        }));
      }
      if (Array.isArray(report.sessionFlow.userActions)) {
        report.sessionFlow.userActions = report.sessionFlow.userActions.slice(0, 30);
      }
      if (Array.isArray(report.sessionFlow.pagesVisited)) {
        report.sessionFlow.pagesVisited = report.sessionFlow.pagesVisited.slice(0, 15);
      }
    }
    appliedStages.push("hard_budget_cap");
  }

  // Аварийное пошаговое сжатие для экстремально больших записей
  const shrinkableArrays = [
    () => report.network?.interceptedRequests,
    () => report.network?.performanceResourceEntries,
    () => report.sessionFlow?.uniqueEndpoints,
    () => report.sessionFlow?.userActions,
    () => report.domStructure?.interactiveElements,
    () => report.domStructure?.widgetContainers,
    () => report.mediaAndAssets?.contentImages,
    () => report.techStack?.inlineJsonScripts,
  ];
  let guard = 0;
  while (measure(report) > targetBytes && guard < 12) {
    guard++;
    let changed = false;
    for (const getter of shrinkableArrays) {
      const arr = getter();
      if (Array.isArray(arr) && arr.length > 5) {
        arr.length = Math.max(5, Math.floor(arr.length / 2));
        changed = true;
      }
    }
    if (!changed) break;
    if (!appliedStages.includes("emergency_array_shrink")) {
      appliedStages.push("emergency_array_shrink");
    }
  }

  report.meta = report.meta || {};
  report.meta.sizeBudget = {
    maxBytes,
    originalBytes,
    trimmed: true,
    appliedStages,
  };
  report.meta.sizeBudget.finalBytes = measure(report);

  return report;
}

function buildSessionOnlyReport(sessionFlow, activeTabUrl = "") {
  const fallbackUrl = sessionFlow?.startUrl || sessionFlow?.origin || activeTabUrl || "";
  let origin = sessionFlow?.origin || "";
  let pathname = "";
  try {
    if (fallbackUrl) {
      const u = new URL(fallbackUrl);
      origin = origin || u.origin;
      pathname = u.pathname;
    }
  } catch (_) {}

  const lastPage = sessionFlow?.pagesVisited?.[sessionFlow.pagesVisited.length - 1];
  return {
    meta: {
      extensionVersion: EXTENSION_VERSION,
      url: fallbackUrl,
      origin,
      pathname,
      title: lastPage?.title || sessionFlow?.origin || "Recorded Session Flow",
      timestamp: new Date().toISOString(),
      note: "Запись остановлена на системной вкладке браузера — отчет сформирован на основе записанного sessionFlow без DOM-слепка текущей вкладки.",
    },
    techStack: {
      detectedFrameworks: [],
      customWindowGlobals: [],
      inlineJsonScripts: [],
    },
    domStructure: {
      shadowRootsFound: 0,
      semanticLandmarks: [],
      widgetContainers: [],
      interactiveElements: [],
      skeleton: null,
    },
    mediaAndAssets: {
      contentImages: [],
      smallIconsOrAvatars: [],
      videosAndStreams: [],
    },
    network: {
      filteredNoiseCount: 0,
      interceptedRequests: [],
      webSockets: sessionFlow?.webSockets || [],
      performanceResourceEntries: [],
    },
    storage: {
      localStorage: {},
      sessionStorage: {},
      cookieNames: [],
    },
    sessionFlow: sessionFlow || null,
  };
}

function formatAsAiMarkdown(report) {
  const modeNote = report.sessionFlow
    ? " В отчет также включена запись пользовательского флоу (`sessionFlow`: посещенные страницы, клики/сабмиты, уникальные дедуплицированные API-эндпоинты и все встреченные виджеты)."
    : "";

  return [
    `# AI Site Recon Report: ${report.meta.title || report.meta.url}`,
    `- **URL**: ${report.meta.url}`,
    `- **Timestamp**: ${report.meta.timestamp}`,
    `- **Detected Stack**: ${report.techStack.detectedFrameworks.join(", ") || "Vanilla / Unknown"}`,
    `- **Custom Window Globals**: \`${report.techStack.customWindowGlobals.slice(0, 30).join("`, `")}\``,
    "",
    "## Контекст для ИИ",
    `Ниже находится полный технический слепок веб-страницы (семантические узлы с \`data-testid\`/\`data-widget\` и \`aria-label\`, дерево виджетов и открытого Shadow DOM, крупные медиа-контейнеры, очищенные от трекеров перехваченные запросы Fetch/XHR/GraphQL, соединения WebSocket с примерами фреймов, а также ключи localStorage/cookies с замаскированными секретами).${modeNote} Используй эти реальные селекторы и эндпоинты для написания расширения, парсера или пользовательского скрипта без выдумывания несуществующих классов.`,
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
  ].join("\n");
}

async function copyTextSafely(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    return false;
  }
}

async function runFullPageScan(sessionFlow = null) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    throw new Error("Не удалось получить активную вкладку.");
  }
  if (isSystemTabUrl(tab.url)) {
    throw new Error("Системные страницы браузера недоступны для сканирования.");
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: collectPageReconInMainWorld,
  });

  const report = results?.[0]?.result;
  if (!report) {
    throw new Error("Не удалось собрать данные со страницы.");
  }

  report.meta = report.meta || {};
  report.meta.extensionVersion = EXTENSION_VERSION;

  try {
    const allCookies = await chrome.cookies.getAll({ url: tab.url });
    report.storage.allCookieMeta = allCookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      httpOnly: c.httpOnly,
      secure: c.secure,
    }));
  } catch (_) {}

  if (sessionFlow) {
    report.sessionFlow = sessionFlow;
  }

  enforceReportSizeBudget(report);
  latestReport = report;
  latestMarkdown = formatAsAiMarkdown(report);
  const copied = await copyTextSafely(latestMarkdown);

  copyAiBtn.disabled = false;
  copyJsonBtn.disabled = false;
  downloadBtn.disabled = false;

  return { report, copied };
}

function updateRecordButtonUI(status) {
  isRecordingActive = Boolean(status?.active);
  if (isRecordingActive) {
    recordBtn.classList.add("recording");
    recordBtn.innerHTML = `<span>⏹ Стоп и собрать отчет (стр: ${status.pagesCount || 0}, API: ${status.endpointsCount || 0}, клики: ${status.actionsCount || 0})</span>`;
    statusEl.textContent = "🔴 Идет запись флоу — переходи по страницам и кликай по элементам";
  } else {
    recordBtn.classList.remove("recording");
    recordBtn.innerHTML = "<span>🔴 Записать флоу (переходы, клики, API)</span>";
  }
}

chrome.runtime.sendMessage({ type: "RECON_GET_STATUS" }, (res) => {
  if (chrome.runtime.lastError) return;
  if (res && res.active) {
    updateRecordButtonUI(res);
  }
});

scanBtn.addEventListener("click", async () => {
  statusEl.textContent = "⏳ Сканирую DOM, виджеты, сеть и WebSocket...";
  scanBtn.disabled = true;

  try {
    const { report, copied } = await runFullPageScan(null);

    const netCount =
      (report.network.interceptedRequests?.length || 0) +
      (report.network.performanceResourceEntries?.length || 0);
    const wsCount = report.network.webSockets?.length || 0;
    const imgCount = report.mediaAndAssets.contentImages?.length || 0;
    const widgetCount = report.domStructure.widgetContainers?.length || 0;

    statusEl.textContent = copied
      ? `✅ Скопировано! (API: ${netCount}, Виджеты: ${widgetCount}, WS: ${wsCount}, Медиа: ${imgCount})`
      : `✅ Готово! Нажми «Промпт ИИ» или «Скачать» (API: ${netCount}, Виджеты: ${widgetCount})`;

    previewEl.style.display = "block";
    previewEl.textContent = JSON.stringify(
      {
        url: report.meta.url,
        frameworks: report.techStack.detectedFrameworks,
        landmarksFound: report.domStructure.semanticLandmarks.length,
        widgetsFound: widgetCount,
        shadowRootsFound: report.domStructure.shadowRootsFound || 0,
        interceptedHttp: report.network.interceptedRequests.length,
        filteredNoise: report.network.filteredNoiseCount,
        webSockets: wsCount,
        perfEntries: report.network.performanceResourceEntries.length,
        contentImages: imgCount,
        ...(report.meta.sizeBudget?.trimmed ? { sizeBudgetTrimmedKB: Math.round(report.meta.sizeBudget.finalBytes / 1024) } : {}),
      },
      null,
      2
    );
  } catch (err) {
    statusEl.textContent = `❌ Ошибка: ${err.message}`;
  } finally {
    scanBtn.disabled = false;
  }
});

recordBtn.addEventListener("click", async () => {
  recordBtn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!isRecordingActive) {
      if (!tab || !tab.id || isSystemTabUrl(tab.url)) {
        throw new Error("Открой обычный сайт перед началом записи.");
      }

      const status = await chrome.runtime.sendMessage({
        type: "RECON_START_RECORDING",
        tabId: tab.id,
        url: tab.url,
      });
      updateRecordButtonUI(status);
    } else {
      statusEl.textContent = "⏳ Останавливаю запись и собираю итоговый отчет...";
      const stopRes = await chrome.runtime.sendMessage({ type: "RECON_STOP_RECORDING" });
      updateRecordButtonUI({ active: false });

      const sessionFlow = stopRes?.session || null;
      let report;
      let copied;

      if (!tab || !tab.id || isSystemTabUrl(tab.url)) {
        if (!sessionFlow) {
          throw new Error("Запись остановлена, но данных сессии не найдено.");
        }
        report = buildSessionOnlyReport(sessionFlow, tab?.url || "");
        enforceReportSizeBudget(report);
        latestReport = report;
        latestMarkdown = formatAsAiMarkdown(report);
        copied = await copyTextSafely(latestMarkdown);
        copyAiBtn.disabled = false;
        copyJsonBtn.disabled = false;
        downloadBtn.disabled = false;
      } else {
        ({ report, copied } = await runFullPageScan(sessionFlow));
      }

      const pages = report.sessionFlow?.pagesVisited?.length || 0;
      const eps = report.sessionFlow?.uniqueEndpoints?.length || 0;
      const acts = report.sessionFlow?.userActions?.length || 0;

      statusEl.textContent = copied
        ? `✅ Флоу скопирован! (Страниц: ${pages}, API: ${eps}, Кликов: ${acts})`
        : `✅ Флоу готов! Нажми «Промпт ИИ» или «Скачать»`;

      previewEl.style.display = "block";
      previewEl.textContent = JSON.stringify(
        {
          mode: "sessionFlow",
          url: report.meta.url,
          pagesVisited: pages,
          uniqueEndpoints: eps,
          userActions: acts,
          allWidgetsSeen: report.sessionFlow?.allWidgetsSeen?.length || 0,
          ...(report.meta.sizeBudget?.trimmed ? { sizeBudgetTrimmedKB: Math.round(report.meta.sizeBudget.finalBytes / 1024) } : {}),
        },
        null,
        2
      );
    }
  } catch (err) {
    statusEl.textContent = `❌ Ошибка: ${err.message}`;
  } finally {
    recordBtn.disabled = false;
  }
});

copyAiBtn.addEventListener("click", async () => {
  if (!latestMarkdown) return;
  const ok = await copyTextSafely(latestMarkdown);
  statusEl.textContent = ok
    ? "📋 Промпт для ИИ (Markdown + JSON) скопирован!"
    : "⚠️ Не удалось скопировать в буфер — используй «Скачать».";
});

copyJsonBtn.addEventListener("click", async () => {
  if (!latestReport) return;
  const ok = await copyTextSafely(JSON.stringify(latestReport, null, 2));
  statusEl.textContent = ok
    ? "{ } Чистый JSON скопирован в буфер обмена!"
    : "⚠️ Не удалось скопировать JSON — нет фокуса.";
});

downloadBtn.addEventListener("click", () => {
  if (!latestMarkdown) return;
  const blob = new Blob([latestMarkdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  let host = "site";
  try {
    const parsedHost = new URL(latestReport?.meta?.url || "").hostname;
    if (parsedHost) {
      host = parsedHost.replace(/[^a-z0-9.-]/gi, "_");
    }
  } catch (_) {}
  const a = document.createElement("a");
  a.href = url;
  a.download = `site-recon-${host}-${Date.now()}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  statusEl.textContent = "💾 Файл отчета сохранен!";
});