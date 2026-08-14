// FILE PATH: api/adwatch.js
//
// GigaPub + Monetag ad-watch rewards — tracked and rewarded independently
// per network. Each network allows up to MAX_PER_DAY watches, resetting at
// midnight Bangladesh time (UTC+6), each crediting REWARD Gold. The client
// shows the real ad via the matching SDK and only calls this endpoint once
// that promise resolves — same trust model as the rest of the app's
// ad/task flows (client-attested, not independently verifiable).

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const REWARD = 500; // Gold, per ad, same for both networks
const MAX_PER_DAY = 20; // per network

// Referral Tier 3: referrer earns this once their referred user has
// watched ADS_MILESTONE ads in total, combined across both networks.
const ADS_MILESTONE = 20;
const ADS_MILESTONE_REWARD_SP = 150;

// "Valid referral" gate (used by withdraw.js): a referred user counts as
// valid once THEY have completed VALID_TASKS tasks AND watched VALID_ADS
// ads. This is a separate, lower threshold from the Tier-2/Tier-3 SP
// rewards above — it doesn't pay anyone, it just unlocks their referrer's
// ability to withdraw above the free tier.
const VALID_TASKS = 5;
const VALID_ADS = 20;

// How many recent ad-watch timestamps we keep per user — only needed to
// answer "how many ads in the last 24h" for the withdraw gate, so this
// only needs to comfortably exceed a day's worth of watches (max 40/day
// across both networks) without growing the document unbounded.
const AD_LOG_KEEP = 60;

// Bangladesh runs a fixed UTC+6 offset with no DST, so shifting the current
// UTC timestamp forward 6 hours and reading its UTC calendar date gives the
// current Bangladesh calendar date — that's what "resets at midnight BDT"
// means here, without needing a timezone library.
const bdtDateKey = () => new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10);

const NETWORK_FIELD = { giga: 'gigaAds', monetag: 'monetagAds' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-spark-qu47.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const telegramId = req.query?.telegramId || req.body?.telegramId;
  const initData   = req.query?.initData   || req.body?.initData || '';
  const network    = req.query?.network    || req.body?.network  || 'giga';
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  const field = NETWORK_FIELD[network];
  if (!field) return res.status(400).json({ error: "network must be 'giga' or 'monetag'" });

  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  const tgId = String(telegramId);
  const today = bdtDateKey();
  const now = new Date();

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    const currentCount = user[field]?.date === today ? (user[field].count || 0) : 0;

    if (req.method === 'GET') {
      return res.status(200).json({ success: true, count: currentCount, max: MAX_PER_DAY, reward: REWARD });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Atomic path A: same-day counter still under the cap.
    let result = await users.findOneAndUpdate(
      { telegramId: tgId, [`${field}.date`]: today, [`${field}.count`]: { $lt: MAX_PER_DAY } },
      {
        $inc: { goldBalance: REWARD, [`${field}.count`]: 1, totalAdsWatched: 1 },
        $push: { adWatchLog: { $each: [now], $slice: -AD_LOG_KEEP } },
      },
      { returnDocument: 'after' }
    );
    let updated = result?.value || result;

    if (!updated) {
      if (user[field]?.date === today) {
        // Same day, counter simply maxed out.
        return res.status(400).json({ error: `Daily limit reached (${MAX_PER_DAY}/${MAX_PER_DAY}). Come back tomorrow.` });
      }
      // Atomic path B: it's a new BDT day — reset-and-credit in one update,
      // guarded so a stale doc can't be reset twice concurrently.
      result = await users.findOneAndUpdate(
        { telegramId: tgId, [`${field}.date`]: { $ne: today } },
        {
          $set: { [`${field}.date`]: today, [`${field}.count`]: 1 },
          $inc: { goldBalance: REWARD, totalAdsWatched: 1 },
          $push: { adWatchLog: { $each: [now], $slice: -AD_LOG_KEEP } },
        },
        { returnDocument: 'after' }
      );
      updated = result?.value || result;
      if (!updated) {
        return res.status(400).json({ error: `Daily limit reached (${MAX_PER_DAY}/${MAX_PER_DAY}). Come back tomorrow.` });
      }
    }

    // Referral Tier 3 — fires once, the first time this user's lifetime
    // ad-watch count (across both networks) reaches the milestone.
    const totalAds = updated.totalAdsWatched || 0;
    if (totalAds >= ADS_MILESTONE && updated.referredBy && !updated.referralAds20Paid) {
      const flagged = await users.findOneAndUpdate(
        { telegramId: tgId, referralAds20Paid: { $ne: true } },
        { $set: { referralAds20Paid: true } },
        { returnDocument: 'after' }
      );
      if (flagged?.value || flagged) {
        await users.updateOne(
          { telegramId: updated.referredBy },
          { $inc: { spBalance: ADS_MILESTONE_REWARD_SP, totalRefEarnedSP: ADS_MILESTONE_REWARD_SP } }
        );
      }
    }

    // "Valid referral" gate flag — set on THIS user (the referee), not the
    // referrer, and pays nothing. It only unlocks the referrer's ability to
    // withdraw above the free tier once this user has done enough.
    if (
      (updated.completedTasks?.length || 0) >= VALID_TASKS &&
      totalAds >= VALID_ADS &&
      !updated.refereeValid
    ) {
      await users.updateOne(
        { telegramId: tgId, refereeValid: { $ne: true } },
        { $set: { refereeValid: true } }
      );
    }

    return res.status(200).json({ success: true, reward: REWARD, count: updated[field].count, max: MAX_PER_DAY });
  } catch (err) {
    console.error('adwatch.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
                                 }
