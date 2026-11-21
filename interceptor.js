// interceptor.js — внедряется в MAIN world на этапе document_start
// Перехватывает вызовы fetch(), XMLHttpRequest и WebSocket на странице и складывает их в window.__AI_RECON_NET_LOG__ и window.__AI_RECON_WS_LOG__

(function () {
  if (window.__AI_RECON_HOOKED__) return;
  window.__AI_RECON_HOOKED__ = true;
  window.__AI_RECON_NET_LOG__ = [];
  window.__AI_RECON_WS_LOG__ = [];
  window.__AI_RECON_FILTERED_COUNT__ = 0;

  const MAX_LOG_ENTRIES = 120;
  const MAX_BODY_PREVIEW = 2500;
  const MAX_WS_SOCKETS = 20;
  const MAX_WS_MESSAGES_PER_SOCKET = 10;

  const SENSITIVE_HEADER_RE =
    /^(authorization|proxy-authorization|cookie|set-cookie|x-csrf|x-csrf-token|x-xsrf-token|x-auth-token|x-access-token|x-session-token|x-token|x-secret|x-user-token|api-key|x-api-key|x-api-token)$/i;
  const SENSITIVE_TOKEN_RE =
    /(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|"(?:token|access_token|refresh_token|auth|password|api_key|apiKey|secret)"\s*:\s*"[^"]*")/gi;
  const SENSITIVE_QUERY_PARAM_RE =
    /^(token|access_token|refresh_token|api_key|apikey|key|auth|secret|sig|signature|session|password)$/i;
  const SENSITIVE_FORM_PAIR_RE =
    /(^|[&?])(password|passwd|token|access_token|refresh_token|api_key|apikey|auth|secret|session)=([^&#\s"']*)/gi;

  function sanitizeUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) return rawUrl;
    if (!rawUrl.includes("?") && !rawUrl.includes("#")) return rawUrl;
    try {
      const baseHref = typeof location !== "undefined" && location.href ? location.href : "https://placeholder.local";
      const isRelative = !/^[a-z][a-z0-9+.-]*:/i.test(rawUrl);
      const u = new URL(rawUrl, baseHref);
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
  }

  // Фильтр телеметрии, трекинг-пикселей и статики, чтобы не забивать буфер API-запросов
  const NOISE_URL_RE =
    /(empty\.gif|pixel\.(gif|png)|pop-stats-collector|perf-metrics-collector|\/rum\/|yandex\.ru\/clck\/|media-adv\.market\.yandex\.ru\/events|em\.market\.yandex\.ru\/|safeclick|static-mon\.yandex\.net|\/ping(\?|$)|google-analytics\.com|googletagmanager\.com|mc\.yandex\.ru|doubleclick\.net|sentry\.io|adriver\.ru|weborama|targetads\.io|\.(png|jpe?g|webp|gif|svg|woff2?|ttf|css)(\?|$))/i;

  function isNoiseRequest(url, contentType = "") {
    if (NOISE_URL_RE.test(String(url || ""))) return true;
    const ct = String(contentType || "").toLowerCase();
    if (
      ct.startsWith("image/") ||
      ct.startsWith("font/") ||
      ct.includes("text/css")
    ) {
      return true;
    }
    return false;
  }

  function safePreview(text) {
    if (typeof text !== "string") return null;
    const masked = text
      .replace(SENSITIVE_TOKEN_RE, "[REDACTED_TOKEN]")
      .replace(SENSITIVE_FORM_PAIR_RE, "$1$2=[REDACTED_TOKEN]");
    return masked.length > MAX_BODY_PREVIEW
      ? masked.slice(0, MAX_BODY_PREVIEW) + "... [обрезано]"
      : masked;
  }

  function formatRequestBody(body) {
    if (body == null) return null;
    if (typeof body === "string") return safePreview(body);
    if (body instanceof URLSearchParams) {
      const sanitized = new URLSearchParams();
      body.forEach((v, k) => {
        sanitized.append(k, SENSITIVE_QUERY_PARAM_RE.test(k) ? "[REDACTED_TOKEN]" : v);
      });
      return safePreview(sanitized.toString());
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const keys = [];
      body.forEach((_, k) => keys.push(k));
      return `[FormData keys: ${keys.slice(0, 20).join(", ")}]`;
    }
    if (body instanceof Blob) {
      return `[Blob (${body.size} bytes, type: ${body.type || "unknown"})]`;
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return `[Binary (${body.byteLength} bytes)]`;
    }
    return null;
  }

  function formatWsPayload(data) {
    try {
      if (typeof data === "string") {
        return safePreview(data);
      }
      if (data instanceof ArrayBuffer) {
        return `[Binary ArrayBuffer (${data.byteLength} bytes)]`;
      }
      if (ArrayBuffer.isView(data)) {
        return `[Binary View ${data.constructor.name} (${data.byteLength} bytes)]`;
      }
      if (data instanceof Blob) {
        return `[Binary Blob (${data.size} bytes, type: ${data.type || "unknown"})]`;
      }
      return safePreview(JSON.stringify(data));
    } catch (_) {
      return "[Unserializable WS Payload]";
    }
  }

  function sanitizeHeaders(headersObj) {
    const clean = {};
    if (!headersObj || typeof headersObj !== "object") return clean;
    for (const [k, v] of Object.entries(headersObj)) {
      if (SENSITIVE_HEADER_RE.test(k)) {
        clean[k] = "[REDACTED_TOKEN_OR_SECRET]";
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }

  let isRecordingBridgeActive = false;

  function getTargetOrigin() {
    try {
      return location.origin && location.origin !== "null" ? location.origin : null;
    } catch (_) {
      return null;
    }
  }

  window.addEventListener("message", (event) => {
    const targetOrigin = getTargetOrigin();
    if (event.source !== window || (targetOrigin && event.origin !== targetOrigin)) return;
    if (event.data && event.data.__aiReconControl === true && event.data.type === "SET_RECORDING") {
      isRecordingBridgeActive = Boolean(event.data.active);
    }
  });

  function emitToBridge(kind, payload) {
    if (!isRecordingBridgeActive) return;
    const targetOrigin = getTargetOrigin();
    if (!targetOrigin) return;
    try {
      window.postMessage(
        {
          __aiReconEvent: true,
          kind,
          ...(kind === "net" ? { entry: payload } : { ws: payload }),
        },
        targetOrigin
      );
    } catch (_) {}
  }

  function pushLog(entry) {
    if (entry && typeof entry.url === "string") {
      entry.url = sanitizeUrl(entry.url);
    }
    if (isNoiseRequest(entry.url, entry.contentType)) {
      window.__AI_RECON_FILTERED_COUNT__++;
      return;
    }
    if (window.__AI_RECON_NET_LOG__.length >= MAX_LOG_ENTRIES) {
      window.__AI_RECON_NET_LOG__.shift();
    }
    window.__AI_RECON_NET_LOG__.push(entry);
    emitToBridge("net", entry);
  }

  // 1. Перехват window.fetch
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...args) {
      const startTime = Date.now();
      let url = "";
      let method = "GET";
      let reqHeaders = {};
      let reqBody = null;

      try {
        const resource = args[0];
        const init = args[1] || {};
        if (typeof resource === "string") {
          url = resource;
        } else if (resource instanceof URL) {
          url = resource.href;
        } else if (resource && typeof resource.url === "string") {
          url = resource.url;
          method = resource.method || method;
          if (
            (typeof Request !== "undefined" && resource instanceof Request) ||
            (resource.headers && typeof resource.headers.forEach === "function")
          ) {
            resource.headers.forEach((v, k) => (reqHeaders[k] = v));
          }
        }
        if (init.method) method = init.method;
        if (init.headers) {
          if (init.headers instanceof Headers) {
            init.headers.forEach((v, k) => (reqHeaders[k] = v));
          } else if (Array.isArray(init.headers)) {
            for (const pair of init.headers) {
              if (Array.isArray(pair) && pair.length >= 2) reqHeaders[pair[0]] = pair[1];
            }
          } else if (typeof init.headers === "object") {
            reqHeaders = { ...reqHeaders, ...init.headers };
          }
        }
        if (init.body !== undefined) {
          reqBody = formatRequestBody(init.body);
        }
      } catch (_) {}

      const cleanHeaders = sanitizeHeaders(reqHeaders);

      try {
        const response = await origFetch.apply(this, args);
        const contentType = response.headers ? response.headers.get("content-type") || "" : "";
        const contentTypeLower = contentType.toLowerCase();
        const contentLength = Number(response.headers ? response.headers.get("content-length") || 0 : 0);

        if (isNoiseRequest(url, contentType)) {
          window.__AI_RECON_FILTERED_COUNT__++;
          return response;
        }

        const baseLog = {
          type: "fetch",
          method: method.toUpperCase(),
          url,
          status: response.status,
          contentType,
          durationMs: Date.now() - startTime,
          requestHeaders: cleanHeaders,
          requestBody: reqBody,
        };

        if (response.type === "opaque" || response.bodyUsed) {
          pushLog(baseLog);
        } else if (contentTypeLower.includes("text/event-stream")) {
          pushLog({ ...baseLog, responsePreview: "[SSE stream skipped]" });
        } else if (Number.isFinite(contentLength) && contentLength > 2000000) {
          pushLog({ ...baseLog, responsePreview: "[Skipped large response]" });
        } else if (
          contentTypeLower.includes("json") ||
          contentTypeLower.includes("text") ||
          contentTypeLower.includes("xml") ||
          contentTypeLower.includes("mpegurl")
        ) {
          const clone = response.clone();
          clone
            .text()
            .then((txt) => {
              pushLog({
                ...baseLog,
                responsePreview: safePreview(txt),
              });
            })
            .catch(() => {});
        } else {
          pushLog(baseLog);
        }
        return response;
      } catch (err) {
        pushLog({
          type: "fetch_error",
          method: method.toUpperCase(),
          url,
          error: String(err),
        });
        throw err;
      }
    };
  }

  // 2. Перехват XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__reconMeta = {
      method: (method || "GET").toUpperCase(),
      url: String(url || ""),
      headers: {},
      startTime: Date.now(),
    };
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    if (this.__reconMeta) {
      this.__reconMeta.headers[header] = value;
    }
    return origSetHeader.call(this, header, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__reconMeta) {
      if (body !== undefined) {
        this.__reconMeta.requestBody = formatRequestBody(body);
      }
      this.addEventListener("loadend", () => {
        try {
          const contentType = this.getResponseHeader("content-type") || "";
          if (isNoiseRequest(this.__reconMeta.url, contentType)) {
            window.__AI_RECON_FILTERED_COUNT__++;
            return;
          }
          let respPreview = null;
          if (this.responseType === "" || this.responseType === "text") {
            respPreview = safePreview(this.responseText || "");
          } else if (this.responseType === "json" && this.response) {
            respPreview = safePreview(JSON.stringify(this.response));
          }
          pushLog({
            type: "xhr",
            method: this.__reconMeta.method,
            url: this.__reconMeta.url,
            status: this.status,
            contentType,
            durationMs: Date.now() - this.__reconMeta.startTime,
            requestHeaders: sanitizeHeaders(this.__reconMeta.headers),
            requestBody: this.__reconMeta.requestBody || null,
            responsePreview: respPreview,
          });
        } catch (_) {}
      });
    }
    return origSend.call(this, body);
  };

  // 3. Легкий перехват WebSocket (URL, протоколы и первые N входящих/исходящих фреймов)
  const OrigWebSocket = window.WebSocket;
  if (OrigWebSocket) {
    const WrappedWebSocket = function (url, protocols) {
      const wsInstance =
        protocols !== undefined
          ? new OrigWebSocket(url, protocols)
          : new OrigWebSocket(url);

      try {
        const wsRecord = {
          url: sanitizeUrl(String(url || "")),
          protocols: protocols || null,
          createdAt: new Date().toISOString(),
          readyState: wsInstance.readyState,
          sentCount: 0,
          receivedCount: 0,
          sampleMessages: [],
        };

        if (window.__AI_RECON_WS_LOG__.length >= MAX_WS_SOCKETS) {
          window.__AI_RECON_WS_LOG__.shift();
        }
        window.__AI_RECON_WS_LOG__.push(wsRecord);
        emitToBridge("ws", { url: wsRecord.url, protocols: wsRecord.protocols, createdAt: wsRecord.createdAt });

        // Перехват исходящих сообщений ws.send()
        const origWsSend = wsInstance.send;
        wsInstance.send = function (data) {
          try {
            wsRecord.sentCount++;
            wsRecord.readyState = wsInstance.readyState;
            if (wsRecord.sampleMessages.length < MAX_WS_MESSAGES_PER_SOCKET) {
              wsRecord.sampleMessages.push({
                direction: "outgoing",
                timestamp: new Date().toISOString(),
                payloadPreview: formatWsPayload(data),
              });
            }
          } catch (_) {}
          return origWsSend.apply(this, arguments);
        };

        // Перехват входящих сообщений
        wsInstance.addEventListener("message", (event) => {
          try {
            wsRecord.receivedCount++;
            wsRecord.readyState = wsInstance.readyState;
            if (wsRecord.sampleMessages.length < MAX_WS_MESSAGES_PER_SOCKET) {
              wsRecord.sampleMessages.push({
                direction: "incoming",
                timestamp: new Date().toISOString(),
                payloadPreview: formatWsPayload(event.data),
              });
            }
          } catch (_) {}
        });

        wsInstance.addEventListener("open", () => {
          wsRecord.readyState = wsInstance.readyState;
        });

        wsInstance.addEventListener("close", (e) => {
          wsRecord.readyState = wsInstance.readyState;
          wsRecord.closeCode = e.code;
        });
      } catch (_) {}

      return wsInstance;
    };

    WrappedWebSocket.prototype = OrigWebSocket.prototype;
    Object.assign(WrappedWebSocket, OrigWebSocket);
    window.WebSocket = WrappedWebSocket;
  }
})();
