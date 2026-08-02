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

/** Opens the Tawk.to widget. Message is stored as visitor metadata for agents (Tawk cannot prefill the input). */
export function openLiveChat(message) {
  if (!isLiveChatEnabled()) return false;
  initLiveChat();

  const text = String(message || "").trim();
  runWhenTawkReady(() => {
    if (text && window.Tawk_API?.setAttributes) {
      window.Tawk_API.setAttributes({ accessRequest: text }, () => {});
    }
    window.Tawk_API.maximize();
  });
  return true;
}
