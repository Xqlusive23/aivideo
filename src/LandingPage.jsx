import React from "react";
import { Link, useNavigate } from "react-router-dom";
import AccessGate from "./AccessGate";
import { LogoLockup } from "./Logo.jsx";
import { featureAccents } from "./theme";
import {
  SITE_NAME,
  SITE_TAGLINE,
  WHATSAPP_NUMBER,
  WHATSAPP_ACCESS_REQUEST_MESSAGE,
  WINDOWS_DOWNLOAD_URL,
} from "./siteConfig";

const FEATURES = [
  {
    icon: "🎭",
    title: "Live face transformation",
    body: "Upload a reference photo and become that character in real time — powered by Decart Lucy 2.5 over WebRTC.",
  },
  {
    icon: "📹",
    title: "Virtual camera for calls",
    body: "The Windows desktop app feeds transformed video into InspireTech Camera so Zoom, Telegram, and Discord pick it up directly.",
  },
  {
    icon: "🎙️",
    title: "Voice changer",
    body: "Optional AI voice conversion routes to a virtual microphone — same pipeline, no OBS window capture.",
  },
  {
    icon: "💳",
    title: "Pay-as-you-go credits",
    body: "Usage is metered per second while live. Top up with Paystack when you need more time.",
  },
];

const STEPS = [
  "Request access — we send you a personal access token.",
  "Download the Windows app or use the web studio in your browser.",
  "Pick your camera, upload a reference image, and start transforming.",
  "In your calling app, select InspireTech Camera and CABLE Output as mic.",
];

export default function LandingPage() {
  const navigate = useNavigate();

  const handleAuthenticated = (token) => {
    try {
      window.localStorage.setItem("inspiretech_access_token", token);
    } catch {
      // ignore
    }
    navigate("/app");
  };

  const whatsappAccessUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(WHATSAPP_ACCESS_REQUEST_MESSAGE)}`;
  const downloadReady = Boolean(WINDOWS_DOWNLOAD_URL);

  return (
    <div className="itc-landing">
      <header className="itc-landing-header">
        <div className="itc-landing-nav">
          <div className="itc-landing-logo">
            <LogoLockup size="md" />
            <span className="itc-landing-badge">v2.8</span>
          </div>
          <nav className="itc-landing-nav-links">
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
            <p className="itc-landing-eyebrow">Real-time AI video for live calls</p>
            <h1 className="itc-landing-hero-title">
              Transform on camera.
              <br />
              <span className="itc-landing-hero-gradient">Call like it's really you.</span>
            </h1>
            <p className="itc-landing-hero-body">
              {SITE_TAGLINE}. InspireTech turns your webcam feed into a live AI character and pipes it straight into your favorite calling apps — no OBS, no manual capture.
            </p>
            <div className="itc-landing-hero-actions">
              <a href="#access" className="itc-btn itc-btn-primary">Get access</a>
              <a href="#download" className="itc-btn itc-btn-secondary">Download Windows app</a>
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
              InspireTech is invite-only. Request an access token — we'll create your account and send you a personal token to paste below or in the studio.
            </p>
            <a
              href={whatsappAccessUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="itc-btn itc-btn-primary"
            >
              Request access on WhatsApp
            </a>
            <p className="itc-landing-fine-print">
              Already received a token? Enter it on the right to open the studio instantly.
            </p>
          </div>
          <AccessGate embedded onAuthenticated={handleAuthenticated} />
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
              <a href={WINDOWS_DOWNLOAD_URL} className="itc-btn itc-btn-primary" download>
                Download InspireTech Setup.exe
              </a>
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
        <a href={whatsappAccessUrl} target="_blank" rel="noopener noreferrer">
          Contact on WhatsApp
        </a>
      </footer>
    </div>
  );
}
