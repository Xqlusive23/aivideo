export const LEDGER_URL =
  import.meta.env?.VITE_LEDGER_BACKEND_URL || "http://localhost:3002";

export function normalizeAccessToken(raw) {
  return String(raw || "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

export function getClientPlatform() {
  if (typeof window === "undefined") return "desktop-web";
  if (window.inspiretechCompanion?.isDesktop) return "windows-app";
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent || "")) return "mobile";
  return "desktop-web";
}

export async function checkAccessToken(token, { clientPlatform = getClientPlatform() } = {}) {
  const normalized = normalizeAccessToken(token);
  if (!normalized) {
    return { ok: false, error: "Enter your access token." };
  }

  try {
    const res = await fetch(`${LEDGER_URL}/api/access-check`, {
      headers: {
        "X-Access-Token": normalized,
        "X-Client-Platform": clientPlatform,
      },
    });

    if (res.status === 401) {
      let detail = "";
      try {
        const data = await res.json();
        detail = data?.error || "";
      } catch {
        // ignore
      }
      const suffix =
        detail === "Missing access token"
          ? " The token field was empty after trimming."
          : " This token is not registered on the live ledger server — if it was created locally, migrate it in the production admin panel.";
      return { ok: false, error: `Access token not recognized.${suffix}` };
    }

    if (res.status === 403) {
      let message = "Your access has been revoked.";
      try {
        const data = await res.json();
        if (data?.error) message = data.error;
      } catch {
        // ignore
      }
      return { ok: false, error: message };
    }

    if (!res.ok) {
      return {
        ok: false,
        error: `Can't reach the ledger backend at ${LEDGER_URL}. Is it running?`,
      };
    }

    const data = await res.json();
    return { ok: true, token: normalized, credits: data.credits };
  } catch {
    return {
      ok: false,
      error: `Can't reach the ledger backend at ${LEDGER_URL}. Is it running?`,
    };
  }
}
