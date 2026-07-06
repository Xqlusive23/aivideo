// server.js — the real credit ledger.
//
// Why this exists: Decart's own dashboard shows a real credit balance, but
// doesn't expose it via API. This backend becomes YOUR OWN source of truth:
// you sell credits to your user via Stripe, track balance in a real database,
// and meter usage server-side (never trust a browser timer with money).
//
// Run with: node server.js   (after `npm install` + setting up .env)

import express from "express";
import cors from "cors";
import Stripe from "stripe";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 3002;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const CREDITS_PER_SECOND = Number(process.env.CREDITS_PER_SECOND || 2);
const MAX_HEARTBEAT_GAP_SECONDS = 10; // caps deduction if a heartbeat is late/missed, so a stalled tab can't rack up unlimited debt in one jump

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("\n⚠️  STRIPE_SECRET_KEY is not set — checkout will fail until you add it to .env\n");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");
const app = express();

// --- Database setup -------------------------------------------------------
const db = new Database("ledger.db");
db.pragma("journal_mode = WAL");

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
    amount_usd REAL,
    stripe_session_id TEXT,
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

function recordTransaction({ type, credits, amount_usd = null, stripe_session_id = null }) {
  db.prepare(
    "INSERT INTO transactions (type, credits, amount_usd, stripe_session_id) VALUES (?, ?, ?, ?)"
  ).run(type, credits, amount_usd, stripe_session_id);
}

// --- Middleware -------------------------------------------------------------
app.use(cors());

// Stripe webhooks need the RAW body for signature verification, so this route
// must be registered BEFORE the global express.json() middleware.
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const credits = Number(session.metadata?.credits || 0);
    const amountUsd = (session.amount_total || 0) / 100;

    if (credits > 0) {
      const newBalance = adjustBalance(credits);
      recordTransaction({
        type: "purchase",
        credits,
        amount_usd: amountUsd,
        stripe_session_id: session.id,
      });
      console.log(`✅ Credited ${credits} credits (balance now ${newBalance}) for session ${session.id}`);
    }
  }

  res.json({ received: true });
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
// Tiers mirror Decart's own dashboard: 1k/$10, 5k/$50, 10k/$100, 50k/$500
const TIERS = {
  1000: 10,
  5000: 50,
  10000: 100,
  50000: 500,
};

app.post("/api/checkout", async (req, res) => {
  try {
    const { credits } = req.body || {};
    const dollars = TIERS[credits];
    if (!dollars) {
      return res.status(400).json({ error: "Invalid credit tier" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `${credits.toLocaleString()} credits` },
            unit_amount: dollars * 100,
          },
          quantity: 1,
        },
      ],
      metadata: { credits: String(credits) },
      success_url: `${FRONTEND_URL}/?checkout=success`,
      cancel_url: `${FRONTEND_URL}/?checkout=cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout session creation failed:", err);
    res.status(500).json({ error: err.message || "Checkout failed" });
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
