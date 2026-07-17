// Shared public-site constants — safe to import from landing page and app.

export const WHATSAPP_NUMBER = "13306717093";
export const WHATSAPP_DEFAULT_MESSAGE = "Hi, I need help getting access to InspireTech.";
export const WHATSAPP_ACCESS_REQUEST_MESSAGE =
  "Hi, I'd like to request access to InspireTech. Please send me an access token.";

export const WINDOWS_DOWNLOAD_URL =
  import.meta.env?.VITE_WINDOWS_DOWNLOAD_URL || "";

export const SITE_NAME = "InspireTech";
export const SITE_TAGLINE = "Real-time AI video transformation for live calls";
export const LOGO_SRC = `${import.meta.env.BASE_URL}logo.png`;
