// interceptor.js — внедряется в MAIN world на этапе document_start
// Перехватывает все вызовы fetch() и XMLHttpRequest на странице и складывает их в window.__AI_RECON_NET_LOG__

(function () {
  if (window.__AI_RECON_HOOKED__) return;
  window.__AI_RECON_HOOKED__ = true;
  window.__AI_RECON_NET_LOG__ = [];

  const MAX_LOG_ENTRIES = 120;
  const MAX_BODY_PREVIEW = 1500;

  function safePreview(text) {
    if (typeof text !== "string") return null;
    return text.length > MAX_BODY_PREVIEW
      ? text.slice(0, MAX_BODY_PREVIEW) + "... [обрезано]"
      : text;
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

      try {
        const response = await origFetch.apply(this, args);
        const clone = response.clone();
        const contentType = clone.headers.get("content-type") || "";
        let respPreview = null;

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
                requestHeaders: reqHeaders,
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
            requestHeaders: reqHeaders,
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
          if (
            this.responseType === "" ||
            this.responseType === "text"
          ) {
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
            requestHeaders: this.__reconMeta.headers,
            requestBody: this.__reconMeta.requestBody || null,
            responsePreview: respPreview,
          });
        } catch (_) {}
      });
    }
    return origSend.call(this, body);
  };
})();
