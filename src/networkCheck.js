export const NETWORK_QUALITY = {
  GOOD: "good",
  FAIR: "fair",
  POOR: "poor",
  UNKNOWN: "unknown",
};

// Measures RTT to our cloud billing server (often US/EU), not local fast.com speed.
// International latency of 1–4 s is normal and fine for billing heartbeats.
const LATENCY_GOOD_MS = 3000;
const LATENCY_FAIR_MS = 10000;

function readConnectionHint() {
  if (typeof navigator === "undefined") return null;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn?.effectiveType) return null;
  return { effectiveType: conn.effectiveType };
}

function scoreFromLatency(latencyMs) {
  if (!Number.isFinite(latencyMs)) return NETWORK_QUALITY.POOR;
  if (latencyMs <= LATENCY_GOOD_MS) return NETWORK_QUALITY.GOOD;
  if (latencyMs <= LATENCY_FAIR_MS) return NETWORK_QUALITY.FAIR;
  return NETWORK_QUALITY.POOR;
}

function buildMessage(level, latencyMs, hint) {
  const latencyPart = Number.isFinite(latencyMs)
    ? `${Math.round(latencyMs)} ms to billing server`
    : "billing server unreachable";
  const typePart = hint?.effectiveType ? ` · ${hint.effectiveType}` : "";
  if (level === NETWORK_QUALITY.GOOD) {
    return `Strong connection (${latencyPart}${typePart}) — ready for live transformation.`;
  }
  if (level === NETWORK_QUALITY.FAIR) {
    return `Reachable (${latencyPart}${typePart}) — billing server is distant but OK for live use.`;
  }
  if (level === NETWORK_QUALITY.POOR) {
    if (!Number.isFinite(latencyMs)) {
      return `Can't reach billing server — check internet or firewall, then retry.`;
    }
    return `Billing server very slow (${latencyPart}${typePart}) — fix connection before starting.`;
  }
  return "Checking connection…";
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Probe ledger reachability via lightweight /api/health.
 * Returns { level, latencyMs, message, checkedAt }.
 */
export async function assessNetworkQuality({ ledgerUrl, timeoutMs = 12000 } = {}) {
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

  const url = `${base}/api/health`;
  const samples = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    try {
      const res = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
      const latencyMs = performance.now() - started;
      if (res.ok || res.status < 500) {
        samples.push(latencyMs);
      }
    } catch {
      // retry once — a single dropped packet should not block Start
    } finally {
      clearTimeout(timer);
    }
  }

  const latencyMs = median(samples);
  const level = scoreFromLatency(latencyMs);

  return {
    level,
    latencyMs,
    message: buildMessage(level, latencyMs, hint),
    checkedAt: Date.now(),
  };
}

export function networkQualityLabel(level) {
  if (level === NETWORK_QUALITY.GOOD) return "Strong";
  if (level === NETWORK_QUALITY.FAIR) return "Fair";
  if (level === NETWORK_QUALITY.POOR) return "Weak";
  return "Checking…";
}
