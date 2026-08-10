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
  return (
    path === "/app" ||
    path.startsWith("/app/") ||
    path === "/pay" ||
    path.startsWith("/pay/") ||
    path === "/checkout" ||
    path.startsWith("/checkout/")
  );
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
        const handleChatMinimized = () => {
          if (typeof prior === "function") prior();
          hideLiveChatWidget();
        };
        api.onChatMinimized = handleChatMinimized;
        return () => {
          if (api.onChatMinimized === handleChatMinimized) {
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
