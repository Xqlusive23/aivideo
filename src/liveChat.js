import { TAWK_PROPERTY_ID, TAWK_WIDGET_ID } from "./siteConfig.js";

const pendingActions = [];

export function isLiveChatEnabled() {
  return Boolean(TAWK_PROPERTY_ID && TAWK_WIDGET_ID);
}

function runWhenTawkReady(action) {
  if (typeof window === "undefined") return;
  if (window.Tawk_API?.maximize) {
    action();
    return;
  }
  pendingActions.push(action);
}

export function initLiveChat() {
  if (!isLiveChatEnabled() || typeof document === "undefined" || window.__tawkInit) return;
  window.__tawkInit = true;

  window.Tawk_API = window.Tawk_API || {};
  const priorOnLoad = window.Tawk_API.onLoad;
  window.Tawk_API.onLoad = function onTawkLoad() {
    if (typeof priorOnLoad === "function") priorOnLoad();
    while (pendingActions.length) {
      const action = pendingActions.shift();
      try {
        action();
      } catch {
        // ignore widget action failures
      }
    }
  };
  window.Tawk_LoadStart = new Date();

  const loader = document.createElement("script");
  const firstScript = document.getElementsByTagName("script")[0];
  loader.async = true;
  loader.src = `https://embed.tawk.to/${TAWK_PROPERTY_ID}/${TAWK_WIDGET_ID}`;
  loader.charset = "UTF-8";
  loader.setAttribute("crossorigin", "*");
  firstScript.parentNode.insertBefore(loader, firstScript);
}

/** Hide the floating bubble (studio) — text buttons can still openLiveChat(). */
export function hideLiveChatWidget() {
  if (!isLiveChatEnabled() || typeof document === "undefined") return;
  document.documentElement.classList.add("itc-livechat-hidden");
  initLiveChat();
  runWhenTawkReady(() => {
    try {
      window.Tawk_API?.hideWidget?.();
      window.Tawk_API?.minimize?.();
    } catch {
      // ignore
    }
  });
}

/** Show the floating bubble again (landing / marketing pages). */
export function showLiveChatWidget() {
  if (!isLiveChatEnabled() || typeof document === "undefined") return;
  document.documentElement.classList.remove("itc-livechat-hidden");
  initLiveChat();
  runWhenTawkReady(() => {
    try {
      window.Tawk_API?.showWidget?.();
    } catch {
      // ignore
    }
  });
}

/** Opens the Tawk.to widget. Message is stored as visitor metadata for agents (Tawk cannot prefill the input). */
export function openLiveChat(message) {
  if (!isLiveChatEnabled()) return false;
  initLiveChat();

  const text = String(message || "").trim();
  runWhenTawkReady(() => {
    if (text && window.Tawk_API?.setAttributes) {
      window.Tawk_API.setAttributes({ accessRequest: text }, () => {});
    }
    // Temporarily show so maximize works even when studio has the bubble hidden.
    try {
      window.Tawk_API?.showWidget?.();
    } catch {
      // ignore
    }
    window.Tawk_API.maximize();
  });
  return true;
}
