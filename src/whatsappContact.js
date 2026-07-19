import { WHATSAPP_NUMBER } from "./siteConfig.js";

export function normalizeWhatsAppNumber(raw) {
  return String(raw || "").replace(/\D/g, "");
}

export function formatWhatsAppDisplay(raw = WHATSAPP_NUMBER) {
  const digits = normalizeWhatsAppNumber(raw);
  if (!digits) return "";

  if (digits.startsWith("1") && digits.length === 11) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.startsWith("234") && digits.length >= 13) {
    return `+234 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  if (digits.startsWith("44") && digits.length >= 12) {
    return `+44 ${digits.slice(2, 6)} ${digits.slice(6)}`;
  }

  return `+${digits}`;
}

/** Official click-to-chat URL — more reliable than wa.me in many regions. */
export function buildWhatsAppUrl(message, number = WHATSAPP_NUMBER) {
  const phone = normalizeWhatsAppNumber(number);
  if (!phone) return null;
  const text = encodeURIComponent(message || "");
  return `https://api.whatsapp.com/send?phone=${phone}${text ? `&text=${text}` : ""}`;
}

/** Opens the native WhatsApp app on phones when the browser link fails. */
export function buildWhatsAppDeepLink(message, number = WHATSAPP_NUMBER) {
  const phone = normalizeWhatsAppNumber(number);
  if (!phone) return null;
  const text = encodeURIComponent(message || "");
  return `whatsapp://send?phone=${phone}${text ? `&text=${text}` : ""}`;
}

export function isMobileWhatsAppDevice() {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "");
}

export async function copyWhatsAppNumber(number = WHATSAPP_NUMBER) {
  const display = formatWhatsAppDisplay(number);
  const digits = normalizeWhatsAppNumber(number);
  const value = display || (digits ? `+${digits}` : "");
  if (!value || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }
  await navigator.clipboard.writeText(value);
  return true;
}
