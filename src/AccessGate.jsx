import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  WHATSAPP_NUMBER,
  WHATSAPP_DEFAULT_MESSAGE,
  SITE_NAME,
} from "./siteConfig";

export default function AccessGate({
  onAuthenticated,
  tokenError = "",
  embedded = false,
  companionMode = false,
  loading = false,
  setupMessage = "",
}) {
  const [tokenInput, setTokenInput] = useState("");

  const submit = () => {
    const trimmed = tokenInput.trim();
    if (!trimmed || loading) return;
    onAuthenticated(trimmed);
  };

  const wrapClass = embedded ? "itc-access-wrap-embedded" : "itc-access-wrap";
  const cardClass = embedded
    ? "itc-access-card itc-access-card-embedded"
    : "itc-access-card";

  return (
    <div className={wrapClass}>
      <div className={cardClass}>
        <div className="itc-access-brand">🛸 {SITE_NAME}</div>
        <h1 className="itc-access-title">
          {companionMode
            ? "Sign in to InspireTech Desktop"
            : embedded
            ? "Enter your access token"
            : "Sign in to the studio"}
        </h1>
        <p className="itc-access-subtitle">
          {companionMode
            ? "Enter the access token we sent you. After sign-in, InspireTech will install the virtual camera and microphone drivers your calling apps need."
            : "Paste the access token you received from us. Tokens are issued manually after you request access."}
        </p>
        <input
          type="text"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="e.g. 3f2a9c1e-4b6d-4a8e-9c2f-1d7e5a6b8c90"
          className="itc-access-input"
          disabled={loading}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {tokenError && <div className="itc-access-error">{tokenError}</div>}
        {setupMessage && <div className="itc-access-setup">{setupMessage}</div>}
        <button
          className="itc-btn itc-btn-primary"
          style={{ width: "100%" }}
          disabled={!tokenInput.trim() || loading}
          onClick={submit}
        >
          {loading
            ? "Please wait…"
            : companionMode
            ? "Continue & install drivers"
            : "Open Studio"}
        </button>
        <a
          href={`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(WHATSAPP_DEFAULT_MESSAGE)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="itc-access-whatsapp"
        >
          💬 Need help? Message us on WhatsApp
        </a>
        {!embedded && !companionMode && (
          <Link to="/" className="itc-access-back">
            ← Back to home
          </Link>
        )}
      </div>
    </div>
  );
}
