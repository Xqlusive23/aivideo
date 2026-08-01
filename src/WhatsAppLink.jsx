import React, { useState } from "react";
import { WHATSAPP_NUMBER, WHATSAPP_NUMBERS } from "./siteConfig.js";
import {
  buildWhatsAppDeepLink,
  buildWhatsAppUrl,
  copyWhatsAppNumber,
  formatWhatsAppDisplay,
  isMobileWhatsAppDevice,
} from "./whatsappContact.js";

export default function WhatsAppLink({
  message,
  className = "itc-access-whatsapp",
  children,
  showFallback = true,
}) {
  const [copiedNumber, setCopiedNumber] = useState("");
  const href = buildWhatsAppUrl(message) || "#";
  const contactNumbers = WHATSAPP_NUMBERS.length ? WHATSAPP_NUMBERS : WHATSAPP_NUMBER ? [WHATSAPP_NUMBER] : [];

  const openWhatsApp = (event) => {
    if (!buildWhatsAppUrl(message)) {
      event.preventDefault();
      return;
    }

    if (isMobileWhatsAppDevice()) {
      event.preventDefault();
      const deepLink = buildWhatsAppDeepLink(message);
      if (deepLink) window.location.href = deepLink;
      return;
    }

    // Desktop: api.whatsapp.com opens WhatsApp Web when available.
  };

  const handleCopy = async (event, number) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      const ok = await copyWhatsAppNumber(number);
      if (!ok) return;
      setCopiedNumber(number);
      window.setTimeout(() => setCopiedNumber(""), 2000);
    } catch {
      // ignore
    }
  };

  const isButtonLayout = /\bitc-btn\b/.test(className);

  return (
    <div className={`itc-whatsapp-contact${isButtonLayout ? " itc-whatsapp-contact-btn" : ""}`}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onClick={openWhatsApp}
      >
        {children}
      </a>
      {showFallback && contactNumbers.length > 0 && (
        <p className={`itc-whatsapp-fallback${isButtonLayout ? " itc-whatsapp-fallback-stack" : ""}`}>
          <span className="itc-whatsapp-fallback-label">Or message</span>
          <span className="itc-whatsapp-fallback-numbers">
            {contactNumbers.map((number, index) => {
              const displayNumber = formatWhatsAppDisplay(number);
              const chatUrl = buildWhatsAppUrl(message, number);
              return (
                <React.Fragment key={number}>
                  {index > 0 ? <span className="itc-whatsapp-fallback-sep">or</span> : null}
                  {chatUrl ? (
                    <a href={chatUrl} target="_blank" rel="noopener noreferrer" className="itc-whatsapp-copy">
                      {displayNumber}
                    </a>
                  ) : (
                    <button type="button" className="itc-whatsapp-copy" onClick={(event) => handleCopy(event, number)}>
                      {displayNumber}
                    </button>
                  )}
                </React.Fragment>
              );
            })}
            {copiedNumber ? <span className="itc-whatsapp-fallback-copied"> — copied</span> : null}
          </span>
        </p>
      )}
    </div>
  );
}
