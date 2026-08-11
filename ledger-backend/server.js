// server.js — the real credit ledger, with per-user (per-token) accounts.
//
// Model: there's no signup form. YOU (the admin) mint an access token for a
// customer via a protected admin endpoint, hand it to them (however you like
// — email, WhatsApp, whatever), and they paste it into the app once. From
// then on, every request they make includes that token, and it's what scopes
// their balance, purchases, and usage — completely separate from anyone
// else's token.
//
// A small browser-based admin page lives at /admin.html (see ./public) so
// you don't have to run curl/PowerShell by hand — open it in your browser,
// paste your ADMIN_SECRET, and mint/view tokens from there.
//
// Run with: node server.js   (after `npm install` + setting up .env)

import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "crypto";
import { createDecartClient } from "@decartai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3002;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const ALLOWED_ORIGINS = new Set(
  [
    FRONTEND_URL,
    "https://www.inspirestream.xyz",
    "https://inspirestream.xyz",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ].filter(Boolean)
);
const CREDITS_PER_SECOND = Number(process.env.CREDITS_PER_SECOND || 2);
// Decart API cost per second — keep in sync with src/pricing.js DECART_CREDITS_PER_SECOND.
// 500 credits = 3 min (180 s); ~39% margin vs Decart at 2/sec — keeps API cost below user credits.
const LIVE_SECONDS_PER_500_CREDITS = Math.min(
  300,
  Math.max(120, Number(process.env.LIVE_SECONDS_PER_500_CREDITS || 180))
);
// Always derive from the 500-credit anchor — a stale BILLING_MULTIPLIER env (e.g. 5 → 10 credits/s) caused overbilling.
const BILLING_MULTIPLIER = 500 / LIVE_SECONDS_PER_500_CREDITS / CREDITS_PER_SECOND;
if (process.env.BILLING_MULTIPLIER) {
  const envMultiplier = Number(process.env.BILLING_MULTIPLIER);
  if (Number.isFinite(envMultiplier) && Math.abs(envMultiplier - BILLING_MULTIPLIER) > 0.05) {
    console.warn(
      `⚠️  Ignoring BILLING_MULTIPLIER=${process.env.BILLING_MULTIPLIER} — using anchor value ${BILLING_MULTIPLIER.toFixed(3)} (${(CREDITS_PER_SECOND * BILLING_MULTIPLIER).toFixed(2)} credits/s)`
    );
  }
}
const PRESENCE_ACTIVE_SECONDS = 90; // admin "online now" window
const FLUTTERWAVE_SECRET_KEY = (process.env.FLUTTERWAVE_SECRET_KEY || "").trim();
const FLUTTERWAVE_WEBHOOK_HASH = (process.env.FLUTTERWAVE_WEBHOOK_HASH || "").trim();
const CHECKOUT_CURRENCY = String(process.env.FLUTTERWAVE_CURRENCY || "NGN").trim().toUpperCase();
const NAIRA_PER_DOLLAR = Number(process.env.NAIRA_PER_USD || 1600);
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const DECART_API_KEY = (process.env.DECART_API_KEY || "").trim();

if (!DECART_API_KEY) {
  console.warn("\n⚠️  DECART_API_KEY is not set — live transformation tokens cannot be minted until you add it to .env\n");
}

function normalizeDecartOrigin(origin) {
  const raw = String(origin || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const isDefaultPort =
      (url.protocol === "https:" && (url.port === "" || url.port === "443")) ||
      (url.protocol === "http:" && (url.port === "" || url.port === "80"));
    if (isDefaultPort) return `${url.protocol}//${host}`;
    return `${url.protocol}//${host}:${url.port}`;
  } catch {
    return null;
  }
}

function decartAllowedOrigins() {
  return [
    ...new Set(
      [
        "https://www.inspirestream.xyz",
        "https://inspirestream.xyz",
        FRONTEND_URL,
        "http://localhost:5173",
        "http://127.0.0.1:5173",
      ]
        .map(normalizeDecartOrigin)
        .filter(Boolean)
    ),
  ];
}

function decartMintErrorResponse(err) {
  const message = String(err?.message || err || "");
  const statusMatch = message.match(/Failed to create token: (\d+)/);
  const status = statusMatch ? Number(statusMatch[1]) : 500;
  console.error("Decart token mint failed:", message);

  if (status === 401 || status === 403) {
    return {
      status: 503,
      error:
        "Decart API key is invalid or expired. Generate a new key at decart.ai and set DECART_API_KEY in ledger-backend/.env (then restart the backend).",
    };
  }
  if (status === 402 || /insufficient|balance|credit/i.test(message)) {
    return { status: 503, error: "Decart provider account is out of credits." };
  }
  if (status === 400) {
    return {
      status: 500,
      error: "Decart rejected token options. Check FRONTEND_URL and allowedOrigins on the server.",
    };
  }
  return { status: 500, error: "Could not create Decart session token." };
}

// --- Voice changer (ElevenLabs Speech-to-Speech / Voice Changer API) --------
// This converts recorded audio into a different voice while preserving the
// original words, timing, and delivery — NOT a conversational agent, and NOT
// the same thing as Inworld's Realtime API (which generates new LLM speech).
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_STS_MODEL_ID = process.env.ELEVENLABS_STS_MODEL_ID || "eleven_english_sts_v2";
if (!ELEVENLABS_API_KEY) {
  console.warn("\n⚠️  ELEVENLABS_API_KEY is not set — the voice changer will fail until you add it to .env\n");
}

// --- Real-time voice conversion (voice-rt-server on RunPod) -----------------
// A separate GPU-backed service (see /voice-rt-server) that does continuous
// streaming voice conversion instead of the chunk-based ElevenLabs flow
// above. This backend doesn't proxy that audio at all — it only mints a
// short-lived, signed ticket that lets the browser connect DIRECTLY to
// voice-rt-server's WebSocket (lower latency than relaying audio through
// an extra hop). RTC_TICKET_SECRET must be the exact same value set on the
// voice-rt-server pod's own environment variables.
const RTC_TICKET_SECRET = process.env.RTC_TICKET_SECRET || "";
const RTC_TICKET_TTL_SECONDS = 60; // short-lived on purpose — just long enough to connect
const VOICE_RT_URL = (process.env.VOICE_RT_URL || "").replace(/\/$/, "");
if (!RTC_TICKET_SECRET) {
  console.warn("\n⚠️  RTC_TICKET_SECRET is not set — the real-time voice server integration will fail until you add it to .env\n");
}
if (!VOICE_RT_URL) {
  console.warn("\n⚠️  VOICE_RT_URL is not set — add your RunPod voice-rt-server URL to ledger-backend/.env\n");
}

function mintRtcTicket(token) {
  const payload = { token: token.slice(0, 16), exp: Math.floor(Date.now() / 1000) + RTC_TICKET_TTL_SECONDS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", RTC_TICKET_SECRET).update(payloadB64).digest("hex");
  return `${payloadB64}.${signature}`;
}
// Audio chunks arrive as multipart file uploads — kept in memory only
// (never written to disk) since they're small (~2.5s clips) and immediately
// forwarded to ElevenLabs, not stored.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

if (!FLUTTERWAVE_SECRET_KEY) {
  console.warn(
    "\n⚠️  FLUTTERWAVE_SECRET_KEY is not set — checkout will fail until you add it to .env\n"
  );
}
if (!ADMIN_SECRET) {
  console.warn("⚠️  ADMIN_SECRET is not set — anyone could mint themselves a token. Set this before deploying.\n");
}

const app = express();

// Serves ./public/admin.html at http://localhost:3002/admin.html (and on
// whatever your deployed backend URL is, e.g. https://your-app.up.railway.app/admin.html).
// This is separate from your public React app's bundle — the admin secret
// is typed in by hand on this page, never baked into any shipped JS.
app.use(express.static(path.join(__dirname, "public")));

// --- Database setup -------------------------------------------------------
// Uses Node's built-in SQLite (node:sqlite) — requires Node 22.5+, no native
// compilation needed.
const DB_PATH = process.env.DB_PATH || "ledger.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    token TEXT PRIMARY KEY,
    label TEXT,
    credits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    type TEXT NOT NULL,             -- 'purchase' | 'usage'
    credits INTEGER NOT NULL,       -- positive for purchase, negative for usage
    amount_ngn REAL,
    provider_reference TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS usage_sessions (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    ended_at TEXT,
    credits_used INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS client_presence (
    token TEXT NOT NULL,
    client_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    user_agent TEXT,
    last_seen_at TEXT NOT NULL,
    is_transforming INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    PRIMARY KEY (token, client_id)
  );
`);

// Self-healing guard: if this DB_PATH previously belonged to an OLDER
// version of this backend (single shared balance, or the email/password
// design — both used different column names), CREATE TABLE IF NOT EXISTS
// above silently does nothing to those pre-existing tables, and every insert
// then crashes with "no column named token" the moment it's used. Rather
// than fail at request time, patch any missing `token` column in at boot.
// This does NOT fix an incompatible `users` table (different primary key
// entirely) — if that's the case, point DB_PATH at a new filename instead.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some((c) => c.name === column);
  if (!exists) {
    console.warn(`⚠️  ${table} table was missing column "${column}" — this DB file is from an older version. Adding it now.`);
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
try {
  ensureColumn("transactions", "token", "TEXT DEFAULT ''");
  ensureColumn("usage_sessions", "token", "TEXT DEFAULT ''");
  ensureColumn("usage_sessions", "client_platform", "TEXT DEFAULT ''");
  ensureColumn("usage_sessions", "client_id", "TEXT DEFAULT ''");
  ensureColumn("usage_sessions", "last_decart_seconds", "REAL NOT NULL DEFAULT 0");
  // Lets you cut off a customer's access without deleting their history —
  // a revoked token keeps its balance/transactions on record, it just can't
  // be used to start sessions, buy credits, or check balance anymore.
  ensureColumn("users", "revoked", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "revoked_mobile", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "revoked_desktop", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "customer_email", "TEXT");
  ensureColumn("users", "customer_phone", "TEXT");
  // Trial accounts can transform with starter credits but cannot self-serve checkout
  // until an admin unlocks purchase (after they contact you for a real plan).
  ensureColumn("users", "is_trial", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "allow_purchase", "INTEGER NOT NULL DEFAULT 1");
} catch (err) {
  console.error("Schema self-heal failed — this DB file is likely from an incompatible older version.");
  console.error("Fix: set DB_PATH to a new filename (e.g. /data/ledger_v2.db) and redeploy.");
  console.error(err.message);
  process.exit(1);
}

function normalizeAccessToken(raw) {
  return String(raw || "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function getUser(token) {
  const normalized = normalizeAccessToken(token);
  if (!normalized) return undefined;
  return db.prepare("SELECT * FROM users WHERE token = ?").get(normalized);
}

const GENERIC_CHECKOUT_EMAILS = new Set([
  "customer@example.com",
  "test@example.com",
  "noreply@example.com",
]);

function normalizeCustomerEmail(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function isValidCustomerEmail(email) {
  if (!email || GENERIC_CHECKOUT_EMAILS.has(email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeCustomerPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}

function saveCustomerContact(token, email, phone) {
  const normalizedEmail = normalizeCustomerEmail(email);
  const normalizedPhone = normalizeCustomerPhone(phone);
  if (!isValidCustomerEmail(normalizedEmail)) return false;
  db.prepare("UPDATE users SET customer_email = ?, customer_phone = ? WHERE token = ?").run(
    normalizedEmail,
    normalizedPhone || null,
    token
  );
  return true;
}

function getBalance(token) {
  const user = getUser(token);
  return user ? user.credits : 0;
}

const VOICE_MIN_PURCHASE_CREDITS = 1000;
const BACKGROUND_MIN_PURCHASE_CREDITS = 2000;
const TRIAL_CREDITS = 200;
/** Lucy-style hard cap — Decart kills the WebRTC session even if credits glitch. */
const TRIAL_MAX_SESSION_SECONDS = 60;

function userAllowsPurchase(userOrToken) {
  const user = typeof userOrToken === "string" ? getUser(userOrToken) : userOrToken;
  if (!user) return false;
  // Missing column on very old rows is treated as allowed (DEFAULT 1).
  return Number(user.allow_purchase ?? 1) !== 0;
}

function userIsTrial(userOrToken) {
  const user = typeof userOrToken === "string" ? getUser(userOrToken) : userOrToken;
  return Boolean(user && Number(user.is_trial) === 1);
}

function getMaxPurchaseCredits(token) {
  const row = db
    .prepare(
      "SELECT MAX(credits) AS maxCredits FROM transactions WHERE token = ? AND type = 'purchase' AND credits > 0"
    )
    .get(token);
  return Number(row?.maxCredits || 0);
}

function hasVoiceChangerAccess(token) {
  return getMaxPurchaseCredits(token) >= VOICE_MIN_PURCHASE_CREDITS;
}

function hasBackgroundChangerAccess(token) {
  return getMaxPurchaseCredits(token) >= BACKGROUND_MIN_PURCHASE_CREDITS;
}

function tierPayload(token) {
  const maxPurchaseCredits = getMaxPurchaseCredits(token);
  const voiceChanger = maxPurchaseCredits >= VOICE_MIN_PURCHASE_CREDITS;
  const backgroundChanger = maxPurchaseCredits >= BACKGROUND_MIN_PURCHASE_CREDITS;
  const user = getUser(token);
  const allowPurchase = userAllowsPurchase(user);
  const isTrial = userIsTrial(user);
  return {
    maxPurchaseCredits,
    voiceChanger,
    backgroundChanger,
    voiceMinPurchaseCredits: VOICE_MIN_PURCHASE_CREDITS,
    backgroundMinPurchaseCredits: BACKGROUND_MIN_PURCHASE_CREDITS,
    // Legacy field — voice tier only (frontend versions before split).
    premiumFeatures: voiceChanger,
    premiumMinPurchaseCredits: VOICE_MIN_PURCHASE_CREDITS,
    isTrial,
    allowPurchase,
    trialCredits: TRIAL_CREDITS,
  };
}

function adjustBalance(token, delta) {
  const current = getBalance(token);
  const next = Math.max(0, current + delta);
  db.prepare("UPDATE users SET credits = ? WHERE token = ?").run(next, token);
  return next;
}

function effectiveCreditsPerSecond() {
  return CREDITS_PER_SECOND * BILLING_MULTIPLIER;
}

function creditsOwedForTotalElapsed(totalElapsedSeconds) {
  return Math.round(Math.max(0, totalElapsedSeconds) * effectiveCreditsPerSecond());
}

// Bill only wall-clock time since the last heartbeat. Decart generation seconds are
// tracked for client sync guards — using max(wall, decartDelta) overbilled when Decart's
// tick counter runs faster than real time (users saw ~10 credits/s instead of ~3).
const HEARTBEAT_MAX_CATCHUP_SECONDS = 10;
/** Intentional /end may miss a couple of ticks; never bill more than this gap. */
const SESSION_END_MAX_CATCHUP_SECONDS = 30;
/**
 * Orphaned sessions closed on the next /sessions/start must NOT bill wall-clock from
 * last heartbeat → now (that wiped balances when users restarted after a failed /end).
 */
const ORPHAN_SESSION_MAX_CATCHUP_SECONDS = 15;

function billableSecondsForTick(
  session,
  asOf = new Date(),
  { maxCatchUpSeconds = HEARTBEAT_MAX_CATCHUP_SECONDS, decartGenerationSeconds = null } = {}
) {
  const lastBeat = new Date(session.last_heartbeat_at || session.started_at);
  const wallSeconds = Math.max(0, (asOf - lastBeat) / 1000);
  const lastDecart = Number(session.last_decart_seconds || 0);
  let rawSeconds = wallSeconds;
  let nextDecartSeconds = lastDecart;

  if (Number.isFinite(decartGenerationSeconds) && decartGenerationSeconds >= 0) {
    if (decartGenerationSeconds + 0.001 < lastDecart) {
      // Decart counter reset after reconnect — realign baseline; wall clock covers this tick.
      nextDecartSeconds = decartGenerationSeconds;
    } else {
      nextDecartSeconds = decartGenerationSeconds;
    }
  }

  const billableSeconds =
    maxCatchUpSeconds === Infinity ? rawSeconds : Math.min(rawSeconds, maxCatchUpSeconds);
  return { billableSeconds, nextDecartSeconds };
}

function creditsToBillSinceLastHeartbeat(session, asOf = new Date(), options = {}) {
  const { billableSeconds } = billableSecondsForTick(session, asOf, options);
  return creditsOwedForTotalElapsed(billableSeconds);
}

function sessionLiveMetrics(session, asOf = new Date()) {
  const started = new Date(session.started_at);
  const endInstant = session.ended_at ? new Date(session.ended_at) : asOf;
  const elapsedSeconds = Math.max(0, Math.floor((endInstant - started) / 1000));
  const pending = session.ended_at
    ? 0
    : creditsToBillSinceLastHeartbeat(session, asOf, {
        maxCatchUpSeconds: SESSION_END_MAX_CATCHUP_SECONDS,
      });
  const creditsUsed = Number(session.credits_used || 0) + pending;
  return { elapsedSeconds, creditsUsed };
}

function sessionMetricsForDevice(device, liveByClientKey, asOf = new Date()) {
  const clientKey = device.client_id ? `${device.token}::${device.client_id}` : null;
  const live = clientKey ? liveByClientKey.get(clientKey) : null;
  if (live) {
    return { ...sessionLiveMetrics(live, asOf), isLive: true, sessionId: live.id };
  }
  if (device.session_id && !device.is_transforming) {
    const ended = db
      .prepare("SELECT * FROM usage_sessions WHERE id = ? AND token = ?")
      .get(device.session_id, device.token);
    if (ended?.ended_at) {
      return { ...sessionLiveMetrics(ended, asOf), isLive: false, sessionId: ended.id };
    }
  }
  return null;
}

function applySessionBilling(
  sessionId,
  token,
  asOf = new Date(),
  { endSession = false, maxCatchUpSeconds, decartGenerationSeconds = null } = {}
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const session = db
      .prepare("SELECT * FROM usage_sessions WHERE id = ? AND token = ?")
      .get(sessionId, token);
    if (!session) {
      db.exec("ROLLBACK");
      return null;
    }
    if (session.ended_at) {
      db.exec("ROLLBACK");
      return { credits: getBalance(token), alreadyEnded: true, creditsToDeduct: 0, depleted: getBalance(token) <= 0 };
    }

    const catchUp =
      maxCatchUpSeconds ??
      (endSession ? SESSION_END_MAX_CATCHUP_SECONDS : HEARTBEAT_MAX_CATCHUP_SECONDS);
    const { billableSeconds, nextDecartSeconds } = billableSecondsForTick(session, asOf, {
      maxCatchUpSeconds: catchUp,
      decartGenerationSeconds,
    });
    const creditsToDeduct = creditsOwedForTotalElapsed(billableSeconds);
    const remaining = adjustBalance(token, -creditsToDeduct);
    if (creditsToDeduct > 0) {
      recordTransaction({ token, type: "usage", credits: -creditsToDeduct });
    }

    if (endSession) {
      db.prepare(
        "UPDATE usage_sessions SET ended_at = ?, last_heartbeat_at = ?, last_decart_seconds = ?, credits_used = credits_used + ? WHERE id = ?"
      ).run(asOf.toISOString(), asOf.toISOString(), nextDecartSeconds, creditsToDeduct, sessionId);
    } else {
      db.prepare(
        "UPDATE usage_sessions SET last_heartbeat_at = ?, last_decart_seconds = ?, credits_used = credits_used + ? WHERE id = ?"
      ).run(asOf.toISOString(), nextDecartSeconds, creditsToDeduct, sessionId);
    }

    db.exec("COMMIT");
    return { credits: remaining, creditsToDeduct, depleted: remaining <= 0 };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function maxLiveSecondsForCredits(credits) {
  return Math.floor(Math.max(0, credits) / effectiveCreditsPerSecond());
}

function billingPayload() {
  return {
    creditsPerSecond: CREDITS_PER_SECOND,
    billingMultiplier: BILLING_MULTIPLIER,
    billingCreditsPerSecond: effectiveCreditsPerSecond(),
  };
}

function recordTransaction({ token, type, credits, amount_ngn = null, provider_reference = null }) {
  db.prepare(
    "INSERT INTO transactions (token, type, credits, amount_ngn, provider_reference) VALUES (?, ?, ?, ?, ?)"
  ).run(token, type, credits, amount_ngn, provider_reference);
}

function hasProcessedReference(reference) {
  const row = db
    .prepare("SELECT id FROM transactions WHERE provider_reference = ?")
    .get(reference);
  return Boolean(row);
}

// Credits a successful Flutterwave transaction exactly once. The token being
// credited comes from the metadata attached at checkout time, NOT from
// whoever happens to be calling this — that's what makes it safe to call
// from both the webhook and the verify-on-return endpoint.
function creditFromFlutterwaveTransaction(data) {
  const reference = data.tx_ref;
  const meta = data.meta || {};
  const token = meta.token || meta.access_token;
  const user = token ? getUser(token) : null;

  if (!user) {
    console.error(`Webhook/verify for unknown or missing token, reference ${reference}`);
    return { credits: 0, alreadyProcessed: false, error: "Unknown access token" };
  }
  if (user.revoked) {
    console.error(`Webhook/verify for a REVOKED token, reference ${reference} — not crediting.`);
    return { credits: getBalance(token), alreadyProcessed: false, error: "This access token has been revoked" };
  }
  if (!userAllowsPurchase(user)) {
    console.error(
      `Webhook/verify for trial/locked token ${token.slice(0, 8)}... ref ${reference} — purchase not allowed.`
    );
    return {
      credits: getBalance(token),
      alreadyProcessed: false,
      error: "Self-serve purchase is locked on this account. Contact admin to unlock billing.",
      ...tierPayload(token),
    };
  }
  if (hasProcessedReference(reference)) {
    return { credits: getBalance(token), alreadyProcessed: true, ...tierPayload(token) };
  }

  const credits = Number(meta.credits || 0);
  const chargedAmount = Number(data.amount || data.charged_amount || 0);
  const currency = String(data.currency || CHECKOUT_CURRENCY).toUpperCase();
  const amountNgn =
    currency === "NGN"
      ? chargedAmount
      : currency === "USD"
        ? chargedAmount * NAIRA_PER_DOLLAR
        : null;
  if (credits > 0) {
    const newBalance = adjustBalance(token, credits);
    recordTransaction({ token, type: "purchase", credits, amount_ngn: amountNgn, provider_reference: reference });
    console.log(
      `✅ Credited ${credits} credits (balance now ${newBalance}) for token ${token.slice(0, 8)}... ref ${reference}`
    );
  }
  return { credits: getBalance(token), alreadyProcessed: false, ...tierPayload(token) };
}

async function verifyFlutterwaveTransaction({ txRef, transactionId }) {
  const headers = {
    Authorization: `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
  let verifyRes;
  if (transactionId) {
    verifyRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, { headers });
  } else if (txRef) {
    verifyRes = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`,
      { headers }
    );
  } else {
    throw new Error("Missing transaction reference");
  }
  const payload = await verifyRes.json();
  if (payload.status !== "success" || !payload.data) {
    throw new Error(payload.message || "Flutterwave verification failed");
  }
  if (payload.data.status !== "successful") {
    throw new Error("Payment not verified as successful");
  }
  return payload.data;
}

// --- Middleware -------------------------------------------------------------
// Allow the deployed website and Electron desktop (file:// sends Origin: null).
app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === "null" || ALLOWED_ORIGINS.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
}));

// Flutterwave webhooks need the RAW body; register before express.json().
app.post("/api/webhooks/flutterwave", express.raw({ type: "application/json" }), async (req, res) => {
  if (FLUTTERWAVE_WEBHOOK_HASH) {
    const signature = req.headers["verif-hash"];
    if (!signature || signature !== FLUTTERWAVE_WEBHOOK_HASH) {
      console.error("Flutterwave webhook signature verification failed");
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  try {
    const event = JSON.parse(req.body.toString("utf8"));
    const eventType = String(event.event || event.type || "").toLowerCase();
    if (eventType.includes("charge") && event.data?.status === "successful") {
      const verified = await verifyFlutterwaveTransaction({
        txRef: event.data.tx_ref,
        transactionId: event.data.id,
      });
      creditFromFlutterwaveTransaction(verified);
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Flutterwave webhook error:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

app.use(express.json());

function normalizePlatformScope(platform) {
  if (platform === "mobile") return "mobile";
  if (platform === "desktop-web" || platform === "windows-app") return "desktop";
  return null;
}

function readClientPlatform(req) {
  const explicit = req.headers["x-client-platform"] || req.body?.platform || null;
  if (explicit) return explicit;

  const ua = req.headers["user-agent"] || "";
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return "mobile";
  if (/Electron/i.test(ua)) return "windows-app";
  if (ua) return "desktop-web";
  return null;
}

function isPlatformRevoked(user, scope) {
  if (!user) return true;
  if (Number(user.revoked) === 1) return true;
  if (scope === "mobile") return Number(user.revoked_mobile) === 1;
  if (scope === "desktop") return Number(user.revoked_desktop) === 1;
  return false;
}

function resolvePlatformScope(req) {
  const clientPlatform = readClientPlatform(req);
  return normalizePlatformScope(clientPlatform) || "desktop";
}

function platformRevokeMessage(scope) {
  if (scope === "mobile") {
    return "This access token has been revoked on mobile devices.";
  }
  if (scope === "desktop") {
    return "This access token has been revoked on desktop web and the Windows app.";
  }
  return "This access token has been revoked.";
}

// Every user-facing route (except the webhook, verify, and admin routes)
// requires a valid access token in the X-Access-Token header.
function requireToken(req, res, next) {
  const token = normalizeAccessToken(req.headers["x-access-token"]);
  if (!token) return res.status(401).json({ error: "Missing access token" });
  const user = getUser(token);
  if (!user) return res.status(401).json({ error: "Invalid access token" });

  const clientPlatform = readClientPlatform(req);
  const platformScope = resolvePlatformScope(req);
  req.clientPlatform = clientPlatform;
  req.clientPlatformScope = platformScope;

  if (Number(user.revoked) === 1) {
    return res.status(403).json({ error: "This access token has been revoked", scope: "all" });
  }
  if (isPlatformRevoked(user, platformScope)) {
    return res.status(403).json({
      error: platformRevokeMessage(platformScope),
      scope: platformScope,
    });
  }

  req.token = token;
  req.user = user;
  next();
}

function requireVoiceChangerAccess(req, res, next) {
  if (hasVoiceChangerAccess(req.token)) return next();
  return res.status(403).json({
    error: `Voice changer requires a plan of at least ${VOICE_MIN_PURCHASE_CREDITS} credits. Upgrade in Credits.`,
    ...tierPayload(req.token),
  });
}

// --- Admin: mint access tokens ------------------------------------------------
// Easiest way to call these: open /admin.html in your browser (see ./public).
// You can still call them directly if you prefer:
//
//   curl -X POST https://your-backend/api/admin/tokens \
//     -H "X-Admin-Secret: <your ADMIN_SECRET>" \
//     -H "Content-Type: application/json" \
//     -d '{"label": "customer name or note"}'
//
app.post("/api/admin/tokens", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { label, token: requestedToken, credits: startingCredits, trial } = req.body || {};
  const isTrial = Boolean(trial);

  // Normally omitted — a fresh random token is minted. Passing an explicit
  // `token` is for MIGRATION: recreating a specific user's exact existing
  // token (e.g. one they already have saved in their browser from an old
  // deployment) on a new/different database, optionally with their prior
  // balance carried over via `credits`.
  const token = requestedToken || randomUUID();
  if (getUser(token)) {
    return res.status(409).json({ error: "That token already exists" });
  }

  let initialCredits = Number.isFinite(Number(startingCredits)) ? Math.max(0, Number(startingCredits)) : 0;
  let allowPurchase = 1;
  let trialFlag = 0;
  let resolvedLabel = label || null;

  if (isTrial) {
    initialCredits = Number.isFinite(Number(startingCredits)) && Number(startingCredits) > 0
      ? Math.max(0, Number(startingCredits))
      : TRIAL_CREDITS;
    allowPurchase = 0;
    trialFlag = 1;
    resolvedLabel = resolvedLabel
      ? (String(resolvedLabel).toLowerCase().startsWith("trial") ? resolvedLabel : `trial: ${resolvedLabel}`)
      : "trial";
  }

  db.prepare(
    "INSERT INTO users (token, label, credits, is_trial, allow_purchase) VALUES (?, ?, ?, ?, ?)"
  ).run(token, resolvedLabel, initialCredits, trialFlag, allowPurchase);

  if (initialCredits > 0) {
    recordTransaction({
      token,
      type: isTrial ? "trial" : "purchase",
      credits: initialCredits,
      amount_ngn: null,
      provider_reference: isTrial ? "trial_grant" : "manual_migration",
    });
  }
  res.json({
    token,
    label: resolvedLabel,
    credits: initialCredits,
    isTrial: Boolean(trialFlag),
    allowPurchase: Boolean(allowPurchase),
  });
});

// Unlock (or re-lock) Flutterwave self-serve checkout for a token.
// After a trial, keep purchase locked until the customer contacts you and you unlock.
app.post("/api/admin/tokens/:token/purchase-access", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { token } = req.params;
  const user = getUser(token);
  if (!user) return res.status(404).json({ error: "Unknown token" });

  const allow = req.body?.allow !== false && req.body?.allow !== 0 && req.body?.mode !== "lock";
  db.prepare("UPDATE users SET allow_purchase = ?, is_trial = ? WHERE token = ?").run(
    allow ? 1 : 0,
    allow ? 0 : Number(user.is_trial) || 0,
    token
  );
  const updated = getUser(token);
  res.json({
    token,
    allowPurchase: userAllowsPurchase(updated),
    isTrial: userIsTrial(updated),
    credits: getBalance(token),
  });
});

// Manually add (or remove, with a negative delta) credits on an existing
// token — for migrations, comps, refunds, or correcting a mistake. This
// bypasses Flutterwave entirely, so it's protected the same way as the other
// admin routes: your ADMIN_SECRET, never exposed to customers.
app.post("/api/admin/tokens/:token/adjust-credits", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { token } = req.params;
  const { delta, note } = req.body || {};
  const deltaNum = Number(delta);
  if (!getUser(token)) return res.status(404).json({ error: "Unknown token" });
  if (!Number.isFinite(deltaNum) || deltaNum === 0) {
    return res.status(400).json({ error: "Provide a non-zero numeric 'delta'" });
  }

  const remaining = adjustBalance(token, deltaNum);
  recordTransaction({
    token,
    type: deltaNum > 0 ? "purchase" : "usage",
    credits: deltaNum,
    amount_ngn: null,
    provider_reference: note ? `manual:${note}` : "manual_adjustment",
  });
  res.json({ token, credits: remaining });
});

app.get("/api/admin/users", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const rows = db
    .prepare(
      "SELECT token, label, credits, revoked, revoked_mobile, revoked_desktop, is_trial, allow_purchase, created_at FROM users ORDER BY created_at DESC"
    )
    .all();
  res.json({ users: rows });
});

// Shows every device currently online (mobile browser, desktop browser, Windows
// app) plus anyone actively running a transformation session.
app.get("/api/admin/active-users", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const cutoff = new Date(Date.now() - PRESENCE_ACTIVE_SECONDS * 1000).toISOString();

  const devices = db
    .prepare(
      `SELECT p.token, p.client_id, p.platform, p.user_agent, p.last_seen_at,
              p.is_transforming, p.session_id, u.label, u.revoked, u.revoked_mobile,
              u.revoked_desktop, u.credits
       FROM client_presence p
       JOIN users u ON u.token = p.token
       WHERE p.last_seen_at >= ?
       ORDER BY p.last_seen_at DESC`
    )
    .all(cutoff);

  const liveSessionRows = db
    .prepare(
      `SELECT s.id, s.token, s.started_at, s.last_heartbeat_at, s.credits_used, s.client_platform, s.client_id,
              u.label, u.revoked, u.revoked_mobile, u.revoked_desktop, u.credits
       FROM usage_sessions s
       JOIN users u ON u.token = s.token
       WHERE s.ended_at IS NULL AND s.last_heartbeat_at >= ?
       ORDER BY s.last_heartbeat_at DESC`
    )
    .all(cutoff);

  const now = new Date();
  const liveByClientKey = new Map();
  for (const session of liveSessionRows) {
    if (session.client_id) {
      liveByClientKey.set(`${session.token}::${session.client_id}`, session);
    }
  }

  const liveSessions = liveSessionRows.map((session) => ({
    ...session,
    ...sessionLiveMetrics(session, now),
    isLive: true,
  }));

  const devicesWithMetrics = devices.map((device) => ({
    ...device,
    sessionMetrics: sessionMetricsForDevice(device, liveByClientKey, now),
  }));

  res.json({
    activeWindowSeconds: PRESENCE_ACTIVE_SECONDS,
    creditsPerSecond: effectiveCreditsPerSecond(),
    devices: devicesWithMetrics,
    liveSessions,
  });
});

// Cuts off a customer's access on every device without deleting anything.
app.post("/api/admin/tokens/:token/revoke", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { token } = req.params;
  if (!getUser(token)) return res.status(404).json({ error: "Unknown token" });
  setAllAccessRevoked(token, true);
  res.json({ token, revoked: true, scope: "all" });
});

app.post("/api/admin/tokens/:token/restore", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { token } = req.params;
  if (!getUser(token)) return res.status(404).json({ error: "Unknown token" });
  setAllAccessRevoked(token, false);
  res.json({ token, revoked: false, scope: "all" });
});

function setAllAccessRevoked(token, revoked) {
  const flag = revoked ? 1 : 0;
  db.prepare("UPDATE users SET revoked = ?, revoked_mobile = ?, revoked_desktop = ? WHERE token = ?").run(
    flag,
    flag,
    flag,
    token
  );
}

function setPlatformRevoked(token, scope, revoked) {
  const column = scope === "mobile" ? "revoked_mobile" : "revoked_desktop";
  db.prepare(`UPDATE users SET ${column} = ? WHERE token = ?`).run(revoked ? 1 : 0, token);
}

app.post("/api/admin/tokens/:token/revoke-mobile", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { token } = req.params;
  if (!getUser(token)) return res.status(404).json({ error: "Unknown token" });
  setPlatformRevoked(token, "mobile", true);
  res.json({ token, revoked_mobile: true, scope: "mobile" });
});

app.post("/api/admin/tokens/:token/restore-mobile", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { token } = req.params;
  if (!getUser(token)) return res.status(404).json({ error: "Unknown token" });
  setPlatformRevoked(token, "mobile", false);
  res.json({ token, revoked_mobile: false, scope: "mobile" });
});

app.post("/api/admin/tokens/:token/revoke-desktop", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { token } = req.params;
  if (!getUser(token)) return res.status(404).json({ error: "Unknown token" });
  setPlatformRevoked(token, "desktop", true);
  res.json({ token, revoked_desktop: true, scope: "desktop" });
});

app.post("/api/admin/tokens/:token/restore-desktop", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { token } = req.params;
  if (!getUser(token)) return res.status(404).json({ error: "Unknown token" });
  setPlatformRevoked(token, "desktop", false);
  res.json({ token, revoked_desktop: false, scope: "desktop" });
});

// Unified platform access control — preferred by the admin UI.
app.post("/api/admin/tokens/:token/platform-access", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { token } = req.params;
  const { scope, action } = req.body || {};
  if (!getUser(token)) return res.status(404).json({ error: "Unknown token" });

  const validScopes = new Set(["mobile", "desktop", "all"]);
  const validActions = new Set(["revoke", "restore"]);
  if (!validScopes.has(scope) || !validActions.has(action)) {
    return res.status(400).json({ error: "Provide scope (mobile|desktop|all) and action (revoke|restore)" });
  }

  const revoke = action === "revoke";
  if (scope === "all") {
    setAllAccessRevoked(token, revoke);
    return res.json({
      token,
      revoked: revoke,
      revoked_mobile: revoke,
      revoked_desktop: revoke,
      scope: "all",
    });
  }

  setPlatformRevoked(token, scope, revoke);
  const user = getUser(token);
  return res.json({
    token,
    scope,
    revoked: Number(user.revoked) === 1,
    revoked_mobile: Number(user.revoked_mobile) === 1,
    revoked_desktop: Number(user.revoked_desktop) === 1,
  });
});

// Permanently removes a token and all associated ledger rows. Unlike revoke,
// this cannot be undone — use when a customer should no longer exist in the DB.
app.delete("/api/admin/tokens/:token", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { token } = req.params;
  if (!getUser(token)) return res.status(404).json({ error: "Unknown token" });

  const deleteUser = db.prepare("DELETE FROM users WHERE token = ?");
  const deleteTransactions = db.prepare("DELETE FROM transactions WHERE token = ?");
  const deleteSessions = db.prepare("DELETE FROM usage_sessions WHERE token = ?");
  const deletePresence = db.prepare("DELETE FROM client_presence WHERE token = ?");

  db.exec("BEGIN");
  try {
    deleteSessions.run(token);
    deletePresence.run(token);
    deleteTransactions.run(token);
    deleteUser.run(token);
    db.exec("COMMIT");
    res.json({ token, deleted: true });
  } catch (err) {
    db.exec("ROLLBACK");
    console.error("Failed to delete token:", err);
    res.status(500).json({ error: "Could not delete token" });
  }
});

// Lightweight access check for frequent client polling (revoke detection).
// Lightweight ping for client network checks (no auth).
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/access-check", requireToken, (req, res) => {
  const user = getUser(req.token);
  res.json({
    ok: true,
    scope: req.clientPlatformScope,
    platform: req.clientPlatform,
    credits: getBalance(req.token),
    customerEmail: user?.customer_email || null,
    customerPhone: user?.customer_phone || null,
    ...tierPayload(req.token),
    ...billingPayload(),
  });
});

// --- Balance ----------------------------------------------------------------
app.get("/api/credits", requireToken, (req, res) => {
  res.json({ credits: getBalance(req.token), ...tierPayload(req.token), ...billingPayload() });
});

app.get("/api/transactions", requireToken, (req, res) => {
  const rows = db
    .prepare("SELECT * FROM transactions WHERE token = ? ORDER BY created_at DESC LIMIT 50")
    .all(req.token);
  res.json({ transactions: rows });
});

// --- Voice changer -----------------------------------------------------------
// List available ElevenLabs voices, so the frontend can populate a dropdown
// without ever holding the real API key itself.
app.get("/api/voice/voices", requireToken, requireVoiceChangerAccess, async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: "Voice changer is not configured on the server" });
    const elevenRes = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
    });
    const data = await elevenRes.json();
    if (!elevenRes.ok) {
      return res.status(elevenRes.status).json({ error: data.detail?.message || "Failed to fetch voices" });
    }
    const voices = (data.voices || []).map((v) => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category,
      preview_url: v.preview_url || null,
    }));
    res.json({ voices });
  } catch (err) {
    console.error("Fetching ElevenLabs voices failed:", err);
    res.status(500).json({ error: "Could not reach ElevenLabs" });
  }
});

// Converts one short audio clip (a rolling ~2.5s chunk from the frontend)
// into the chosen target voice, preserving the original words/delivery, and
// streams the converted audio straight back. Gated behind requireToken so
// your ElevenLabs key/quota can't be hit by anyone without a valid access token.
app.post("/api/voice/convert", requireToken, requireVoiceChangerAccess, upload.single("audio"), async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: "Voice changer is not configured on the server" });
    const voiceId = req.body?.voice_id;
    if (!voiceId) return res.status(400).json({ error: "voice_id is required" });
    if (!req.file) return res.status(400).json({ error: "audio file is required" });

    const form = new FormData();
    form.append("audio", new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" }), "chunk.webm");
    form.append("model_id", ELEVENLABS_STS_MODEL_ID);

    // /stream (not the plain endpoint) + optimize_streaming_latency=4 asks
    // ElevenLabs itself to generate as fast as possible (some quality
    // tradeoff). Piping the response straight through below — rather than
    // buffering the whole clip into memory first — removes a second,
    // avoidable delay on top of that.
    const elevenRes = await fetch(
      `https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128&optimize_streaming_latency=4`,
      {
        method: "POST",
        headers: { "xi-api-key": ELEVENLABS_API_KEY },
        body: form,
      }
    );

    if (!elevenRes.ok) {
      const errText = await elevenRes.text();
      console.error("ElevenLabs speech-to-speech failed:", elevenRes.status, errText);
      // Never forward ElevenLabs 401/403 — the browser treats those as app token rejection and logs the user out.
      return res.status(502).json({
        error: "Voice conversion failed",
        detail: errText.slice(0, 240),
        upstreamStatus: elevenRes.status,
      });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    // Stream bytes to the browser as they arrive from ElevenLabs, instead of
    // waiting for the entire clip to finish generating first.
    const { Readable } = await import("node:stream");
    Readable.fromWeb(elevenRes.body).pipe(res);
  } catch (err) {
    console.error("Voice conversion error:", err);
    res.status(500).json({ error: err.message || "Voice conversion failed" });
  }
});

// Mints a short-lived ticket for the browser to connect DIRECTLY to
// voice-rt-server's WebSocket (see /voice-rt-server). Same credit check as
// starting a Decart session, since using the real-time voice server is just
// as much "real usage" as the video transformation is.
app.post("/api/voice/rtc-ticket", requireToken, requireVoiceChangerAccess, (req, res) => {
  if (!RTC_TICKET_SECRET) return res.status(500).json({ error: "Real-time voice server is not configured" });
  const credits = getBalance(req.token);
  if (credits <= 0) return res.status(402).json({ error: "Out of credits", credits });
  const ticket = mintRtcTicket(req.token);
  res.json({ ticket, expiresInSeconds: RTC_TICKET_TTL_SECONDS, voiceRtUrl: VOICE_RT_URL || null });
});

// Proxies voice-rt-server's /voices through ledger-backend so the browser
// doesn't hit RunPod directly (avoids CORS) and gets clearer errors when
// the pod is stopped or the URL is stale.
app.get("/api/voice/rtc-voices", requireToken, requireVoiceChangerAccess, async (req, res) => {
  if (!RTC_TICKET_SECRET) {
    return res.status(500).json({ error: "RTC_TICKET_SECRET is not set in ledger-backend/.env" });
  }
  if (!VOICE_RT_URL) {
    return res.status(500).json({
      error: "VOICE_RT_URL is not set in ledger-backend/.env — copy your RunPod URL there (same value as VITE_VOICE_RT_URL).",
    });
  }
  const credits = getBalance(req.token);
  if (credits <= 0) return res.status(402).json({ error: "Out of credits", credits });

  const ticket = mintRtcTicket(req.token);
  try {
    const rtRes = await fetch(`${VOICE_RT_URL}/voices?ticket=${encodeURIComponent(ticket)}`);
    const data = await rtRes.json().catch(() => ({}));

    if (!rtRes.ok) {
      const message =
        rtRes.status === 404
          ? `voice-rt-server returned 404 at ${VOICE_RT_URL} — the RunPod pod is probably stopped or the URL changed. Start the pod and update VOICE_RT_URL / VITE_VOICE_RT_URL.`
          : data.error || `voice-rt-server responded ${rtRes.status}`;
      return res.status(502).json({ error: message, voiceRtUrl: VOICE_RT_URL, status: rtRes.status });
    }

    res.json({ ...data, voiceRtUrl: VOICE_RT_URL });
  } catch (err) {
    res.status(502).json({
      error: `Cannot reach voice-rt-server at ${VOICE_RT_URL}. Is the RunPod pod running?`,
      detail: err.message,
      voiceRtUrl: VOICE_RT_URL,
    });
  }
});

// Proxies voice-rt-server /preview — returns a WAV sample for the selected RVC voice.
app.get("/api/voice/rtc-preview/:voiceId", requireToken, requireVoiceChangerAccess, async (req, res) => {
  if (!RTC_TICKET_SECRET) {
    return res.status(500).json({ error: "RTC_TICKET_SECRET is not set in ledger-backend/.env" });
  }
  if (!VOICE_RT_URL) {
    return res.status(500).json({ error: "VOICE_RT_URL is not set in ledger-backend/.env" });
  }
  const credits = getBalance(req.token);
  if (credits <= 0) return res.status(402).json({ error: "Out of credits", credits });

  const voiceId = req.params.voiceId;
  if (!voiceId) return res.status(400).json({ error: "voiceId is required" });

  const ticket = mintRtcTicket(req.token);
  try {
    const rtRes = await fetch(
      `${VOICE_RT_URL}/preview?voice_id=${encodeURIComponent(voiceId)}&ticket=${encodeURIComponent(ticket)}`
    );
    if (!rtRes.ok) {
      const data = await rtRes.json().catch(() => ({}));
      const message = data.detail || data.error || `voice-rt-server preview failed (${rtRes.status})`;
      return res.status(rtRes.status === 404 ? 404 : 502).json({ error: message });
    }
    res.setHeader("Content-Type", "audio/wav");
    const { Readable } = await import("node:stream");
    Readable.fromWeb(rtRes.body).pipe(res);
  } catch (err) {
    res.status(502).json({
      error: `Cannot reach voice-rt-server at ${VOICE_RT_URL}`,
      detail: err.message,
    });
  }
});

// --- Checkout (purchases) ----------------------------------------------------
// Charge in NGN by default so Flutterwave can offer bank transfer / USSD.
// Keep USD amounts as a fallback when FLUTTERWAVE_CURRENCY=USD.
// NGN tiers must stay in sync with src/pricing.js TOP_UP_OPTIONS.
const TIERS_USD = {
  500: 7,
  1000: 14,
  2000: 28,
  5000: 70,
  10000: 140,
  50000: 700,
};
const TIERS_NGN = {
  500: 11200,
  1000: 22400,
  2000: 44800,
  5000: 112000,
  10000: 224000,
  50000: 1120000,
};

function checkoutAmountForCredits(credits) {
  if (CHECKOUT_CURRENCY === "NGN") return TIERS_NGN[credits];
  if (CHECKOUT_CURRENCY === "USD") return TIERS_USD[credits];
  // Unknown currency: convert from USD list at the configured FX rate.
  const usd = TIERS_USD[credits];
  return usd == null ? undefined : Math.round(usd * NAIRA_PER_DOLLAR);
}

function flutterwavePaymentOptions(currency) {
  switch (String(currency || "").toUpperCase()) {
    case "NGN":
      return "card,ussd,banktransfer,account";
    case "KES":
      return "card,mpesa";
    case "GHS":
      return "card,mobilemoneyghana";
    case "UGX":
      return "card,mobilemoneyuganda";
    case "RWF":
      return "card,mobilemoneyrwanda";
    case "ZAR":
      return "card,account";
    default:
      return "card";
  }
}

app.post("/api/checkout", requireToken, async (req, res) => {
  try {
    if (!FLUTTERWAVE_SECRET_KEY) {
      return res.status(503).json({ error: "Payment provider is not configured on the server." });
    }

    const user = getUser(req.token);
    if (!userAllowsPurchase(user)) {
      return res.status(403).json({
        error:
          "Self-serve top-up is locked on this trial account. Message us on WhatsApp to purchase a real plan — an admin will unlock checkout.",
        ...tierPayload(req.token),
      });
    }

    const { credits, email, phone } = req.body || {};
    const amount = checkoutAmountForCredits(credits);
    if (amount == null) {
      return res.status(400).json({ error: "Invalid credit tier" });
    }

    const checkoutEmail = normalizeCustomerEmail(email || user?.customer_email);
    const checkoutPhone = normalizeCustomerPhone(phone || user?.customer_phone);
    if (!isValidCustomerEmail(checkoutEmail)) {
      return res.status(400).json({
        error: "A valid customer email address is required before checkout.",
      });
    }
    if (!checkoutPhone) {
      return res.status(400).json({
        error: "A customer phone number is required before checkout.",
      });
    }
    saveCustomerContact(req.token, checkoutEmail, checkoutPhone);

    const txRef = `credits_${credits}_${randomUUID()}`;
    const paymentOptions = flutterwavePaymentOptions(CHECKOUT_CURRENCY);

    const flutterwaveRes = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount: String(amount),
        currency: CHECKOUT_CURRENCY,
        payment_options: paymentOptions,
        redirect_url: `${FRONTEND_URL}/?checkout=success`,
        customer: {
          email: checkoutEmail,
          phonenumber: checkoutPhone,
        },
        meta: {
          credits: String(credits),
          token: req.token,
          customer_email: checkoutEmail,
          customer_phone: checkoutPhone,
          list_amount: String(amount),
          list_currency: CHECKOUT_CURRENCY,
        },
        customizations: {
          title: "InspireTech Credits",
          description: `${Number(credits).toLocaleString()} live transformation credits`,
          logo: `${FRONTEND_URL}/logo.png`,
        },
      }),
    });

    const data = await flutterwaveRes.json();
    if (data.status !== "success" || !data.data?.link) {
      throw new Error(data.message || "Flutterwave initialization failed");
    }

    console.log(
      `[checkout] ${credits} credits → ${amount} ${CHECKOUT_CURRENCY} (options: ${paymentOptions}) ref ${txRef}`
    );
    res.json({ url: data.data.link, reference: txRef, currency: CHECKOUT_CURRENCY, amount });
  } catch (err) {
    console.error("Checkout initialization failed:", err);
    res.status(500).json({ error: err.message || "Checkout failed" });
  }
});

// Verify-on-return doesn't require the token header — the token travels
// inside the Flutterwave transaction meta instead, since this is
// called right after a redirect where custom headers aren't practical.
app.get("/api/verify/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const transactionId = req.query.transaction_id;
    const verified = await verifyFlutterwaveTransaction({ txRef: reference, transactionId });
    const result = creditFromFlutterwaveTransaction(verified);
    res.json(result);
  } catch (err) {
    console.error("Verification failed:", err);
    res.status(500).json({ error: err.message || "Verification failed" });
  }
});

// --- Client presence (online devices for admin dashboard) --------------------
function upsertClientPresence({ token, clientId, platform, userAgent, isTransforming, sessionId }) {
  if (!clientId || !platform) return;
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT session_id FROM client_presence WHERE token = ? AND client_id = ?")
    .get(token, clientId);

  // Keep the last ended session id on presence until a new transformation starts —
  // admin can still read final live time / session credits after Stop.
  let resolvedSessionId = null;
  if (isTransforming && sessionId) {
    resolvedSessionId = sessionId;
  } else if (sessionId) {
    resolvedSessionId = sessionId;
  } else if (existing?.session_id) {
    resolvedSessionId = existing.session_id;
  }

  db.prepare(
    `INSERT INTO client_presence (token, client_id, platform, user_agent, last_seen_at, is_transforming, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token, client_id) DO UPDATE SET
       platform = excluded.platform,
       user_agent = excluded.user_agent,
       last_seen_at = excluded.last_seen_at,
       is_transforming = excluded.is_transforming,
       session_id = excluded.session_id`
  ).run(
    token,
    clientId,
    platform,
    userAgent ? String(userAgent).slice(0, 240) : null,
    now,
    isTransforming ? 1 : 0,
    resolvedSessionId
  );
}

app.post("/api/presence", requireToken, (req, res) => {
  const { clientId, platform, isTransforming, sessionId } = req.body || {};
  const userAgent = req.headers["user-agent"] || "";
  upsertClientPresence({
    token: req.token,
    clientId,
    platform,
    userAgent,
    isTransforming: Boolean(isTransforming),
    sessionId,
  });
  res.json({ ok: true });
});

// --- Usage sessions (server-authoritative metering) --------------------------
app.post("/api/sessions/start", requireToken, (req, res) => {
  const credits = getBalance(req.token);
  if (credits <= 0) {
    return res.status(402).json({ error: "Out of credits", credits });
  }

  // Defense in depth: if this token somehow already has an active (unended)
  // session — a double-clicked Start button, a tab that closed before
  // calling /end, whatever — close it out properly first.
  // IMPORTANT: cap catch-up. Uncapped wall-clock from last_heartbeat → now
  // wiped entire balances when users started a second transformation.
  const orphaned = db
    .prepare("SELECT * FROM usage_sessions WHERE token = ? AND ended_at IS NULL")
    .all(req.token);
  for (const session of orphaned) {
    const result = applySessionBilling(session.id, req.token, new Date(), {
      endSession: true,
      maxCatchUpSeconds: ORPHAN_SESSION_MAX_CATCHUP_SECONDS,
    });
    console.warn(
      `⚠️  Auto-closed orphaned session (${session.id}) for token ${req.token.slice(0, 8)}...` +
        ` deducted ${result?.creditsToDeduct ?? 0} credits (cap ${ORPHAN_SESSION_MAX_CATCHUP_SECONDS}s).`
    );
  }

  const freshCredits = getBalance(req.token);
  if (freshCredits <= 0) {
    return res.status(402).json({ error: "Out of credits", credits: freshCredits });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const { clientId, platform, decartBaselineSeconds } = req.body || {};
  const decartBaseline = Number.isFinite(Number(decartBaselineSeconds))
    ? Math.max(0, Number(decartBaselineSeconds))
    : 0;
  const userAgent = req.headers["user-agent"] || "";
  db.prepare(
    "INSERT INTO usage_sessions (id, token, started_at, last_heartbeat_at, client_platform, client_id, last_decart_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, req.token, now, now, platform || null, clientId || null, decartBaseline);
  upsertClientPresence({
    token: req.token,
    clientId,
    platform,
    userAgent,
    isTransforming: true,
    sessionId: id,
  });
  res.json({ sessionId: id, credits: freshCredits });
});

app.post("/api/sessions/:id/heartbeat", requireToken, (req, res) => {
  const now = new Date();
  const { decartGenerationSeconds } = req.body || {};
  const decartSeconds = Number.isFinite(Number(decartGenerationSeconds))
    ? Math.max(0, Number(decartGenerationSeconds))
    : null;
  const result = applySessionBilling(req.params.id, req.token, now, { decartGenerationSeconds: decartSeconds });
  if (!result) {
    return res.status(404).json({ error: "Session not found or already ended" });
  }
  if (result.alreadyEnded) {
    return res.json({ credits: result.credits, depleted: result.depleted });
  }

  const { clientId, platform } = req.body || {};
  upsertClientPresence({
    token: req.token,
    clientId,
    platform,
    userAgent: req.headers["user-agent"] || "",
    isTransforming: true,
    sessionId: req.params.id,
  });

  res.json({ credits: result.credits, depleted: result.depleted });
});

app.post("/api/sessions/:id/end", requireToken, (req, res) => {
  const now = new Date();
  const { decartGenerationSeconds } = req.body || {};
  const decartSeconds = Number.isFinite(Number(decartGenerationSeconds))
    ? Math.max(0, Number(decartGenerationSeconds))
    : null;
  const result = applySessionBilling(req.params.id, req.token, now, {
    endSession: true,
    decartGenerationSeconds: decartSeconds,
  });
  if (!result) return res.status(404).json({ error: "Session not found" });
  if (result.alreadyEnded) return res.json({ credits: result.credits });

  const { clientId, platform } = req.body || {};
  if (clientId) {
    upsertClientPresence({
      token: req.token,
      clientId,
      platform,
      userAgent: req.headers["user-agent"] || "",
      isTransforming: false,
      sessionId: req.params.id,
    });
  }

  res.json({ credits: result.credits });
});

// --- Decart realtime (short-lived client tokens) -----------------------------
let decartAdminClient = null;

function getDecartAdminClient() {
  if (!DECART_API_KEY) return null;
  if (!decartAdminClient) {
    decartAdminClient = createDecartClient({ apiKey: DECART_API_KEY });
  }
  return decartAdminClient;
}

app.post("/api/decart/realtime-token", requireToken, async (req, res) => {
  const decartClient = getDecartAdminClient();
  if (!decartClient) {
    return res.status(503).json({ error: "Decart is not configured on this server." });
  }

  const credits = getBalance(req.token);
  if (credits <= 0) {
    return res.status(402).json({ error: "Out of credits", credits });
  }

  const modelId = String(req.body?.modelId || "lucy-2.5").trim();
  const isTrial = userIsTrial(req.token);
  const maxSeconds = maxLiveSecondsForCredits(credits);
  const maxSessionDuration = isTrial
    ? TRIAL_MAX_SESSION_SECONDS
    : Math.max(60, Math.min(maxSeconds, 7200));
  const expiresIn = isTrial
    ? Math.max(90, TRIAL_MAX_SESSION_SECONDS + 30)
    : Math.min(600, Math.max(300, maxSessionDuration + 60));

  const tokenOptions = {
    expiresIn,
    allowedModels: [modelId],
    constraints: {
      realtime: { maxSessionDuration: Math.max(10, maxSessionDuration) },
    },
    metadata: { inspiretechToken: req.token.slice(0, 8) },
  };

  const allowedOrigins = decartAllowedOrigins();
  if (allowedOrigins.length > 0) {
    tokenOptions.allowedOrigins = allowedOrigins;
  }

  try {
    const token = await decartClient.tokens.create(tokenOptions);
    res.json({
      apiKey: token.apiKey,
      expiresAt: token.expiresAt,
      maxSessionDuration,
      isTrial,
      credits,
      ...billingPayload(),
    });
  } catch (err) {
    const { status, error } = decartMintErrorResponse(err);
    res.status(status).json({ error });
  }
});

app.listen(PORT, () => {
  console.log(`Credit ledger backend listening on http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin.html`);
  console.log(
    `Billing: ${effectiveCreditsPerSecond().toFixed(2)} credits/s (500 credits ≈ ${Math.round(LIVE_SECONDS_PER_500_CREDITS / 60)} min live)`
  );
  console.log(
    `Checkout currency: ${CHECKOUT_CURRENCY}` +
      (CHECKOUT_CURRENCY === "NGN"
        ? " (card / USSD / bank transfer)"
        : " — set FLUTTERWAVE_CURRENCY=NGN for Nigerian bank transfer")
  );
});