// Shared public-site constants — safe to import from landing page and app.

import { buildAccessRequestPriceListMessage } from "./pricing.js";

// Full international numbers, digits only (no +, spaces, or leading 0).
// Nigeria: 2348145225075   US: 13802721170
const DEFAULT_WHATSAPP_NUMBERS = ["2348145225075", "13802721170"];

function normalizeWhatsAppNumber(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  // Allow env like +234 080... by dropping a trunk 0 after country code.
  if (digits.startsWith("2340")) {
    digits = `234${digits.slice(4)}`;
  }
  return digits;
}

function parseWhatsAppNumbers(raw) {
  const source = String(raw || "").trim();
  if (!source) return [];
  return source
    .split(/[,;|/\s]+/)
    .map(normalizeWhatsAppNumber)
    .filter(Boolean);
}

function formatWhatsAppDisplay(raw) {
  const digits = normalizeWhatsAppNumber(raw);
  if (!digits) return "";

  if (digits.startsWith("1") && digits.length === 11) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.startsWith("234") && digits.length >= 13) {
    return `+234 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }

  return `+${digits}`;
}

function envText(key) {
  return String(import.meta.env?.[key] || "").trim();
}

export const WHATSAPP_NUMBERS = (() => {
  const fromList = parseWhatsAppNumbers(import.meta.env?.VITE_WHATSAPP_NUMBERS);
  if (fromList.length) return fromList;
  const single = normalizeWhatsAppNumber(import.meta.env?.VITE_WHATSAPP_NUMBER);
  if (single) return [single];
  return DEFAULT_WHATSAPP_NUMBERS;
})();

export const WHATSAPP_NUMBER = WHATSAPP_NUMBERS[0] || "";

export const WHATSAPP_DISPLAY =
  import.meta.env?.VITE_WHATSAPP_DISPLAY ||
  WHATSAPP_NUMBERS.map((number) => formatWhatsAppDisplay(number)).join(" · ");

/**
 * Manual payout rails.
 * - Access-token WhatsApp requests: USDT only
 * - Studio credit checkout (existing unlocked users): USDT + all bank accounts
 */
export const PAYMENT_USDT = {
  // Locked to Bybit TRC20 deposit screenshot (do not “fix” from chat paste — paste often corrupts).
  address: envText("VITE_PAYMENT_USDT_ADDRESS") || "TTMHRcNhmNVS9cRFhvaRxs83Hqz2TpDT83",
  network: envText("VITE_PAYMENT_USDT_NETWORK") || "TRON (TRC20)",
  note:
    envText("VITE_PAYMENT_USDT_NOTE") ||
    "Send USDT on TRC20 only, then message proof on WhatsApp",
};

const DEFAULT_PAYMENT_BANKS = [
  {
    bankName: "Wema Bank PLC",
    accountName: "Sogbuyi Imisioluwa",
    accountNumber: "0451404819",
  },
  {
    bankName: "Opay",
    accountName: "Sogbuyi Imisioluwa",
    accountNumber: "6525938341",
  },
];

function parsePaymentBanksFromEnv() {
  const raw = envText("VITE_PAYMENT_BANKS_JSON");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((entry) => ({
        bankName: String(entry?.bankName || "").trim(),
        accountName: String(entry?.accountName || "").trim(),
        accountNumber: String(entry?.accountNumber || "").trim(),
      }))
      .filter((entry) => entry.bankName && entry.accountName && entry.accountNumber);
  } catch {
    return null;
  }
}

export const PAYMENT_BANKS = (() => {
  const fromEnv = parsePaymentBanksFromEnv();
  if (fromEnv?.length) return fromEnv;

  const single = {
    bankName: envText("VITE_PAYMENT_BANK_NAME"),
    accountName: envText("VITE_PAYMENT_BANK_ACCOUNT_NAME"),
    accountNumber: envText("VITE_PAYMENT_BANK_ACCOUNT_NUMBER"),
  };
  if (single.bankName && single.accountName && single.accountNumber) {
    return [single];
  }
  return DEFAULT_PAYMENT_BANKS;
})();

/** @deprecated Use PAYMENT_BANKS — kept for older imports. */
export const PAYMENT_BANK = {
  ...(PAYMENT_BANKS[0] || {
    bankName: "",
    accountName: "",
    accountNumber: "",
  }),
  currency: envText("VITE_PAYMENT_BANK_CURRENCY") || "NGN",
  note:
    envText("VITE_PAYMENT_BANK_NOTE") ||
    "For Nigeria bank transfer — send proof on WhatsApp after payment",
};

export const hasUsdtPayment = Boolean(PAYMENT_USDT.address);
export const hasBankPayment = PAYMENT_BANKS.length > 0;

const accessRequestPaymentOpts = {
  usdtAddress: PAYMENT_USDT.address,
  usdtNetwork: PAYMENT_USDT.network,
};

export const WHATSAPP_DEFAULT_MESSAGE = "Hi, I need help getting access to InspireTech.";
export const WHATSAPP_ACCESS_REQUEST_MESSAGE = buildAccessRequestPriceListMessage({
  ...accessRequestPaymentOpts,
});
export const WHATSAPP_TRIAL_PURCHASE_MESSAGE = buildAccessRequestPriceListMessage({
  intro:
    "Hi, my InspireTech trial ended (or I'm ready to buy). Please send an access-code / invite package (not the in-studio subscription packs) and unlock my account.",
  askTrial: false,
  ...accessRequestPaymentOpts,
});

/** Short WhatsApp proof message — no payment account details, token attached for admin. */
export function buildStudioTopUpWhatsAppMessage({
  credits,
  method = "",
  accessToken = "",
} = {}) {
  const lines = ["Please upload a proof of payment."];

  const token = String(accessToken || "").trim();
  if (token) {
    lines.push(`Access token: ${token}`);
  }

  if (credits) {
    lines.push(`Credits: ${Number(credits).toLocaleString()}`);
  }

  if (method === "usdt") lines.push("Paid via: USDT");
  if (method === "bank") lines.push("Paid via: bank transfer");

  return lines.join("\n");
}

export const WHATSAPP_STUDIO_TOPUP_MESSAGE = buildStudioTopUpWhatsAppMessage();

/** Tawk.to widget IDs — from embed URL https://embed.tawk.to/PROPERTY_ID/WIDGET_ID */
export const TAWK_PROPERTY_ID = String(
  import.meta.env?.VITE_TAWK_PROPERTY_ID || "6a6f1bd63d515d1d445ae8d0"
).trim();
export const TAWK_WIDGET_ID = String(import.meta.env?.VITE_TAWK_WIDGET_ID || "1jv109gb2").trim();

export const WINDOWS_DOWNLOAD_FALLBACK =
  "https://github.com/Xqlusive23/aivideo/releases/download/v0.3.23/InspireTech.Setup.0.3.23.exe";

// Vercel may still have a stale VITE_WINDOWS_DOWNLOAD_URL — LandingPage resolves latest from GitHub.
export const WINDOWS_DOWNLOAD_URL =
  import.meta.env?.VITE_WINDOWS_DOWNLOAD_URL || WINDOWS_DOWNLOAD_FALLBACK;

export const SITE_NAME = "InspireTech";
export const SITE_TAGLINE = "Real-time AI video transformation for live calls";
export const LOGO_SRC = `${import.meta.env.BASE_URL}logo.png`;
