// Shared pricing — must stay in sync with ledger-backend/server.js TIERS + billing rates.

export const CREDITS_PER_DOLLAR = 100;
export const NAIRA_PER_USD = 1600;
export const NAIRA_PER_CREDIT = (14 * NAIRA_PER_USD) / 1000;
export const DISPLAY_NAIRA_PER_USD = Number(import.meta.env?.VITE_NAIRA_PER_USD) || NAIRA_PER_USD;
export const BASE_CREDITS_PER_SECOND = 2;
// Approximate Decart API cost — ledger bills above this so your balance is never drained first.
export const DECART_CREDITS_PER_SECOND = BASE_CREDITS_PER_SECOND;
// Credit-pack tiles: 500 credits ≈ 4 min live, 1000 ≈ 8 min, etc. (marketing only).
export const DISPLAY_LIVE_MINUTES_PER_500_CREDITS = 4;
// Backend anchor: 500 credits = 3 min live (180 s); ~39% margin vs Decart at 2/sec.
export const LIVE_SECONDS_PER_500_CREDITS = 180;
export const DISPLAY_LIVE_CREDITS_PER_SECOND = 500 / (DISPLAY_LIVE_MINUTES_PER_500_CREDITS * 60);
export const EFFECTIVE_CREDITS_PER_SECOND = 500 / LIVE_SECONDS_PER_500_CREDITS;
export const BILLING_MULTIPLIER = EFFECTIVE_CREDITS_PER_SECOND / DECART_CREDITS_PER_SECOND;
// UI rate label — matches ledger billing (~2.8 credits/s, not the raw Decart API cost of 2/s).
export const DISPLAY_CREDITS_PER_SECOND = Math.round(EFFECTIVE_CREDITS_PER_SECOND * 10) / 10;
export const LOW_CREDIT_THRESHOLD = 40;
export const HEARTBEAT_INTERVAL_MS = 1000;

/** Minimum purchase tier (credits per checkout) that unlocks the voice changer. */
export const VOICE_MIN_PURCHASE_CREDITS = 1000;

/** Minimum purchase tier (credits per checkout) that unlocks background prompt + reference background. */
export const BACKGROUND_MIN_PURCHASE_CREDITS = 2000;

/** @deprecated Use VOICE_MIN_PURCHASE_CREDITS — kept for older imports. */
export const PREMIUM_MIN_PURCHASE_CREDITS = VOICE_MIN_PURCHASE_CREDITS;

export const TOP_UP_OPTIONS = [
  { naira: 11200, credits: 500 },
  { naira: 22400, credits: 1000 },
  { naira: 44800, credits: 2000 },
  { naira: 112000, credits: 5000 },
  { naira: 224000, credits: 10000, popular: true },
  { naira: 1120000, credits: 50000 },
];

export function formatUsdFromNaira(nairaAmount) {
  const dollars = nairaAmount / DISPLAY_NAIRA_PER_USD;
  return `$${dollars.toLocaleString(undefined, {
    minimumFractionDigits: dollars >= 100 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatUsdFromCredits(creditAmount) {
  return formatUsdFromNaira(creditAmount * NAIRA_PER_CREDIT);
}

export function formatNaira(nairaAmount) {
  return `₦${nairaAmount.toLocaleString()}`;
}

export function formatCredits(credits) {
  return credits.toLocaleString();
}

/** Live time shown on credit packs (marketing; actual billing uses EFFECTIVE_CREDITS_PER_SECOND). */
export function formatLiveTimeFromCredits(credits) {
  const totalSeconds = credits / DISPLAY_LIVE_CREDITS_PER_SECOND;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return minutes > 0 ? `~${hours} hr ${minutes} min` : `~${hours} hr`;
  }
  const mins = Math.round(totalSeconds / 60);
  if (mins >= 1) return `~${mins} min`;
  return `~${Math.round(totalSeconds)} sec`;
}

export function formatLiveTimePerMonth(credits) {
  return `${formatLiveTimeFromCredits(credits)} live per month`;
}

export function hasVoiceChangerAccess(maxPurchaseCredits) {
  return Number(maxPurchaseCredits || 0) >= VOICE_MIN_PURCHASE_CREDITS;
}

export function hasBackgroundChangerAccess(maxPurchaseCredits) {
  return Number(maxPurchaseCredits || 0) >= BACKGROUND_MIN_PURCHASE_CREDITS;
}

/**
 * Manual / WhatsApp sale plans (invite flow). Not the same as Flutterwave TOP_UP_OPTIONS.
 * First plan includes access token issuance + starter credits.
 */
export const ACCESS_SALE_PLANS = [
  {
    id: "access-500",
    credits: 500,
    usd: 70,
    includesAccessToken: true,
    label: "Access token + 500 credits",
    blurb: "Starter plan · unlocks studio checkout after admin confirms payment",
  },
  {
    id: "credits-1000",
    credits: 1000,
    usd: 80,
    includesAccessToken: false,
    label: "1,000 credits",
    blurb: "Includes AI voice changer unlock",
  },
  {
    id: "credits-2000",
    credits: 2000,
    usd: 120,
    includesAccessToken: false,
    label: "2,000 credits",
    blurb: "Includes voice + scene / reference background unlock",
  },
];

/** Plain-text price list for WhatsApp / live chat access requests. */
export function buildAccessRequestPriceListMessage({
  intro = "Hi, I'd like to request access to InspireTech.",
  askTrial = true,
} = {}) {
  const lines = [
    intro,
    "",
    "Please send me an access token. Plans:",
    ...ACCESS_SALE_PLANS.map((plan) => {
      const tokenBit = plan.includesAccessToken ? "Access token + " : "";
      return `• ${tokenBit}${plan.credits.toLocaleString()} credits — $${plan.usd}`;
    }),
  ];
  if (askTrial) {
    lines.push("", "If available, I'd also like a short free trial first.");
  }
  return lines.join("\n");
}

/** Marketing feature bullets for landing-page pricing tiles. */
export function getPricingTierFeatures(credits) {
  const features = [
    "Real-time face transform (Lucy 2.5)",
    "InspireTech virtual camera for Zoom, Discord & Teams",
    "Web studio in your browser",
    "Windows desktop app with virtual drivers",
  ];
  if (credits >= VOICE_MIN_PURCHASE_CREDITS) {
    features.push("AI voice changer included");
  }
  if (credits >= BACKGROUND_MIN_PURCHASE_CREDITS) {
    features.push("Custom & reference background changer");
  }
  features.push("Credits roll over until used");
  if (credits >= 2000) {
    features.push("Ideal for weekly calls & streams");
  }
  if (credits >= 5000) {
    features.push("Built for creators who go live often");
  }
  if (credits >= 10000) {
    features.push("Best value for daily use");
  }
  if (credits >= 50000) {
    features.push("For power users & heavy sessions");
  }
  return features;
}
