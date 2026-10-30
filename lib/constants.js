// lib/constants.js — one place for the economy + security numbers.

// ── Currency ────────────────────────────────────────────────
// ONE currency only: SP. 50,000 SP = $1 USDT. (Gold + Convert were removed.)
export const SP_PER_USDT = 50000;
// Old Gold values (from before Gold was removed) are turned into SP at this rate: leftover
// balances, legacy tasks / promo codes.  Gold amount ÷ 40 = SP.
export const LEGACY_GOLD_PER_SP = 40;
export const toSp = (v) => Math.round((Number(v) || 0) / LEGACY_GOLD_PER_SP * 100) / 100;

// ── Referral (3 steps + commission) ─────────────────────────
// The referrer is paid step by step as the friend progresses (each step pays ONCE):
//   Step 1  friend joins the payout channel and taps Verify   → REF_JOIN_SP
//   Step 2  friend watches VALID_ADS ads                      → REF_ADS_SP
//   Step 3  friend completes VALID_TASKS tasks                → REF_TASKS_SP
// Step 4  the referrer earns WITHDRAW_COMMISSION_PERCENT of every withdrawal the friend makes —
//         paid ONLY when the admin approves that withdrawal (see api/bot.js), forever.
// A friend counts as a "valid referral" (needed for the referrer's bigger withdrawals) after step 2 AND 3.
export const REF_JOIN_SP = 50;
export const REF_ADS_SP = 200;
export const REF_TASKS_SP = 200;
export const REFERRAL_REWARD_SP = REF_JOIN_SP + REF_ADS_SP + REF_TASKS_SP; // 450 SP total per fully-active friend
export const WITHDRAW_COMMISSION_PERCENT = 15;
export const VALID_TASKS = 10;
export const VALID_ADS = 10;

// Payout channel the new user must join (the bot must be an ADMIN of this channel so getChatMember works).
export const PAYOUT_CHANNEL = '@Tonsparkpayouts';
export const PAYOUT_CHANNEL_URL = 'https://t.me/Tonsparkpayouts';

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
  giga:    { field: 'gigaAds',    reward: 25, max: 20 },
  monetag: { field: 'monetagAds', reward: 25, max: 20 },
};

// ── Withdrawal rules ────────────────────────────────────────
export const MIN_WITHDRAW_SP = 2000;      // minimum per request
export const WD_MIN_TOWER_CLAIMS = 3;     // tower rewards collected (lifetime, all towers together)
export const WD_MIN_TASKS = 5;            // tasks completed (lifetime)
export const WITHDRAW_FEE = 0.10;         // 10% fee
