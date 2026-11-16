// interceptor.js — внедряется в MAIN world на этапе document_start
// Перехватывает вызовы fetch(), XMLHttpRequest и WebSocket на странице и складывает их в window.__AI_RECON_NET_LOG__ и window.__AI_RECON_WS_LOG__

(function () {
  if (window.__AI_RECON_HOOKED__) return;
  window.__AI_RECON_HOOKED__ = true;
  window.__AI_RECON_NET_LOG__ = [];
  window.__AI_RECON_WS_LOG__ = [];

  const MAX_LOG_ENTRIES = 120;
  const MAX_BODY_PREVIEW = 1500;
  const MAX_WS_SOCKETS = 20;
  const MAX_WS_MESSAGES_PER_SOCKET = 10;
  const SENSITIVE_HEADER_RE = /^(authorization|cookie|set-cookie|x-csrf-token|x-auth-token|api-key|x-api-key)$/i;
  const SENSITIVE_TOKEN_RE = /(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|"token"\s*:\s*"[^"]+"|"auth"\s*:\s*"[^"]+"|"password"\s*:\s*"[^"]+")/gi;

  function safePreview(text) {
    if (typeof text !== "string") return null;
    const masked = text.replace(SENSITIVE_TOKEN_RE, "[REDACTED_TOKEN]");
    return masked.length > MAX_BODY_PREVIEW
      ? masked.slice(0, MAX_BODY_PREVIEW) + "... [обрезано]"
      : masked;
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
      return safePreview( JSON.stringify(data) );
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

  function pushLog(entry) {
    if (window.__AI_RECON_NET_LOG__.length >= MAX_LOG_ENTRIES) {
      window.__AI_RECON_NET_LOG__.shift();
    }
    window.__AI_RECON_NET_LOG__.push(entry);
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
        } else if (resource && typeof resource.url === "string") {
          url = resource.url;
          method = resource.method || method;
        }
        if (init.method) method = init.method;
        if (init.headers) {
          if (init.headers instanceof Headers) {
            init.headers.forEach((v, k) => (reqHeaders[k] = v));
          } else if (typeof init.headers === "object") {
            reqHeaders = { ...init.headers };
          }
        }
        if (typeof init.body === "string") {
          reqBody = safePreview(init.body);
        }
      } catch (_) {}

      const cleanHeaders = sanitizeHeaders(reqHeaders);

      try {
        const response = await origFetch.apply(this, args);
        const clone = response.clone();
        const contentType = clone.headers.get("content-type") || "";

        if (
          contentType.includes("json") ||
          contentType.includes("text") ||
          contentType.includes("xml") ||
          contentType.includes("mpegurl")
        ) {
          clone
            .text()
            .then((txt) => {
              pushLog({
                type: "fetch",
                method: method.toUpperCase(),
                url,
                status: response.status,
                contentType,
                durationMs: Date.now() - startTime,
                requestHeaders: cleanHeaders,
                requestBody: reqBody,
                responsePreview: safePreview(txt),
              });
            })
            .catch(() => {});
        } else {
          pushLog({
            type: "fetch",
            method: method.toUpperCase(),
            url,
            status: response.status,
            contentType,
            durationMs: Date.now() - startTime,
            requestHeaders: cleanHeaders,
          });
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
      if (typeof body === "string") {
        this.__reconMeta.requestBody = safePreview(body);
      }
      this.addEventListener("loadend", () => {
        try {
          const contentType = this.getResponseHeader("content-type") || "";
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
          url: String(url || ""),
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
