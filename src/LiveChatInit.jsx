import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import {
  hideLiveChatWidget,
  initLiveChat,
  isLiveChatEnabled,
  showLiveChatWidget,
} from "./liveChat.js";

function isStudioPath(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "") || "/";
  return path === "/app" || path.startsWith("/app/");
}

/** Loads Tawk.to, but hides the floating bubble on the studio route so it never covers the output. */
export default function LiveChatInit() {
  const location = useLocation();

  useEffect(() => {
    if (!isLiveChatEnabled()) return;
    initLiveChat();
  }, []);

  useEffect(() => {
    if (!isLiveChatEnabled()) return;
    if (isStudioPath(location.pathname)) {
      hideLiveChatWidget();
      const api = window.Tawk_API;
      if (api) {
        const prior = api.onChatMinimized;
        api.onChatMinimized = function onChatMinimized() {
          if (typeof prior === "function") prior();
          hideLiveChatWidget();
        };
        return () => {
          if (api.onChatMinimized === onChatMinimized) {
            api.onChatMinimized = prior;
          }
        };
      }
    } else {
      showLiveChatWidget();
    }
  }, [location.pathname]);

  return null;
}
