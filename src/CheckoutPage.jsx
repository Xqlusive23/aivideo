import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { LogoLockup } from "./Logo.jsx";
import { LEDGER_URL, getClientPlatform, normalizeAccessToken } from "./ledgerClient.js";
import {
  TOP_UP_OPTIONS,
  formatCredits,
  formatLiveTimeFromCredits,
  formatNaira,
  formatUsdFromNaira,
} from "./pricing.js";

const EMAIL_STORAGE_KEY = "inspiretech_checkout_email";
const PHONE_STORAGE_KEY = "inspiretech_checkout_phone";

function readStoredAccessToken() {
  try {
    return normalizeAccessToken(window.localStorage.getItem("inspiretech_access_token") || "");
  } catch {
    return "";
  }
}

function readStoredContact(key) {
  try {
    return String(window.localStorage.getItem(key) || "").trim();
  } catch {
    return "";
  }
}

function writeStoredContact(key, value) {
  try {
    window.localStorage.setItem(key, String(value || "").trim());
  } catch {
    // ignore
  }
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function isValidPhone(value) {
  return String(value || "").replace(/\D/g, "").length >= 10;
}

export default function CheckoutPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const creditsParam = Number(searchParams.get("credits") || 0);
  const pack = useMemo(
    () => TOP_UP_OPTIONS.find((opt) => opt.credits === creditsParam) || null,
    [creditsParam]
  );
  const [email, setEmail] = useState(() => readStoredContact(EMAIL_STORAGE_KEY));
  const [phone, setPhone] = useState(() => readStoredContact(PHONE_STORAGE_KEY));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accessToken = useMemo(() => readStoredAccessToken(), []);

  useEffect(() => {
    if (!accessToken) return undefined;
    let cancelled = false;
    const loadContact = async () => {
      try {
        const res = await fetch(`${LEDGER_URL}/api/access-check`, {
          headers: {
            "X-Access-Token": accessToken,
            "X-Client-Platform": getClientPlatform(),
          },
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled || !res.ok) return;
        if (!email && data.customerEmail) setEmail(String(data.customerEmail));
        if (!phone && data.customerPhone) setPhone(String(data.customerPhone));
      } catch {
        // ignore — user can type contact details
      }
    };
    void loadContact();
    return () => {
      cancelled = true;
    };
    // Prefill once from the ledger; don't re-run when the user edits fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const startFlutterwaveCheckout = async () => {
    if (!pack) return;
    const nextEmail = email.trim();
    const nextPhone = phone.trim();
    if (!isValidEmail(nextEmail)) {
      setError("Enter a valid email address.");
      return;
    }
    if (!isValidPhone(nextPhone)) {
      setError("Enter a valid phone number.");
      return;
    }
    if (!accessToken) {
      setError("Sign in with your access token in the studio first.");
      return;
    }

    writeStoredContact(EMAIL_STORAGE_KEY, nextEmail);
    writeStoredContact(PHONE_STORAGE_KEY, nextPhone);
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`${LEDGER_URL}/api/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Access-Token": accessToken,
          "X-Client-Platform": getClientPlatform(),
        },
        body: JSON.stringify({
          credits: pack.credits,
          email: nextEmail,
          phone: nextPhone,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        throw new Error(data.error || `Checkout failed (${res.status})`);
      }
      window.location.assign(data.url);
    } catch (err) {
      setError(err?.message || "Could not start Flutterwave checkout.");
      setBusy(false);
    }
  };

  if (!pack) {
    return (
      <div className="itc-checkout-page">
        <div className="itc-checkout-shell">
          <LogoLockup size="md" />
          <h1 className="itc-checkout-title">Choose a credit pack first</h1>
          <p className="itc-checkout-lead">
            Return to the studio, select a pack, then continue to Flutterwave checkout.
          </p>
          <Link to="/app" className="itc-btn itc-btn-primary">
            Back to studio
          </Link>
          <nav className="itc-checkout-legal" aria-label="Policies">
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/refund">Refunds</Link>
            <Link to="/contact">Contact</Link>
          </nav>
        </div>
      </div>
    );
  }

  return (
    <div className="itc-checkout-page">
      <div className="itc-checkout-shell">
        <header className="itc-checkout-header">
          <LogoLockup size="sm" />
          <button type="button" className="itc-checkout-back" onClick={() => navigate("/app")}>
            ← Back to studio
          </button>
        </header>

        <p className="itc-checkout-eyebrow">Secure checkout</p>
        <h1 className="itc-checkout-title">Pay with Flutterwave</h1>
        <p className="itc-checkout-lead">
          Studio credit packs are paid by card, USSD, or Flutterwave bank options. Credits are added automatically after a successful payment.
        </p>

        <article className="itc-checkout-summary">
          <div>
            <div className="itc-checkout-summary-label">Credit pack</div>
            <div className="itc-checkout-summary-value">{formatCredits(pack.credits)} credits</div>
            <div className="itc-checkout-summary-meta">
              {formatLiveTimeFromCredits(pack.credits)} live (approx.)
            </div>
          </div>
          <div className="itc-checkout-summary-amount">
            <div className="itc-checkout-summary-naira">{formatNaira(pack.naira)}</div>
            <div className="itc-checkout-summary-usd">≈ {formatUsdFromNaira(pack.naira)}</div>
          </div>
        </article>

        <section className="itc-checkout-details">
          <h2 className="itc-checkout-section-title">Billing details</h2>
          <p className="itc-checkout-details-lead">
            Email and phone are required by Flutterwave.
          </p>
          <div className="itc-checkout-fields">
            <div className="itc-checkout-field">
              <label htmlFor="itc-checkout-email">Email</label>
              <input
                id="itc-checkout-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@email.com"
              />
            </div>
            <div className="itc-checkout-field">
              <label htmlFor="itc-checkout-phone">Phone</label>
              <input
                id="itc-checkout-phone"
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+234 …"
              />
            </div>
          </div>
        </section>

        <div className="itc-checkout-actions">
          <button
            type="button"
            className="itc-btn itc-btn-primary"
            onClick={() => void startFlutterwaveCheckout()}
            disabled={busy}
          >
            {busy ? "Opening Flutterwave…" : "Continue to Flutterwave"}
          </button>
          {error ? <p className="itc-checkout-error">{error}</p> : null}
          <p className="itc-checkout-fine">
            You’ll return to the studio after payment. Credits are applied automatically.
          </p>
        </div>

        <nav className="itc-checkout-legal" aria-label="Policies">
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/refund">Refunds</Link>
          <Link to="/contact">Contact</Link>
        </nav>
      </div>
    </div>
  );
}
