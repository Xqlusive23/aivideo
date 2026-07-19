import React, { useState } from "react";
import { WHATSAPP_NUMBER } from "./siteConfig.js";
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
  const [copied, setCopied] = useState(false);
  const href = buildWhatsAppUrl(message) || "#";
  const displayNumber = formatWhatsAppDisplay(WHATSAPP_NUMBER);

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

  const handleCopy = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      const ok = await copyWhatsAppNumber();
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="itc-whatsapp-contact">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onClick={openWhatsApp}
      >
        {children}
      </a>
      {showFallback && displayNumber && (
        <p className="itc-whatsapp-fallback">
          Or save{" "}
          <button type="button" className="itc-whatsapp-copy" onClick={handleCopy}>
            {displayNumber}
          </button>{" "}
          {copied ? "copied — paste in WhatsApp" : "to contacts, then message us there"}
        </p>
      )}
    </div>
  );
}
