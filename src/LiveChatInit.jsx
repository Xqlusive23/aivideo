import { useEffect } from "react";
import { initLiveChat, isLiveChatEnabled } from "./liveChat.js";

export default function LiveChatInit() {
  useEffect(() => {
    if (isLiveChatEnabled()) initLiveChat();
  }, []);
  return null;
}
