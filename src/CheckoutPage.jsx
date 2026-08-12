import React, { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { LogoLockup } from "./Logo.jsx";
import WhatsAppLink from "./WhatsAppLink.jsx";
import {
  PAYMENT_BANK,
  PAYMENT_BANKS,
  PAYMENT_USDT,
  buildStudioTopUpWhatsAppMessage,
  hasBankPayment,
  hasUsdtPayment,
} from "./siteConfig.js";
import { normalizeAccessToken } from "./ledgerClient.js";
import {
  TOP_UP_OPTIONS,
  formatCredits,
  formatLiveTimeFromCredits,
  formatNaira,
  formatUsdFromNaira,
} from "./pricing.js";

const METHODS = [
  {
    id: "usdt",
    label: "USDT",
    subtitle: "Crypto · TRC20",
    available: hasUsdtPayment,
  },
  {
    id: "bank",
    label: "Bank transfer",
    subtitle: `Nigeria · ${PAYMENT_BANK.currency || "NGN"}`,
    available: hasBankPayment,
  },
];

function readStoredAccessToken() {
  try {
    return normalizeAccessToken(window.localStorage.getItem("inspiretech_access_token") || "");
  } catch {
    return "";
  }
}

export default function CheckoutPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const creditsParam = Number(searchParams.get("credits") || 0);
  const pack = useMemo(
    () => TOP_UP_OPTIONS.find((opt) => opt.credits === creditsParam) || null,
    [creditsParam]
  );
  const [method, setMethod] = useState("");
  const accessToken = useMemo(() => readStoredAccessToken(), []);

  const availableMethods = METHODS.filter((entry) => entry.available);
  const selectedMethod = availableMethods.find((entry) => entry.id === method) || null;

  const whatsappMessage = useMemo(
    () =>
      buildStudioTopUpWhatsAppMessage({
        credits: pack?.credits,
        method: selectedMethod?.id || "",
        accessToken,
      }),
    [pack?.credits, selectedMethod?.id, accessToken]
  );

  if (!pack) {
    return (
      <div className="itc-checkout-page">
        <div className="itc-checkout-shell">
          <LogoLockup size="md" />
          <h1 className="itc-checkout-title">Choose a credit pack first</h1>
          <p className="itc-checkout-lead">
            Return to the studio, select a pack, then continue to payment.
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
        <h1 className="itc-checkout-title">Complete your payment</h1>
        <p className="itc-checkout-lead">
          Pick how you want to pay. Payment details appear only after you choose a method.
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

        <section className="itc-checkout-methods" aria-label="Payment methods">
          <h2 className="itc-checkout-section-title">Choose payment method</h2>
          <div className="itc-checkout-method-grid">
            {availableMethods.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`itc-checkout-method${method === entry.id ? " is-active" : ""}`}
                onClick={() => setMethod(entry.id)}
              >
                <span className="itc-checkout-method-label">{entry.label}</span>
                <span className="itc-checkout-method-sub">{entry.subtitle}</span>
              </button>
            ))}
          </div>
        </section>

        {selectedMethod?.id === "usdt" ? (
          <section className="itc-checkout-details">
            <h2 className="itc-checkout-section-title">USDT payment details</h2>
            <p className="itc-checkout-details-lead">{PAYMENT_USDT.note}</p>
            <dl className="itc-checkout-dl">
              <div>
                <dt>Network</dt>
                <dd>{PAYMENT_USDT.network}</dd>
              </div>
              <div>
                <dt>Address</dt>
                <dd className="itc-mono itc-checkout-address">{PAYMENT_USDT.address}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>≈ {formatUsdFromNaira(pack.naira)} USDT</dd>
              </div>
            </dl>
          </section>
        ) : null}

        {selectedMethod?.id === "bank" ? (
          <section className="itc-checkout-details">
            <h2 className="itc-checkout-section-title">Bank transfer details</h2>
            <p className="itc-checkout-details-lead">{PAYMENT_BANK.note}</p>
            <div className="itc-checkout-banks">
              {PAYMENT_BANKS.map((bank) => (
                <dl key={`${bank.bankName}-${bank.accountNumber}`} className="itc-checkout-dl">
                  <div>
                    <dt>Bank</dt>
                    <dd>{bank.bankName}</dd>
                  </div>
                  <div>
                    <dt>Account name</dt>
                    <dd>{bank.accountName}</dd>
                  </div>
                  <div>
                    <dt>Account number</dt>
                    <dd className="itc-mono">{bank.accountNumber}</dd>
                  </div>
                  <div>
                    <dt>Amount</dt>
                    <dd>
                      {formatNaira(pack.naira)} ({PAYMENT_BANK.currency})
                    </dd>
                  </div>
                </dl>
              ))}
            </div>
          </section>
        ) : null}

        {selectedMethod ? (
          <div className="itc-checkout-actions">
            <WhatsAppLink
              message={whatsappMessage}
              className="itc-btn itc-btn-primary"
              showFallback={false}
            >
              Upload proof on WhatsApp
            </WhatsAppLink>
            <p className="itc-checkout-fine">
              Your access token is attached automatically so we can credit the right account.
            </p>
          </div>
        ) : (
          <p className="itc-checkout-fine itc-checkout-wait">Select a payment method to continue.</p>
        )}

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
