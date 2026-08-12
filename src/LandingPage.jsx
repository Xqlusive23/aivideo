import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AccessGate from "./AccessGate";
import { LogoLockup } from "./Logo.jsx";
import { featureAccents } from "./theme";
import { checkAccessToken } from "./ledgerClient.js";
import {
  SITE_NAME,
  SITE_TAGLINE,
  WHATSAPP_ACCESS_REQUEST_MESSAGE,
  WINDOWS_DOWNLOAD_URL,
  WINDOWS_DOWNLOAD_FALLBACK,
} from "./siteConfig";
import {
  ACCESS_SALE_PLANS,
  DISPLAY_CREDITS_PER_SECOND,
  TOP_UP_OPTIONS,
  formatCredits,
  formatLiveTimeFromCredits,
  formatNaira,
  formatUsdFromNaira,
  getPricingTierFeatures,
} from "./pricing.js";
import WhatsAppLink from "./WhatsAppLink.jsx";
import ContactSupport from "./ContactSupport.jsx";
import { isLiveChatEnabled, openLiveChat } from "./liveChat.js";

function WindowsIcon() {
  return (
    <svg className="itc-windows-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 5.5 10.5 4.2v7.1H3V5.5zm0 8.4h7.5v7.3L3 19.5v-5.6zm9-9.3L21 3.1v8.6h-9V4.6zm0 9.3h9v8.6l-9-1.4v-7.2z"
      />
    </svg>
  );
}

function useIsMobileDevice() {
  const detect = () =>
    typeof window !== "undefined" &&
    (/iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent) ||
      window.matchMedia("(max-width: 900px)").matches);

  const [isMobileDevice, setIsMobileDevice] = useState(detect);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const sync = () => setIsMobileDevice(detect());
    sync();
    mediaQuery.addEventListener("change", sync);
    return () => mediaQuery.removeEventListener("change", sync);
  }, []);

  return isMobileDevice;
}

function WindowsDownloadButton({
  className = "itc-btn itc-btn-primary itc-btn-windows",
  disabled = false,
}) {
  const [downloadUrl, setDownloadUrl] = useState(WINDOWS_DOWNLOAD_URL);
  const [releaseLabel, setReleaseLabel] = useState("");

  useEffect(() => {
    if (disabled) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("https://api.github.com/repos/Xqlusive23/aivideo/releases/latest", {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!res.ok) return;
        const data = await res.json();
        const asset =
          data.assets?.find((entry) => /\.exe$/i.test(entry.name) && /setup/i.test(entry.name)) ||
          data.assets?.find((entry) => /\.exe$/i.test(entry.name));
        if (cancelled || !asset?.browser_download_url) return;
        setDownloadUrl(asset.browser_download_url);
        const tag = String(data.tag_name || "").replace(/^v/i, "");
        if (tag) setReleaseLabel(`v${tag}`);
      } catch {
        if (!cancelled) setDownloadUrl(WINDOWS_DOWNLOAD_FALLBACK);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [disabled]);

  if (disabled) {
    return (
      <span
        className={`${className} itc-btn-disabled`}
        aria-disabled="true"
        title="The Windows desktop app is for PC only. Use Open studio in your mobile browser."
      >
        <WindowsIcon />
        <span>Windows app — desktop only</span>
      </span>
    );
  }

  return (
    <a href={downloadUrl} className={className} download>
      <WindowsIcon />
      <span>{releaseLabel ? `Download ${releaseLabel}` : "Download for Windows"}</span>
    </a>
  );
}

const FEATURES = [
  {
    icon: "🎭",
    title: "Live face transformation",
    body: "Upload a reference photo and become that character in real time — powered by Decart Lucy 2.5 over WebRTC.",
  },
  {
    icon: "📹",
    title: "Virtual camera for calls",
    body: "The Windows desktop app feeds transformed video into InspireTech Camera so Zoom, Telegram, Discord, and more pick it up directly.",
  },
  {
    icon: "🎙️",
    title: "Voice & scene unlocks",
    body: "AI voice changer unlocks from the 1,000-credit pack; scene library and reference backgrounds unlock from the 2,000-credit pack.",
  },
  {
    icon: "🎟️",
    title: "Invite access + credit packs",
    body: "Request an access code on WhatsApp (separate invite packages). After unlock, buy credit packs in the studio and pay via bank transfer or USDT.",
  },
];

const STEPS = [
  "Request an access code on WhatsApp — the message includes invite pricing and our USDT address for payment.",
  "We send a personal access token. Paste it in the web studio or Windows app.",
  "Upload a reference photo, go live, then select InspireTech Camera (and mic) in your calling app.",
  "When you need more credits, open Buy credits in the studio — pay via USDT or Nigerian bank transfer and send proof.",
];

export default function LandingPage() {
  const navigate = useNavigate();
  const isMobileDevice = useIsMobileDevice();
  const [gateLoading, setGateLoading] = useState(false);
  const [gateError, setGateError] = useState("");
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const txRef = params.get("tx_ref") || params.get("reference");
    const paymentStatus = params.get("status");
    if (txRef || paymentStatus || params.get("checkout") === "success") {
      navigate(`/app?${params.toString()}`, { replace: true });
    }
  }, [navigate]);

  const handleAuthenticated = async (token) => {
    setGateLoading(true);
    setGateError("");
    try {
      const validation = await checkAccessToken(token);
      if (!validation.ok) {
        setGateError(validation.error);
        return;
      }

      try {
        window.localStorage.setItem("inspiretech_access_token", validation.token);
      } catch {
        // ignore
      }
      navigate("/app");
    } finally {
      setGateLoading(false);
    }
  };

  const downloadReady = Boolean(WINDOWS_DOWNLOAD_URL);

  return (
    <div className="itc-landing">
      <header className="itc-landing-header">
        <div className="itc-landing-nav">
          <div className="itc-landing-logo">
            <LogoLockup size="md" />
            <span className="itc-landing-badge">v2.8</span>
          </div>
          <button
            type="button"
            className="itc-landing-nav-toggle"
            aria-expanded={navOpen}
            aria-label={navOpen ? "Close menu" : "Open menu"}
            onClick={() => setNavOpen((open) => !open)}
          >
            {navOpen ? "✕" : "☰"}
          </button>
          <nav
            className={`itc-landing-nav-links${navOpen ? " is-open" : ""}`}
            onClick={() => setNavOpen(false)}
          >
            <a href="#pricing" className="itc-landing-nav-link">Pricing</a>
            <a href="#features" className="itc-landing-nav-link">Features</a>
            <a href="#access" className="itc-landing-nav-link">Get access</a>
            <a href="#download" className="itc-landing-nav-link">Download</a>
            <Link to="/app" className="itc-landing-nav-cta">Open studio</Link>
          </nav>
        </div>
      </header>

      <section className="itc-landing-section itc-landing-hero">
        <div className="itc-landing-hero-grid">
          <div>
            <p className="itc-landing-eyebrow">{SITE_TAGLINE}</p>
            <h1 className="itc-landing-hero-title">
              Transform on camera.
              <br />
              <span className="itc-landing-hero-gradient">Call like it's really you.</span>
            </h1>
            <p className="itc-landing-hero-body">
              InspireTech turns your webcam into a live AI character and pipes it into Zoom, Discord, Telegram, and more — web studio or Windows app with virtual camera. No OBS, no window capture.
            </p>
            <div className="itc-landing-hero-actions">
              <a href="#access" className="itc-btn itc-btn-primary">Get access</a>
              {downloadReady ? (
                <WindowsDownloadButton
                  className="itc-btn itc-btn-secondary itc-btn-windows"
                  disabled={isMobileDevice}
                />
              ) : (
                <a href="#download" className="itc-btn itc-btn-secondary">Download Windows app</a>
              )}
            </div>
          </div>
          <div className="itc-landing-preview">
            <div className="itc-landing-stat">
              <span className="itc-landing-stat-label">Output</span>
              <span className="itc-landing-stat-value violet">Lucy 2.5 realtime</span>
            </div>
            <div className="itc-landing-stat">
              <span className="itc-landing-stat-label">Virtual camera</span>
              <span className="itc-landing-stat-value cyan">InspireTech Camera</span>
            </div>
            <div className="itc-landing-stat">
              <span className="itc-landing-stat-label">Virtual mic</span>
              <span className="itc-landing-stat-value emerald">VB-CABLE Output</span>
            </div>
            <p className="itc-landing-fine-print" style={{ marginTop: 16 }}>
              Desktop app installs drivers on first launch. Web studio works in the browser once you have a token.
            </p>
          </div>
        </div>
      </section>

      <section id="pricing" className="itc-landing-section">
        <h2 className="itc-landing-section-title">Subscription pricing</h2>
        <p className="itc-landing-section-lead">
          Credit packs available in the studio after your account is unlocked. Live transforming uses about{" "}
          {DISPLAY_CREDITS_PER_SECOND} credits/sec.
        </p>
        <div className="itc-landing-pricing-row itc-landing-pricing-row-subscribe">
          {TOP_UP_OPTIONS.map((opt) => (
            <article
              key={opt.credits}
              className={`itc-landing-pricing-tile${opt.popular ? " is-popular" : ""}`}
            >
              {opt.popular ? <span className="itc-landing-pricing-badge">Popular</span> : null}
              <div className="itc-landing-pricing-tile-head">
                <p className="itc-landing-pricing-credits">{formatCredits(opt.credits)} credits</p>
                <p className="itc-landing-pricing-usd">
                  {formatNaira(opt.naira)}
                  <span className="itc-landing-pricing-period"> · ≈ {formatUsdFromNaira(opt.naira)}</span>
                </p>
                <p className="itc-landing-pricing-time">
                  {formatLiveTimeFromCredits(opt.credits)} live (approx.)
                </p>
              </div>
              <ul className="itc-landing-pricing-features">
                {getPricingTierFeatures(opt.credits).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <p className="itc-landing-fine-print">
          Packs unlock after admin confirms your access purchase. Live minutes are approximate.
        </p>
      </section>

      <section id="features" className="itc-landing-section">
        <h2 className="itc-landing-section-title">What InspireTech does</h2>
        <p className="itc-landing-section-lead">
          A full pipeline from your webcam to a system virtual camera and microphone — built for creators, performers, and anyone who wants a live AI look on calls.
        </p>
        <div className="itc-landing-features">
          {FEATURES.map((feature, i) => {
            const accent = featureAccents[i % featureAccents.length];
            return (
              <article
                key={feature.title}
                className="itc-landing-feature"
                style={{ borderColor: accent.border, boxShadow: `0 0 0 1px ${accent.glow}` }}
              >
                <div
                  className="itc-landing-feature-icon"
                  style={{ background: `linear-gradient(135deg, ${accent.glow}, transparent)` }}
                >
                  {feature.icon}
                </div>
                <h3 className="itc-landing-feature-title">{feature.title}</h3>
                <p className="itc-landing-feature-body">{feature.body}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="itc-landing-section">
        <h2 className="itc-landing-section-title">How it works</h2>
        <ol className="itc-landing-steps">
          {STEPS.map((step, index) => (
            <li key={step} className="itc-landing-step">
              <span className="itc-landing-step-num">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <section id="access" className="itc-landing-section">
        <div className="itc-landing-split">
          <div>
            <h2 className="itc-landing-section-title">Get access</h2>
            <p className="itc-landing-section-lead">
              Invite-only. Request an access code on WhatsApp — you can also ask for a short free trial.
            </p>

            <div className="itc-landing-access-box">
              <h3 className="itc-landing-access-box-title">Access-code packages (WhatsApp)</h3>
              <p className="itc-landing-access-box-lead">
                These are for requesting your token — separate from the subscription credit packs in Pricing.
                Messaging us includes this price list plus our USDT pay address.
              </p>
              <ul className="itc-landing-access-plans">
                {ACCESS_SALE_PLANS.map((plan) => (
                  <li key={plan.id}>
                    <strong>
                      {plan.includesAccessToken
                        ? `Access token + ${formatCredits(plan.credits)} credits`
                        : `${formatCredits(plan.credits)} credits`}
                    </strong>
                    {` — $${plan.usd}`}
                    <span className="itc-landing-access-plan-blurb"> · {plan.blurb}</span>
                  </li>
                ))}
              </ul>
            </div>

            <ContactSupport
              whatsappMessage={WHATSAPP_ACCESS_REQUEST_MESSAGE}
              chatMessage={WHATSAPP_ACCESS_REQUEST_MESSAGE}
              chatLabel="Request access — live chat"
              whatsappLabel="Request access on WhatsApp"
              layout="landing"
            />
            <p className="itc-landing-fine-print">
              Already have a token? Enter it on the right to open the studio.
            </p>
          </div>
          <AccessGate
            embedded
            onAuthenticated={handleAuthenticated}
            tokenError={gateError}
            loading={gateLoading}
          />
        </div>
      </section>

      <section id="download" className="itc-landing-section">
        <div className="itc-landing-download">
          <div>
            <h2 className="itc-landing-section-title">Download for Windows</h2>
            <p className="itc-landing-section-lead">
              The InspireTech desktop app bundles the web studio with a virtual camera and virtual microphone setup wizard. First launch installs the drivers you need for calling apps.
            </p>
            <ul className="itc-landing-download-list">
              <li>Virtual camera → InspireTech Camera</li>
              <li>Virtual mic → VB-Audio CABLE Output</li>
              <li>Works with Telegram, Discord, Zoom, and more</li>
            </ul>
          </div>
          <div className="itc-landing-download-actions">
            {downloadReady ? (
              <WindowsDownloadButton disabled={isMobileDevice} />
            ) : (
              <>
                <button className="itc-btn itc-btn-primary" disabled>
                  Installer URL not configured
                </button>
                <p className="itc-landing-fine-print">
                  Set <code className="itc-landing-code">VITE_WINDOWS_DOWNLOAD_URL</code> in your <code className="itc-landing-code">.env</code> to the hosted installer URL after you run <code className="itc-landing-code">npm run dist</code> in <code className="itc-landing-code">aivideo-companion</code>.
                </p>
              </>
            )}
            <Link to="/app" className="itc-btn itc-btn-secondary">
              Or use web studio
            </Link>
          </div>
        </div>
      </section>

      <footer className="itc-landing-footer">
        <span>© {new Date().getFullYear()} {SITE_NAME}</span>
        <span className="itc-landing-footer-links">
          <Link to="/terms" className="itc-landing-footer-link">Terms</Link>
          <Link to="/privacy" className="itc-landing-footer-link">Privacy</Link>
          <Link to="/refund" className="itc-landing-footer-link">Refunds</Link>
          <Link to="/contact" className="itc-landing-footer-link">Contact</Link>
          {isLiveChatEnabled() ? (
            <button
              type="button"
              className="itc-landing-footer-link itc-landing-footer-btn"
              onClick={() => openLiveChat(WHATSAPP_ACCESS_REQUEST_MESSAGE)}
            >
              Live chat
            </button>
          ) : null}
          <WhatsAppLink message={WHATSAPP_ACCESS_REQUEST_MESSAGE} className="itc-landing-footer-link" showFallback={false}>
            WhatsApp
          </WhatsAppLink>
        </span>
      </footer>
    </div>
  );
}
