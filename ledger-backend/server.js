// server.js — the real credit ledger.
//
// Why this exists: Decart's own dashboard shows a real credit balance, but
// doesn't expose it via API. This backend becomes YOUR OWN source of truth:
// you sell credits to your user via Paystack, track balance in a real
// database, and meter usage server-side (never trust a browser timer with money).
//
// Run with: node server.js   (after `npm install` + setting up .env)

import express from "express";
import cors from "cors";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 3002;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const CREDITS_PER_SECOND = Number(process.env.CREDITS_PER_SECOND || 2);
const MAX_HEARTBEAT_GAP_SECONDS = 10; // caps deduction if a heartbeat is late/missed, so a stalled tab can't rack up unlimited debt in one jump
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";

if (!PAYSTACK_SECRET_KEY) {
  console.warn("\n⚠️  PAYSTACK_SECRET_KEY is not set — checkout will fail until you add it to .env\n");
}

const app = express();

// --- Database setup -------------------------------------------------------
// Uses Node's built-in SQLite (node:sqlite) — requires Node 22.5+, no native
// compilation, no Visual Studio / build tools needed.
//
// NOTE: this table used to have a column called stripe_session_id — it's now
// provider_reference (Paystack's transaction reference). If you have an
// existing ledger.db from testing with Stripe, delete that file and let it
// recreate fresh — node:sqlite's CREATE TABLE IF NOT EXISTS won't rename an
// existing column for you.
// DB_PATH lets you point this at a mounted persistent volume on your host
// (e.g. "/data/ledger.db") — without that, most container platforms wipe the
// filesystem on every redeploy, and you'd lose real customer balances.
const DB_PATH = process.env.DB_PATH || "ledger.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    credits INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO ledger (id, credits) VALUES (1, 0);

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,             -- 'purchase' | 'usage'
    credits INTEGER NOT NULL,       -- positive for purchase, negative for usage
    amount_ngn REAL,
    provider_reference TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS usage_sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    ended_at TEXT,
    credits_used INTEGER NOT NULL DEFAULT 0
  );
`);

function getBalance() {
  return db.prepare("SELECT credits FROM ledger WHERE id = 1").get().credits;
}

function adjustBalance(delta) {
  const current = getBalance();
  const next = Math.max(0, current + delta);
  db.prepare("UPDATE ledger SET credits = ? WHERE id = 1").run(next);
  return next;
}

function recordTransaction({ type, credits, amount_ngn = null, provider_reference = null }) {
  db.prepare(
    "INSERT INTO transactions (type, credits, amount_ngn, provider_reference) VALUES (?, ?, ?, ?)"
  ).run(type, credits, amount_ngn, provider_reference);
}

function hasProcessedReference(reference) {
  const row = db
    .prepare("SELECT id FROM transactions WHERE provider_reference = ?")
    .get(reference);
  return Boolean(row);
}

// Credits a successful Paystack transaction exactly once, regardless of
// whether the webhook or the verify-on-return call gets there first.
function creditFromPaystackTransaction(data) {
  const reference = data.reference;
  if (hasProcessedReference(reference)) {
    return { credits: getBalance(), alreadyProcessed: true };
  }
  const credits = Number(data.metadata?.credits || 0);
  const amountNgn = (data.amount || 0) / 100; // Paystack amounts are in kobo
  if (credits > 0) {
    const newBalance = adjustBalance(credits);
    recordTransaction({ type: "purchase", credits, amount_ngn: amountNgn, provider_reference: reference });
    console.log(`✅ Credited ${credits} credits (balance now ${newBalance}) for reference ${reference}`);
  }
  return { credits: getBalance(), alreadyProcessed: false };
}

// --- Middleware -------------------------------------------------------------
// Wide-open CORS is fine for local dev but not once this is public — lock it
// to your real frontend origin via FRONTEND_URL.
app.use(cors({ origin: FRONTEND_URL }));

// Paystack webhooks need the RAW body for signature verification, so this
// route must be registered BEFORE the global express.json() middleware.
app.post("/api/webhooks/paystack", express.raw({ type: "application/json" }), (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const computedHash = crypto
    .createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(req.body) // raw Buffer — hashing a re-serialized/parsed body gives a different signature
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

// --- Balance ----------------------------------------------------------------
app.get("/api/credits", (req, res) => {
  res.json({ credits: getBalance() });
});

app.get("/api/transactions", (req, res) => {
  const rows = db.prepare("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50").all();
  res.json({ transactions: rows });
});

// --- Checkout (purchases) ----------------------------------------------------
// Exchange rate: ₦1,900 per $1 (set by you — update this single number if the
// rate changes, rather than recalculating each tier by hand).
// Amounts are in KOBO (Paystack's subunit for NGN — 1 naira = 100 kobo).
const NAIRA_PER_DOLLAR = 1900;
const TIERS = {
  1000: 10 * NAIRA_PER_DOLLAR * 100,  // $10  -> ₦19,000  -> 1,900,000 kobo
  5000: 50 * NAIRA_PER_DOLLAR * 100,  // $50  -> ₦95,000  -> 9,500,000 kobo
  10000: 100 * NAIRA_PER_DOLLAR * 100, // $100 -> ₦190,000 -> 19,000,000 kobo
  50000: 500 * NAIRA_PER_DOLLAR * 100, // $500 -> ₦950,000 -> 95,000,000 kobo
};

app.post("/api/checkout", async (req, res) => {
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
        email: req.body.email || "customer@example.com", // Paystack requires an email; swap in a real one if you collect it
        amount: amountKobo,
        currency: "NGN",
        reference,
        metadata: { credits: String(credits) },
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

// Paystack's own docs recommend NOT relying on webhooks alone — verify the
// transaction directly when the user lands back on your site, in case the
// webhook is delayed or (during local dev without a public URL) never arrives.
app.get("/api/verify/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const data = await verifyRes.json();

    if (!data.status || data.data.status !== "success") {
      return res.status(400).json({ error: "Payment not verified as successful", credits: getBalance() });
    }

    const result = creditFromPaystackTransaction(data.data);
    res.json(result);
  } catch (err) {
    console.error("Verification failed:", err);
    res.status(500).json({ error: err.message || "Verification failed" });
  }
});

// --- Usage sessions (server-authoritative metering) --------------------------
// The frontend can display whatever countdown it wants, but THIS is what
// actually deducts real credits — based on server clock, not client timers.

app.post("/api/sessions/start", (req, res) => {
  const credits = getBalance();
  if (credits <= 0) {
    return res.status(402).json({ error: "Out of credits", credits });
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO usage_sessions (id, started_at, last_heartbeat_at) VALUES (?, ?, ?)"
  ).run(id, now, now);
  res.json({ sessionId: id, credits });
});

app.post("/api/sessions/:id/heartbeat", (req, res) => {
  const session = db.prepare("SELECT * FROM usage_sessions WHERE id = ?").get(req.params.id);
  if (!session || session.ended_at) {
    return res.status(404).json({ error: "Session not found or already ended" });
  }

  const now = new Date();
  const last = new Date(session.last_heartbeat_at);
  const elapsedSeconds = Math.min(
    MAX_HEARTBEAT_GAP_SECONDS,
    Math.max(0, (now - last) / 1000)
  );
  const creditsToDeduct = Math.round(elapsedSeconds * CREDITS_PER_SECOND);

  const remaining = adjustBalance(-creditsToDeduct);
  if (creditsToDeduct > 0) {
    recordTransaction({ type: "usage", credits: -creditsToDeduct });
  }

  db.prepare(
    "UPDATE usage_sessions SET last_heartbeat_at = ?, credits_used = credits_used + ? WHERE id = ?"
  ).run(now.toISOString(), creditsToDeduct, req.params.id);

  res.json({ credits: remaining, depleted: remaining <= 0 });
});

app.post("/api/sessions/:id/end", (req, res) => {
  const session = db.prepare("SELECT * FROM usage_sessions WHERE id = ?").get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.ended_at) return res.json({ credits: getBalance() }); // already ended, no-op

  // Deduct any final sliver of time since the last heartbeat before closing out.
  const now = new Date();
  const last = new Date(session.last_heartbeat_at);
  const elapsedSeconds = Math.min(MAX_HEARTBEAT_GAP_SECONDS, Math.max(0, (now - last) / 1000));
  const creditsToDeduct = Math.round(elapsedSeconds * CREDITS_PER_SECOND);
  const remaining = adjustBalance(-creditsToDeduct);
  if (creditsToDeduct > 0) {
    recordTransaction({ type: "usage", credits: -creditsToDeduct });
  }

  db.prepare(
    "UPDATE usage_sessions SET ended_at = ?, credits_used = credits_used + ? WHERE id = ?"
  ).run(now.toISOString(), creditsToDeduct, req.params.id);

  res.json({ credits: remaining });
});

app.listen(PORT, () => {
  console.log(`Credit ledger backend listening on http://localhost:${PORT}`);
  console.log(`Current balance: ${getBalance()} credits`);
});