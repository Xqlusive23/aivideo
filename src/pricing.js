// Shared pricing — must stay in sync with ledger-backend/server.js TIERS + CREDITS_PER_SECOND.

export const CREDITS_PER_DOLLAR = 100;
export const NAIRA_PER_USD = 1600;
export const NAIRA_PER_CREDIT = (14 * NAIRA_PER_USD) / 1000;
export const DISPLAY_NAIRA_PER_USD = Number(import.meta.env?.VITE_NAIRA_PER_USD) || NAIRA_PER_USD;
export const DISPLAY_CREDITS_PER_SECOND = 2;
export const LOW_CREDIT_THRESHOLD = 40;
export const HEARTBEAT_INTERVAL_MS = 1000;

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

/** Live transformation time billed at DISPLAY_CREDITS_PER_SECOND while the session is running. */
export function formatLiveTimeFromCredits(credits) {
  const totalSeconds = credits / DISPLAY_CREDITS_PER_SECOND;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return minutes > 0 ? `~${hours} hr ${minutes} min` : `~${hours} hr`;
  }
  const mins = Math.round(totalSeconds / 60);
  if (mins >= 1) return `~${mins} min`;
  return `~${Math.round(totalSeconds)} sec`;
}
