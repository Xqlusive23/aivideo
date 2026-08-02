import React from "react";
import WhatsAppLink from "./WhatsAppLink.jsx";
import { isLiveChatEnabled, openLiveChat } from "./liveChat.js";

export default function ContactSupport({
  whatsappMessage,
  chatMessage,
  chatLabel = "Chat with us — live",
  whatsappLabel = "Message on WhatsApp",
  layout = "landing",
  showWhatsAppFallback = true,
}) {
  const liveChatOn = isLiveChatEnabled();
  const draftMessage = chatMessage || whatsappMessage;

  return (
    <div className={`itc-contact-support${layout === "landing" ? " itc-contact-support-landing" : ""}`}>
      {liveChatOn && (
        <button
          type="button"
          className={`itc-btn itc-btn-primary${layout === "landing" ? " itc-contact-chat-btn" : ""}`}
          onClick={() => openLiveChat(draftMessage)}
        >
          {chatLabel}
        </button>
      )}
      <WhatsAppLink
        message={whatsappMessage}
        className={liveChatOn ? "itc-btn itc-btn-secondary itc-contact-whatsapp-btn" : "itc-btn itc-btn-primary"}
        showFallback={showWhatsAppFallback}
      >
        {whatsappLabel}
      </WhatsAppLink>
    </div>
  );
}
