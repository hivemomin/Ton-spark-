// lib/constants.js — one place for the economy + security numbers.

// ── Currency ────────────────────────────────────────────────
// ONE currency only: SP. 50,000 SP = $1 USDT. (Gold + Convert were removed.)
export const SP_PER_USDT = 50000;
// Old Gold values (from before Gold was removed) are turned into SP at this rate: leftover
// balances, legacy tasks / promo codes.  Gold amount ÷ 40 = SP.
export const LEGACY_GOLD_PER_SP = 40;
export const toSp = (v) => Math.round((Number(v) || 0) / LEGACY_GOLD_PER_SP * 100) / 100;

// ── Referral (NEWTUBE style) ────────────────────────────────
// The referrer earns REFERRAL_REWARD_SP once, when the friend becomes a
// "valid referral" (VALID_TASKS tasks + VALID_ADS ads). On top of that the
// referrer earns WITHDRAW_COMMISSION_PERCENT of every withdrawal the friend
// makes (paid when the admin approves it, forever).
export const REFERRAL_REWARD_SP = 300;
export const WITHDRAW_COMMISSION_PERCENT = 15;
export const VALID_TASKS = 10;
export const VALID_ADS = 10;

// ── Security thresholds ─────────────────────────────────────
// Same idea as NEWTUBE: auto-lock only for things a real person cannot do,
// everything else just alerts the admin.
export const REFERRAL_VELOCITY_WINDOW_MS = 2 * 60 * 1000;   // 20+ signups under ONE referrer inside 2 min = alert
export const REFERRAL_VELOCITY_THRESHOLD = 20;
export const IP_SIGNUP_VELOCITY_WINDOW_MS = 3 * 60 * 1000;  // 15+ NEW accounts from ONE IP inside 3 min = admin ALERT only (shared SIM IPs are normal in BD, nobody is locked)
export const IP_SIGNUP_VELOCITY_THRESHOLD = 15;
export const MIN_AD_GAP_MS = 8000;                          // two ad rewards can never be < 8s apart
export const BOT_SUSPECT_HOLD_COUNT = 3;                    // this many bot-rule hits => withdrawals held for admin review

// ── Ads (GigaPub + Monetag): SP reward and daily cap per network ──
export const AD_NETWORKS = {
  giga:    { field: 'gigaAds',    reward: 12.5, max: 20 },
  monetag: { field: 'monetagAds', reward: 12.5, max: 20 },
};
