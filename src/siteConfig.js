// Shared public-site constants — safe to import from landing page and app.

// Full international number, digits only (no +, spaces, or leading 0).
// Nigeria example: 2348012345678   US example: 13306717093
export const WHATSAPP_NUMBER = normalizeWhatsAppNumber(
  import.meta.env?.VITE_WHATSAPP_NUMBER || "13306717093"
);

export const WHATSAPP_DISPLAY =
  import.meta.env?.VITE_WHATSAPP_DISPLAY || formatWhatsAppDisplay(WHATSAPP_NUMBER);

export const WHATSAPP_DEFAULT_MESSAGE = "Hi, I need help getting access to InspireTech.";
export const WHATSAPP_ACCESS_REQUEST_MESSAGE =
  "Hi, I'd like to request access to InspireTech. Please send me an access token.";

export const WINDOWS_DOWNLOAD_URL =
  import.meta.env?.VITE_WINDOWS_DOWNLOAD_URL ||
  "https://github.com/Xqlusive23/aivideo/releases/download/v0.3.5/InspireTech.Setup.0.3.5.exe";

export const SITE_NAME = "InspireTech";
export const SITE_TAGLINE = "Real-time AI video transformation for live calls";
export const LOGO_SRC = `${import.meta.env.BASE_URL}logo.png`;

function normalizeWhatsAppNumber(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  // Allow env like +234 080... by dropping a trunk 0 after country code.
  if (digits.startsWith("2340")) {
    digits = `234${digits.slice(4)}`;
  }
  return digits;
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
