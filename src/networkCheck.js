export const NETWORK_QUALITY = {
  GOOD: "good",
  FAIR: "fair",
  POOR: "poor",
  UNKNOWN: "unknown",
};

// Ledger lives on a remote cloud host — international RTT is normal and fine for
// billing heartbeats. Score from measured server round-trip, not browser guesses.
const LATENCY_GOOD_MS = 900;
const LATENCY_FAIR_MS = 2200;

function readConnectionHint() {
  if (typeof navigator === "undefined") return null;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return null;
  return {
    effectiveType: conn.effectiveType || "",
    downlinkMbps: Number.isFinite(conn.downlink) ? conn.downlink : null,
  };
}

function scoreFromBrowserHint(hint) {
  if (!hint) return null;
  const type = String(hint.effectiveType || "").toLowerCase();
  // Network Information API often mislabels desktop Wi‑Fi as "3g" — only treat
  // clearly bad link types as a downgrade signal.
  if (type === "slow-2g" || type === "2g") return NETWORK_QUALITY.POOR;
  if (hint.downlinkMbps != null && hint.downlinkMbps < 0.5) return NETWORK_QUALITY.POOR;
  return null;
}

function scoreFromLatency(latencyMs) {
  if (!Number.isFinite(latencyMs)) return NETWORK_QUALITY.UNKNOWN;
  if (latencyMs <= LATENCY_GOOD_MS) return NETWORK_QUALITY.GOOD;
  if (latencyMs <= LATENCY_FAIR_MS) return NETWORK_QUALITY.FAIR;
  return NETWORK_QUALITY.POOR;
}

function buildMessage(level, latencyMs, hint) {
  const latencyPart = Number.isFinite(latencyMs) ? `${Math.round(latencyMs)} ms to server` : "server unreachable";
  const typePart = hint?.effectiveType ? ` · ${hint.effectiveType}` : "";
  if (level === NETWORK_QUALITY.GOOD) {
    return `Strong connection (${latencyPart}${typePart}) — ready for live transformation.`;
  }
  if (level === NETWORK_QUALITY.FAIR) {
    return `Fair connection (${latencyPart}${typePart}) — live may stutter; move closer to Wi‑Fi if possible.`;
  }
  if (level === NETWORK_QUALITY.POOR) {
    return `Weak connection (${latencyPart}${typePart}) — fix network before starting to avoid failed sessions.`;
  }
  return "Checking connection…";
}

/**
 * Probe ledger reachability + optional browser Network Information API.
 * Returns { level, latencyMs, message, checkedAt }.
 */
export async function assessNetworkQuality({ ledgerUrl, headers = {}, timeoutMs = 8000 } = {}) {
  const hint = readConnectionHint();
  const base = String(ledgerUrl || "").replace(/\/$/, "");
  if (!base) {
    return {
      level: NETWORK_QUALITY.UNKNOWN,
      latencyMs: null,
      message: "Billing server URL is not configured.",
      checkedAt: Date.now(),
    };
  }

  const hasAuth = Boolean(headers["X-Access-Token"] || headers["x-access-token"]);
  const url = hasAuth ? `${base}/api/access-check` : `${base}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal, cache: "no-store" });
    const latencyMs = performance.now() - started;
    if (!res.ok && res.status !== 401) {
      return {
        level: NETWORK_QUALITY.POOR,
        latencyMs,
        message: buildMessage(NETWORK_QUALITY.POOR, latencyMs, hint),
        checkedAt: Date.now(),
      };
    }
    const latencyLevel = scoreFromLatency(latencyMs);
    const hintLevel = scoreFromBrowserHint(hint);
    // Measured server RTT is authoritative; browser hints only flag severe offline links.
    const level =
      latencyLevel === NETWORK_QUALITY.POOR || hintLevel === NETWORK_QUALITY.POOR
        ? NETWORK_QUALITY.POOR
        : latencyLevel === NETWORK_QUALITY.FAIR
          ? NETWORK_QUALITY.FAIR
          : NETWORK_QUALITY.GOOD;
    return {
      level,
      latencyMs,
      message: buildMessage(level, latencyMs, hint),
      checkedAt: Date.now(),
    };
  } catch {
    return {
      level: NETWORK_QUALITY.POOR,
      latencyMs: null,
      message: buildMessage(NETWORK_QUALITY.POOR, null, hint),
      checkedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function networkQualityLabel(level) {
  if (level === NETWORK_QUALITY.GOOD) return "Strong";
  if (level === NETWORK_QUALITY.FAIR) return "Fair";
  if (level === NETWORK_QUALITY.POOR) return "Weak";
  return "Checking…";
}
