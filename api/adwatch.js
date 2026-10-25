// FILE PATH: api/adwatch.js
//
// GigaPub + Monetag ad-watch rewards —
// tracked and rewarded independently per network. Each network has its own
// daily cap and SP reward (see REWARD_MAP / MAX_PER_DAY_MAP below),
// resetting at midnight Bangladesh time (UTC+6). The client shows the real
// ad via the matching SDK and only calls this endpoint once that promise
// resolves — same trust model as the rest of the app's ad/task flows
// (client-attested, not independently verifiable).

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { guardAdClaim } from '../lib/security.js';
import { maybeAwardValidReferral } from '../lib/referral.js';

// Per-network SP reward and daily watch cap.
// Only GigaPub and Monetag are supported (Adexium / USL / Adsgram removed).
const REWARD_MAP = { giga: 12.5, monetag: 12.5 };
const MAX_PER_DAY_MAP = { giga: 20, monetag: 20 };

// How many recent ad-watch timestamps we keep per user — only needed to
// answer "how many ads in the last 24h" for the withdraw gate, so this
// only needs to comfortably exceed a day's worth of watches (max 60/day
// across all networks) without growing the document unbounded.
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

  // GET ?network=all returns both networks in ONE request (fewer function calls).
  const isAll = network === 'all' && req.method === 'GET';
  const field = isAll ? null : NETWORK_FIELD[network];
  if (!isAll && !field) return res.status(400).json({ error: "network must be one of: giga, monetag" });

  const REWARD = REWARD_MAP[network];
  const MAX_PER_DAY = MAX_PER_DAY_MAP[network];

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

    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'private, max-age=15');
      const statusOf = (n) => {
        const f = NETWORK_FIELD[n];
        return {
          count: user[f]?.date === today ? (user[f].count || 0) : 0,
          max: MAX_PER_DAY_MAP[n],
          reward: REWARD_MAP[n],
        };
      };
      if (isAll) {
        return res.status(200).json({ success: true, networks: { giga: statusOf('giga'), monetag: statusOf('monetag') } });
      }
      return res.status(200).json({ success: true, ...statusOf(network) });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── Anti-script guard (NEWTUBE botGuard): min gap between rewards + pattern rules ──
    const guard = await guardAdClaim(db, user, req.body?.watchMs);
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

    // Atomic path A: same-day counter still under the cap.
    let result = await users.findOneAndUpdate(
      { telegramId: tgId, [`${field}.date`]: today, [`${field}.count`]: { $lt: MAX_PER_DAY } },
      {
        $inc: { spBalance: REWARD, [`${field}.count`]: 1, totalAdsWatched: 1 },
        $set: { recentAdClaims: guard.samples }, // pattern history saved in the SAME write (no extra DB call)
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
          $set: { [`${field}.date`]: today, [`${field}.count`]: 1, recentAdClaims: guard.samples },
          $inc: { spBalance: REWARD, totalAdsWatched: 1 },
          $push: { adWatchLog: { $each: [now], $slice: -AD_LOG_KEEP } },
        },
        { returnDocument: 'after' }
      );
      updated = result?.value || result;
      if (!updated) {
        return res.status(400).json({ error: `Daily limit reached (${MAX_PER_DAY}/${MAX_PER_DAY}). Come back tomorrow.` });
      }
    }

    // Remember this claim for the pattern rules, then check whether the referral just became valid (+300 SP to the referrer).
    await maybeAwardValidReferral(db, updated);

    return res.status(200).json({ success: true, reward: REWARD, count: updated[field].count, max: MAX_PER_DAY, newSp: updated.spBalance });
  } catch (err) {
    console.error('adwatch.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
