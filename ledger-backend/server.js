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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3002;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const CREDITS_PER_SECOND = Number(process.env.CREDITS_PER_SECOND || 2);
const MAX_HEARTBEAT_GAP_SECONDS = 10; // caps deduction if a heartbeat is late/missed
const PRESENCE_ACTIVE_SECONDS = 90; // admin "online now" window
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

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

if (!PAYSTACK_SECRET_KEY) {
  console.warn("\n⚠️  PAYSTACK_SECRET_KEY is not set — checkout will fail until you add it to .env\n");
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
  // Lets you cut off a customer's access without deleting their history —
  // a revoked token keeps its balance/transactions on record, it just can't
  // be used to start sessions, buy credits, or check balance anymore.
  ensureColumn("users", "revoked", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "revoked_mobile", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "revoked_desktop", "INTEGER NOT NULL DEFAULT 0");
} catch (err) {
  console.error("Schema self-heal failed — this DB file is likely from an incompatible older version.");
  console.error("Fix: set DB_PATH to a new filename (e.g. /data/ledger_v2.db) and redeploy.");
  console.error(err.message);
  process.exit(1);
}

function getUser(token) {
  return db.prepare("SELECT * FROM users WHERE token = ?").get(token);
}

function getBalance(token) {
  const user = getUser(token);
  return user ? user.credits : 0;
}

function adjustBalance(token, delta) {
  const current = getBalance(token);
  const next = Math.max(0, current + delta);
  db.prepare("UPDATE users SET credits = ? WHERE token = ?").run(next, token);
  return next;
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

// Credits a successful Paystack transaction exactly once. The token being
// credited comes from the metadata attached at checkout time, NOT from
// whoever happens to be calling this — that's what makes it safe to call
// from both the webhook and the verify-on-return endpoint.
function creditFromPaystackTransaction(data) {
  const reference = data.reference;
  const token = data.metadata?.token;
  const user = token ? getUser(token) : null;

  if (!user) {
    console.error(`Webhook/verify for unknown or missing token, reference ${reference}`);
    return { credits: 0, alreadyProcessed: false, error: "Unknown access token" };
  }
  if (user.revoked) {
    console.error(`Webhook/verify for a REVOKED token, reference ${reference} — not crediting.`);
    return { credits: getBalance(token), alreadyProcessed: false, error: "This access token has been revoked" };
  }
  if (hasProcessedReference(reference)) {
    return { credits: getBalance(token), alreadyProcessed: true };
  }

  const credits = Number(data.metadata?.credits || 0);
  const amountNgn = (data.amount || 0) / 100; // Paystack amounts are in kobo
  if (credits > 0) {
    const newBalance = adjustBalance(token, credits);
    recordTransaction({ token, type: "purchase", credits, amount_ngn: amountNgn, provider_reference: reference });
    console.log(`✅ Credited ${credits} credits (balance now ${newBalance}) for token ${token.slice(0, 8)}... ref ${reference}`);
  }
  return { credits: getBalance(token), alreadyProcessed: false };
}

// --- Middleware -------------------------------------------------------------
// Allow the deployed website and Electron desktop (file:// sends Origin: null).
app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === "null" || origin === FRONTEND_URL) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
}));

// Paystack webhooks need the RAW body for signature verification, so this
// route must be registered BEFORE the global express.json() middleware.
app.post("/api/webhooks/paystack", express.raw({ type: "application/json" }), (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const computedHash = crypto
    .createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest("hex");

  if (!signature || computedHash !== signature) {
    console.error("Paystack webhook signature verification failed");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = JSON.parse(req.body.toString("utf8"));
  if (event.event === "charge.success") {
    creditFromPaystackTransaction(event.data);
  }
  res.status(200).json({ received: true });
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
  const token = req.headers["x-access-token"];
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
  const { label, token: requestedToken, credits: startingCredits } = req.body || {};

  // Normally omitted — a fresh random token is minted. Passing an explicit
  // `token` is for MIGRATION: recreating a specific user's exact existing
  // token (e.g. one they already have saved in their browser from an old
  // deployment) on a new/different database, optionally with their prior
  // balance carried over via `credits`.
  const token = requestedToken || randomUUID();
  if (getUser(token)) {
    return res.status(409).json({ error: "That token already exists" });
  }
  const initialCredits = Number.isFinite(Number(startingCredits)) ? Math.max(0, Number(startingCredits)) : 0;

  db.prepare("INSERT INTO users (token, label, credits) VALUES (?, ?, ?)").run(token, label || null, initialCredits);
  if (initialCredits > 0) {
    recordTransaction({ token, type: "purchase", credits: initialCredits, amount_ngn: null, provider_reference: "manual_migration" });
  }
  res.json({ token, label: label || null, credits: initialCredits });
});

// Manually add (or remove, with a negative delta) credits on an existing
// token — for migrations, comps, refunds, or correcting a mistake. This
// bypasses Paystack entirely, so it's protected the same way as the other
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
    .prepare("SELECT token, label, credits, revoked, revoked_mobile, revoked_desktop, created_at FROM users ORDER BY created_at DESC")
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

  const liveSessions = db
    .prepare(
      `SELECT s.id, s.token, s.started_at, s.last_heartbeat_at, s.client_platform, s.client_id,
              u.label, u.revoked, u.revoked_mobile, u.revoked_desktop, u.credits
       FROM usage_sessions s
       JOIN users u ON u.token = s.token
       WHERE s.ended_at IS NULL AND s.last_heartbeat_at >= ?
       ORDER BY s.last_heartbeat_at DESC`
    )
    .all(cutoff);

  res.json({
    activeWindowSeconds: PRESENCE_ACTIVE_SECONDS,
    devices,
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
  db.prepare("UPDATE users SET revoked = 1 WHERE token = ?").run(token);
  res.json({ token, revoked: true, scope: "all" });
});

app.post("/api/admin/tokens/:token/restore", (req, res) => {
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { token } = req.params;
  if (!getUser(token)) return res.status(404).json({ error: "Unknown token" });
  db.prepare("UPDATE users SET revoked = 0 WHERE token = ?").run(token);
  res.json({ token, revoked: false, scope: "all" });
});

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
    db.prepare("UPDATE users SET revoked = ? WHERE token = ?").run(revoke ? 1 : 0, token);
    return res.json({ token, revoked: revoke, scope: "all" });
  }

  setPlatformRevoked(token, scope, revoke);
  return res.json({
    token,
    scope,
    revoked_mobile: scope === "mobile" ? revoke : Number(getUser(token).revoked_mobile) === 1,
    revoked_desktop: scope === "desktop" ? revoke : Number(getUser(token).revoked_desktop) === 1,
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
app.get("/api/access-check", requireToken, (req, res) => {
  res.json({
    ok: true,
    scope: req.clientPlatformScope,
    platform: req.clientPlatform,
    credits: getBalance(req.token),
  });
});

// --- Balance ----------------------------------------------------------------
app.get("/api/credits", requireToken, (req, res) => {
  res.json({ credits: getBalance(req.token) });
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
app.get("/api/voice/voices", requireToken, async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: "Voice changer is not configured on the server" });
    const elevenRes = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
    });
    const data = await elevenRes.json();
    if (!elevenRes.ok) {
      return res.status(elevenRes.status).json({ error: data.detail?.message || "Failed to fetch voices" });
    }
    const voices = (data.voices || []).map((v) => ({ voice_id: v.voice_id, name: v.name, category: v.category }));
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
app.post("/api/voice/convert", requireToken, upload.single("audio"), async (req, res) => {
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
      return res.status(elevenRes.status).json({ error: "Voice conversion failed" });
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
app.post("/api/voice/rtc-ticket", requireToken, (req, res) => {
  if (!RTC_TICKET_SECRET) return res.status(500).json({ error: "Real-time voice server is not configured" });
  const credits = getBalance(req.token);
  if (credits <= 0) return res.status(402).json({ error: "Out of credits", credits });
  const ticket = mintRtcTicket(req.token);
  res.json({ ticket, expiresInSeconds: RTC_TICKET_TTL_SECONDS, voiceRtUrl: VOICE_RT_URL || null });
});

// Proxies voice-rt-server's /voices through ledger-backend so the browser
// doesn't hit RunPod directly (avoids CORS) and gets clearer errors when
// the pod is stopped or the URL is stale.
app.get("/api/voice/rtc-voices", requireToken, async (req, res) => {
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

// --- Checkout (purchases) ----------------------------------------------------
// Exchange rate: ₦1,900 per $1 (set by you — update this single number if the
// rate changes, rather than recalculating each tier by hand).
// Exchange rate: ₦1,900 per $1, and 2,000 credits per $1 (was 100 — a straight
// 20x repricing). Same dollar/naira tiers as before, just more credits per tier.
// Amounts are in KOBO (Paystack's subunit for NGN — 1 naira = 100 kobo).
// Exchange rate: ₦2,000 per $1, and 100 credits per $1 (1 credit = ₦20).
// Amounts are in KOBO (Paystack's subunit for NGN — 1 naira = 100 kobo).
const NAIRA_PER_DOLLAR = 2000;
const TIERS = {
  1000: 10 * NAIRA_PER_DOLLAR * 100,   // $10  -> ₦20,000   -> 1,000 credits
  5000: 50 * NAIRA_PER_DOLLAR * 100,   // $50  -> ₦100,000  -> 5,000 credits
  10000: 100 * NAIRA_PER_DOLLAR * 100, // $100 -> ₦200,000  -> 10,000 credits
  50000: 500 * NAIRA_PER_DOLLAR * 100, // $500 -> ₦1,000,000 -> 50,000 credits
};

app.post("/api/checkout", requireToken, async (req, res) => {
  try {
    const { credits } = req.body || {};
    const amountKobo = TIERS[credits];
    if (!amountKobo) {
      return res.status(400).json({ error: "Invalid credit tier" });
    }

    const reference = `credits_${credits}_${randomUUID()}`;

    const paystackRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: req.body.email || "customer@example.com",
        amount: amountKobo,
        currency: "NGN",
        reference,
        metadata: { credits: String(credits), token: req.token }, // token carried through to the webhook/verify step
        callback_url: `${FRONTEND_URL}/?checkout=success`,
      }),
    });

    const data = await paystackRes.json();
    if (!data.status) {
      throw new Error(data.message || "Paystack initialization failed");
    }

    res.json({ url: data.data.authorization_url });
  } catch (err) {
    console.error("Checkout initialization failed:", err);
    res.status(500).json({ error: err.message || "Checkout failed" });
  }
});

// Verify-on-return doesn't require the token header — the token travels
// inside the Paystack transaction's own metadata instead, since this is
// called right after a redirect where custom headers aren't practical.
app.get("/api/verify/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const data = await verifyRes.json();

    if (!data.status || data.data.status !== "success") {
      return res.status(400).json({ error: "Payment not verified as successful" });
    }

    const result = creditFromPaystackTransaction(data.data);
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
    sessionId || null
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
  // calling /end, whatever — close it out properly first, billing exactly
  // the time it actually ran. Without this, two sessions could run their
  // own independent heartbeat loops against the same balance in parallel,
  // multiplying the effective drain rate.
  const orphaned = db
    .prepare("SELECT * FROM usage_sessions WHERE token = ? AND ended_at IS NULL")
    .all(req.token);
  for (const session of orphaned) {
    const now = new Date();
    const last = new Date(session.last_heartbeat_at);
    const elapsedSeconds = Math.min(MAX_HEARTBEAT_GAP_SECONDS, Math.max(0, (now - last) / 1000));
    const creditsToDeduct = Math.round(elapsedSeconds * CREDITS_PER_SECOND);
    adjustBalance(req.token, -creditsToDeduct);
    if (creditsToDeduct > 0) {
      recordTransaction({ token: req.token, type: "usage", credits: -creditsToDeduct });
    }
    db.prepare(
      "UPDATE usage_sessions SET ended_at = ?, credits_used = credits_used + ? WHERE id = ?"
    ).run(now.toISOString(), creditsToDeduct, session.id);
    console.warn(`⚠️  Auto-closed an orphaned session (${session.id}) for token ${req.token.slice(0, 8)}... before starting a new one.`);
  }

  const freshCredits = getBalance(req.token);
  if (freshCredits <= 0) {
    return res.status(402).json({ error: "Out of credits", credits: freshCredits });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const { clientId, platform } = req.body || {};
  const userAgent = req.headers["user-agent"] || "";
  db.prepare(
    "INSERT INTO usage_sessions (id, token, started_at, last_heartbeat_at, client_platform, client_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, req.token, now, now, platform || null, clientId || null);
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
  const session = db
    .prepare("SELECT * FROM usage_sessions WHERE id = ? AND token = ?")
    .get(req.params.id, req.token);
  if (!session || session.ended_at) {
    return res.status(404).json({ error: "Session not found or already ended" });
  }

  const now = new Date();
  const last = new Date(session.last_heartbeat_at);
  const elapsedSeconds = Math.min(MAX_HEARTBEAT_GAP_SECONDS, Math.max(0, (now - last) / 1000));
  const creditsToDeduct = Math.round(elapsedSeconds * CREDITS_PER_SECOND);

  const remaining = adjustBalance(req.token, -creditsToDeduct);
  if (creditsToDeduct > 0) {
    recordTransaction({ token: req.token, type: "usage", credits: -creditsToDeduct });
  }

  db.prepare(
    "UPDATE usage_sessions SET last_heartbeat_at = ?, credits_used = credits_used + ? WHERE id = ?"
  ).run(now.toISOString(), creditsToDeduct, req.params.id);

  const { clientId, platform } = req.body || {};
  upsertClientPresence({
    token: req.token,
    clientId,
    platform,
    userAgent: req.headers["user-agent"] || "",
    isTransforming: true,
    sessionId: req.params.id,
  });

  res.json({ credits: remaining, depleted: remaining <= 0 });
});

app.post("/api/sessions/:id/end", requireToken, (req, res) => {
  const session = db
    .prepare("SELECT * FROM usage_sessions WHERE id = ? AND token = ?")
    .get(req.params.id, req.token);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.ended_at) return res.json({ credits: getBalance(req.token) });

  const now = new Date();
  const last = new Date(session.last_heartbeat_at);
  const elapsedSeconds = Math.min(MAX_HEARTBEAT_GAP_SECONDS, Math.max(0, (now - last) / 1000));
  const creditsToDeduct = Math.round(elapsedSeconds * CREDITS_PER_SECOND);
  const remaining = adjustBalance(req.token, -creditsToDeduct);
  if (creditsToDeduct > 0) {
    recordTransaction({ token: req.token, type: "usage", credits: -creditsToDeduct });
  }

  db.prepare(
    "UPDATE usage_sessions SET ended_at = ?, credits_used = credits_used + ? WHERE id = ?"
  ).run(now.toISOString(), creditsToDeduct, req.params.id);

  const { clientId, platform } = req.body || {};
  if (clientId) {
    upsertClientPresence({
      token: req.token,
      clientId,
      platform,
      userAgent: req.headers["user-agent"] || "",
      isTransforming: false,
      sessionId: null,
    });
  }

  res.json({ credits: remaining });
});

app.listen(PORT, () => {
  console.log(`Credit ledger backend listening on http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin.html`);
});