import React from "react";
import { Link, Navigate } from "react-router-dom";
import { LogoLockup } from "./Logo.jsx";
import WhatsAppLink from "./WhatsAppLink.jsx";
import {
  BUSINESS_ADDRESS,
  BUSINESS_EMAIL,
  BUSINESS_LEGAL_NAME,
  BUSINESS_PHONE_DISPLAY,
  BUSINESS_WEBSITE,
  LEGAL_EFFECTIVE_DATE,
  SITE_NAME,
  WHATSAPP_DEFAULT_MESSAGE,
} from "./siteConfig.js";
import { isLiveChatEnabled, openLiveChat } from "./liveChat.js";

function ContactBlock() {
  return (
    <ul className="itc-legal-contact-list">
      <li>
        <strong>Business name:</strong> {BUSINESS_LEGAL_NAME}
      </li>
      <li>
        <strong>Business email:</strong>{" "}
        <a href={`mailto:${BUSINESS_EMAIL}`}>{BUSINESS_EMAIL}</a>
      </li>
      <li>
        <strong>Business phone:</strong> {BUSINESS_PHONE_DISPLAY}
      </li>
      <li>
        <strong>Business address:</strong> {BUSINESS_ADDRESS}
      </li>
      <li>
        <strong>Website:</strong>{" "}
        <a href={BUSINESS_WEBSITE} target="_blank" rel="noopener noreferrer">
          {BUSINESS_WEBSITE}
        </a>
      </li>
    </ul>
  );
}

const DOCS = {
  terms: {
    title: "Terms and Conditions",
    sections: [
      {
        heading: "1. Agreement",
        body: [
          `These Terms and Conditions (“Terms”) govern your access to and use of ${SITE_NAME} (the “Service”), including our website, web studio, Windows desktop app, access tokens, and credit-based realtime AI video features.`,
          `By requesting access, purchasing credits, or using the Service, you agree to these Terms. If you do not agree, do not use the Service.`,
        ],
      },
      {
        heading: "2. Who we are",
        body: [
          `The Service is operated by ${BUSINESS_LEGAL_NAME}. Contact details are listed below and on our Contact page.`,
        ],
        extra: <ContactBlock />,
      },
      {
        heading: "3. Eligibility and invite access",
        body: [
          "The Service is invite-only. Access requires a personal access token issued by us after you request access and, where applicable, complete payment.",
          "You must provide accurate contact information when requesting access or purchasing credits. You are responsible for keeping your access token confidential.",
        ],
      },
      {
        heading: "4. Credits and digital services",
        body: [
          "Credits are prepaid digital units used for live AI video transformation and related studio features. Credits are not cash, have no intrinsic monetary value outside the Service, and are non-transferable except as required by law.",
          "Live transforming consumes credits while output is active. Approximate live minutes shown on the site are estimates only; actual consumption depends on session length and product settings.",
          "Certain features (for example AI voice changer or scene / background tools) may unlock only after purchasing eligible credit packs.",
        ],
      },
      {
        heading: "5. Payments",
        body: [
          "Payments may be collected through supported channels such as Flutterwave checkout, bank transfer, or USDT, as shown at the time of purchase.",
          "For manual payments, credits or access are applied after we confirm payment. For card / Flutterwave checkout (when enabled on your account), credits are typically applied after successful verification of the transaction.",
          "Prices may be shown in NGN and/or USD equivalents. FX display amounts are approximate.",
        ],
      },
      {
        heading: "6. Acceptable use",
        body: [
          "You agree not to misuse the Service, including by attempting unauthorized access, reverse engineering, reselling access tokens, abusing free trials, harassing others, or using the Service for unlawful, fraudulent, or harmful content.",
          "We may suspend or revoke access tokens for abuse, chargebacks, unpaid fraud, or violation of these Terms.",
        ],
      },
      {
        heading: "7. Third-party services",
        body: [
          "The Service relies on third-party providers (including AI inference, hosting, messaging, and payment processors). Their availability and policies are outside our full control. We are not liable for outages or changes by those providers beyond what applicable law requires.",
        ],
      },
      {
        heading: "8. Disclaimers",
        body: [
          `The Service is provided “as is” and “as available.” AI output quality may vary. We do not guarantee uninterrupted service, specific visual results, or compatibility with every calling app or device.`,
          "To the fullest extent permitted by law, we disclaim warranties of merchantability, fitness for a particular purpose, and non-infringement.",
        ],
      },
      {
        heading: "9. Limitation of liability",
        body: [
          "To the fullest extent permitted by law, our total liability for claims relating to the Service is limited to the amount you paid us for credits in the 30 days before the claim. We are not liable for indirect, incidental, special, consequential, or punitive damages.",
        ],
      },
      {
        heading: "10. Changes",
        body: [
          "We may update these Terms from time to time. The effective date above will change when we do. Continued use after updates constitutes acceptance of the revised Terms.",
        ],
      },
      {
        heading: "11. Contact",
        body: [
          "Questions about these Terms: email us or message us on WhatsApp using the contact details below.",
        ],
        extra: <ContactBlock />,
      },
    ],
  },
  privacy: {
    title: "Privacy Policy",
    sections: [
      {
        heading: "1. Overview",
        body: [
          `This Privacy Policy explains how ${BUSINESS_LEGAL_NAME} (“we”, “us”) collects, uses, and protects information when you use ${SITE_NAME}.`,
          `Effective date: ${LEGAL_EFFECTIVE_DATE}.`,
        ],
      },
      {
        heading: "2. Information we collect",
        body: [
          "Account and access data: access tokens, labels/notes we store for admin support, trial or purchase flags, and credit balances.",
          "Contact and payment-related data: email, phone number, WhatsApp number, payment proofs you send, and transaction references from payment providers (for example Flutterwave).",
          "Usage data: session timing, credit consumption, device/platform signals needed for studio features, and basic diagnostics/error logs.",
          "Content you upload: reference images and optional prompts/background media you provide for transformation. We process these to deliver the Service.",
          "Communications: messages you send via WhatsApp, live chat, or email.",
        ],
      },
      {
        heading: "3. How we use information",
        body: [
          "To provide and operate the Service (authentication, billing/credits, live sessions).",
          "To process payments, confirm transfers, prevent fraud/abuse, and unlock features.",
          "To respond to support requests and communicate about your account.",
          "To improve reliability, security, and product quality.",
          "To comply with legal obligations and payment-provider requirements.",
        ],
      },
      {
        heading: "4. Sharing",
        body: [
          "We share information with service providers who help us run the Service, such as payment processors, cloud hosting, AI inference providers, and customer messaging tools. They process data on our instructions or as independent controllers under their own policies where applicable.",
          "We may disclose information if required by law, to protect rights and safety, or in connection with a business transfer.",
          "We do not sell your personal information.",
        ],
      },
      {
        heading: "5. Retention",
        body: [
          "We retain account, payment, and transaction records as needed to operate the Service, handle disputes/chargebacks, and meet legal/accounting requirements. Uploaded media may be processed transiently for live sessions and may be cached briefly for performance.",
        ],
      },
      {
        heading: "6. Security",
        body: [
          "We use reasonable technical and organizational measures to protect data. No method of transmission or storage is fully secure; please protect your access token and devices.",
        ],
      },
      {
        heading: "7. Your choices",
        body: [
          "You may contact us to update contact details, ask about your account data, or request deletion where applicable law allows. Some records (for example payment history) may need to be retained for compliance.",
        ],
      },
      {
        heading: "8. Children’s privacy",
        body: [
          "The Service is not directed to children under 13 (or the minimum age required in your jurisdiction). Do not use the Service if you are under that age.",
        ],
      },
      {
        heading: "9. Contact",
        body: [
          "For privacy questions or requests, contact:",
        ],
        extra: <ContactBlock />,
      },
    ],
  },
  refund: {
    title: "Refund Policy",
    sections: [
      {
        heading: "1. Digital credits",
        body: [
          `${SITE_NAME} sells digital access and prepaid credits for realtime AI video services. Because credits are digital and can be consumed immediately, all sales are generally final once payment is confirmed and credits or access have been issued.`,
        ],
      },
      {
        heading: "2. When refunds may be considered",
        body: [
          "We may, at our discretion, consider a refund or credit adjustment if:",
        ],
        bullets: [
          "You were charged more than once for the same successful order due to a technical error.",
          "Credits were not delivered after we confirmed a successful payment, and we cannot resolve delivery within a reasonable time.",
          "A payment provider or bank confirms an unauthorized duplicate capture attributable to our systems.",
        ],
      },
      {
        heading: "3. Non-refundable cases",
        body: [
          "Refunds are typically not available for:",
        ],
        bullets: [
          "Credits already partially or fully used.",
          "Dissatisfaction with AI output quality, latency, or creative results.",
          "Device, network, or third-party calling-app issues outside our control.",
          "Trial usage, unused remaining credits after voluntary non-use, or revoked access for Terms violations / abuse.",
          "Wrong payment method details entered by the customer for manual bank/USDT transfers (always verify details on the checkout page before paying).",
        ],
      },
      {
        heading: "4. How to request a review",
        body: [
          "Email or WhatsApp us within 7 days of the payment with: your access token, payment reference / receipt, amount, date, and a short description of the issue. We aim to respond within 2–5 business days.",
        ],
        extra: <ContactBlock />,
      },
      {
        heading: "5. Chargebacks",
        body: [
          "If you file a chargeback, contact us first so we can help. Unfounded chargebacks may result in suspension of the related access token while the dispute is investigated.",
        ],
      },
    ],
  },
  contact: {
    title: "Contact Information",
    sections: [
      {
        heading: "Business contact",
        body: [
          `For support, billing, access requests, refunds, and legal notices, contact ${BUSINESS_LEGAL_NAME}:`,
        ],
        extra: <ContactBlock />,
      },
      {
        heading: "Fastest support channels",
        body: [
          "WhatsApp and live chat are usually the fastest ways to reach us for access tokens and payment confirmation.",
        ],
      },
    ],
  },
};

function LegalShell({ title, children }) {
  return (
    <div className="itc-legal-page">
      <div className="itc-legal-shell">
        <header className="itc-legal-header">
          <Link to="/" className="itc-legal-brand" aria-label={`${SITE_NAME} home`}>
            <LogoLockup size="sm" />
          </Link>
          <nav className="itc-legal-nav" aria-label="Legal pages">
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/refund">Refunds</Link>
            <Link to="/contact">Contact</Link>
          </nav>
        </header>

        <p className="itc-legal-effective">Effective date: {LEGAL_EFFECTIVE_DATE}</p>
        <h1 className="itc-legal-title">{title}</h1>
        <div className="itc-legal-body">{children}</div>

        <footer className="itc-legal-footer">
          <div className="itc-legal-footer-actions">
            {isLiveChatEnabled() ? (
              <button
                type="button"
                className="itc-btn itc-btn-secondary"
                onClick={() => openLiveChat(WHATSAPP_DEFAULT_MESSAGE)}
              >
                Live chat
              </button>
            ) : null}
            <WhatsAppLink message={WHATSAPP_DEFAULT_MESSAGE} className="itc-btn itc-btn-primary" showFallback={false}>
              WhatsApp
            </WhatsAppLink>
            <Link to="/" className="itc-btn itc-btn-secondary">
              Back to home
            </Link>
          </div>
          <p className="itc-legal-footer-note">
            © {new Date().getFullYear()} {BUSINESS_LEGAL_NAME}
          </p>
        </footer>
      </div>
    </div>
  );
}

export default function LegalPage({ docId }) {
  const doc = DOCS[docId];
  if (!doc) return <Navigate to="/contact" replace />;

  return (
    <LegalShell title={doc.title}>
      {doc.sections.map((section) => (
        <section key={section.heading} className="itc-legal-section">
          <h2>{section.heading}</h2>
          {section.body?.map((paragraph) => (
            <p key={paragraph.slice(0, 48)}>{paragraph}</p>
          ))}
          {section.bullets?.length ? (
            <ul>
              {section.bullets.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          {section.extra || null}
        </section>
      ))}
    </LegalShell>
  );
}
