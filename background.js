// background.js — Service Worker для хранения записанной сессии (переживает переходы и перезагрузки)

const SESSION_KEY = "reconSessionState";
const MAX_PAGES = 30;
const MAX_ACTIONS = 60;
const MAX_ENDPOINTS = 80;
const MAX_WS = 20;
const MAX_WIDGETS = 100;

function createEmptySession(tabId, origin, url) {
  return {
    active: true,
    tabId,
    origin,
    startUrl: url,
    startedAt: new Date().toISOString(),
    pages: [],
    actions: [],
    endpoints: {},
    webSockets: [],
    seenWidgets: [],
  };
}

async function getSession() {
  const data = await chrome.storage.session.get(SESSION_KEY);
  return data[SESSION_KEY] || null;
}

async function saveSession(session) {
  await chrome.storage.session.set({ [SESSION_KEY]: session });
}

async function updateBadge(active) {
  try {
    if (active) {
      await chrome.action.setBadgeText({ text: "REC" });
      await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (_) {}
}

function getEndpointKey(method, rawUrl) {
  try {
    const u = new URL(rawUrl, "https://placeholder.local");
    return `${(method || "GET").toUpperCase()} ${u.pathname}`;
  } catch (_) {
    return `${(method || "GET").toUpperCase()} ${String(rawUrl || "").split("?")[0]}`;
  }
}

function summarizeSession(session) {
  if (!session) return { active: false };
  return {
    active: Boolean(session.active),
    tabId: session.tabId,
    origin: session.origin,
    startedAt: session.startedAt,
    pagesCount: session.pages.length,
    actionsCount: session.actions.length,
    endpointsCount: Object.keys(session.endpoints).length,
    widgetsCount: session.seenWidgets.length,
    wsCount: session.webSockets.length,
  };
}

chrome.runtime.onInstalled.addListener(() => {
  updateBadge(false);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;

    if (msg.type === "RECON_GET_STATUS") {
      const session = await getSession();
      const isTargetTab =
        !sender.tab || !session || sender.tab.id === session.tabId;
      sendResponse(
        session && session.active && isTargetTab
          ? summarizeSession(session)
          : { active: false }
      );
      return;
    }

    if (msg.type === "RECON_START_RECORDING") {
      const { tabId, url } = msg;
      let origin = "";
      try {
        origin = new URL(url).origin;
      } catch (_) {}

      const session = createEmptySession(tabId, origin, url);
      await saveSession(session);
      await updateBadge(true);

      // Уведомляем активную вкладку о старте записи
      try {
        await chrome.tabs.sendMessage(tabId, { type: "RECON_RECORDING_STATE", active: true });
      } catch (_) {}

      sendResponse(summarizeSession(session));
      return;
    }

    if (msg.type === "RECON_STOP_RECORDING") {
      const session = await getSession();
      if (!session) {
        await updateBadge(false);
        sendResponse({ session: null });
        return;
      }
      session.active = false;
      session.stoppedAt = new Date().toISOString();
      await saveSession(session);
      await updateBadge(false);

      if (session.tabId) {
        try {
          await chrome.tabs.sendMessage(session.tabId, {
            type: "RECON_RECORDING_STATE",
            active: false,
          });
        } catch (_) {}
      }

      sendResponse({
        session: {
          origin: session.origin,
          startUrl: session.startUrl,
          startedAt: session.startedAt,
          stoppedAt: session.stoppedAt,
          pagesVisited: session.pages,
          userActions: session.actions,
          uniqueEndpoints: Object.values(session.endpoints),
          allWidgetsSeen: session.seenWidgets,
          webSockets: session.webSockets,
        },
      });
      return;
    }

    if (msg.type === "RECON_EVENT" && sender.tab) {
      const session = await getSession();
      if (!session || !session.active || sender.tab.id !== session.tabId) {
        sendResponse({ ok: false });
        return;
      }

      const { kind, payload } = msg;

      if (kind === "page_visit" && payload) {
        const existingSet = new Set(session.seenWidgets);
        const newWidgets = [];
        for (const w of payload.widgets || []) {
          if (!existingSet.has(w) && session.seenWidgets.length < MAX_WIDGETS) {
            existingSet.add(w);
            session.seenWidgets.push(w);
            newWidgets.push(w);
          }
        }

        const lastPage = session.pages[session.pages.length - 1];
        if (!lastPage || lastPage.url !== payload.url) {
          if (session.pages.length < MAX_PAGES) {
            session.pages.push({
              url: payload.url,
              pathname: payload.pathname,
              title: payload.title,
              timestamp: payload.timestamp,
              newWidgets,
            });
          }
        } else if (newWidgets.length > 0) {
          lastPage.newWidgets = Array.from(new Set([...lastPage.newWidgets, ...newWidgets]));
        }
      } else if (kind === "action" && payload) {
        if (session.actions.length < MAX_ACTIONS) {
          session.actions.push(payload);
        }
      } else if (kind === "net" && payload) {
        const key = getEndpointKey(payload.method, payload.url);
        const existing = session.endpoints[key];
        if (existing) {
          existing.count += 1;
          existing.lastStatus = payload.status;
        } else if (Object.keys(session.endpoints).length < MAX_ENDPOINTS) {
          let pathname = payload.url;
          try {
            pathname = new URL(payload.url, session.origin || "https://placeholder.local").pathname;
          } catch (_) {}
          session.endpoints[key] = {
            method: payload.method,
            pathname,
            sampleUrl: payload.url,
            status: payload.status,
            contentType: payload.contentType || "",
            count: 1,
            firstSeenAt: new Date().toISOString(),
            requestHeaders: payload.requestHeaders || {},
            requestBodyPreview: payload.requestBody || null,
            responsePreview: payload.responsePreview || null,
          };
        }
      } else if (kind === "ws" && payload) {
        if (
          session.webSockets.length < MAX_WS &&
          !session.webSockets.some((w) => w.url === payload.url)
        ) {
          session.webSockets.push(payload);
        }
      }

      await saveSession(session);
      sendResponse({ ok: true });
    }
  })();

  return true;
});
