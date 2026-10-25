// FILE PATH: api/tower.js
//
// ⚡ Electricity — 4 power towers that generate SP.
//
//   Tower 1  FREE            25 SP  every  1 hour
//   Tower 2  unlock 500 SP   50 SP  every  2 hours
//   Tower 3  unlock 3,000 SP 100 SP every  4 hours
//   Tower 4  unlock 10,000 SP 150 SP every 12 hours
//
// Every claim shows a GigaPub ad on the client first (Monetag is the automatic fallback — see
// showGigaAd() in index.html). Each tower is a simple cooldown: once its interval has passed
// since the last claim, one claim of `reward` SP is available. Unlocking a tower starts its
// first cooldown, so a purchase can never be refunded by an instant claim.
//
//   GET  /api/tower                       → state of all towers
//   POST /api/tower {action:'unlock', tower:2}
//   POST /api/tower {action:'claim',  tower:1, watchMs}

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { guardAdClaim } from '../lib/security.js';
import { maybeAwardValidReferral } from '../lib/referral.js';
import { TOWERS, towerState } from '../lib/towers.js';

const AD_LOG_KEEP = 60;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-spark-qu47.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const telegramId = req.query?.telegramId || req.body?.telegramId;
  const initData = req.query?.initData || req.body?.initData || '';
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  const tgId = String(telegramId);
  const now = Date.now();

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'private, max-age=10');
      return res.status(200).json({ success: true, towers: towerState(user, now), spBalance: user.spBalance || 0 });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action } = req.body;
    const n = Number(req.body.tower);
    const cfg = TOWERS[n];
    if (!cfg) return res.status(400).json({ error: 'Invalid tower' });
    const key = `towers.t${n}`;

    // ── unlock ───────────────────────────────────────────────
    if (action === 'unlock') {
      if (cfg.cost === 0) return res.status(400).json({ error: 'This tower is already unlocked.' });
      const r = await users.findOneAndUpdate(
        { telegramId: tgId, spBalance: { $gte: cfg.cost }, [`${key}.unlocked`]: { $ne: true } },
        { $inc: { spBalance: -cfg.cost }, $set: { [`${key}.unlocked`]: true, [`${key}.lastClaim`]: new Date(now), [`${key}.unlockedAt`]: new Date(now) } },
        { returnDocument: 'after' }
      );
      const updated = r?.value || r;
      if (!updated) {
        const fresh = await users.findOne({ telegramId: tgId }, { projection: { spBalance: 1, towers: 1 } });
        if (fresh?.towers?.[`t${n}`]?.unlocked) return res.status(400).json({ error: 'Already unlocked.' });
        return res.status(400).json({ error: `Not enough SP. You need ${cfg.cost.toLocaleString()} SP.` });
      }
      return res.status(200).json({ success: true, spBalance: updated.spBalance, towers: towerState(updated, now) });
    }

    // ── claim ────────────────────────────────────────────────
    if (action === 'claim') {
      if (user.accountLocked && user.accountLockedReason === 'bot_pattern')
        return res.status(403).json({ error: 'Account locked for suspicious activity. Contact support.' });

      const unlocked = cfg.cost === 0 || !!user.towers?.[`t${n}`]?.unlocked;
      if (!unlocked) return res.status(400).json({ error: 'Unlock this tower first.' });

      // The claim shows an ad → run the same anti-script guard as normal ad rewards.
      let guard = null;
      if (cfg.ads) {
        guard = await guardAdClaim(db, user, req.body?.watchMs);
        if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
      }

      // Atomic: only succeeds if the interval has really elapsed — no double claims.
      const cutoff = new Date(now - cfg.intervalMs);
      const r = await users.findOneAndUpdate(
        {
          telegramId: tgId,
          $or: [{ [`${key}.lastClaim`]: { $exists: false } }, { [`${key}.lastClaim`]: null }, { [`${key}.lastClaim`]: { $lte: cutoff } }],
        },
        {
          $set: { [`${key}.lastClaim`]: new Date(now), ...(guard ? { recentAdClaims: guard.samples } : {}) },
          $inc: { spBalance: cfg.reward, [`${key}.claims`]: 1, [`${key}.total`]: cfg.reward, ...(cfg.ads ? { totalAdsWatched: 1 } : {}) },
          ...(cfg.ads ? { $push: { adWatchLog: { $each: [new Date(now)], $slice: -AD_LOG_KEEP } } } : {}),
        },
        { returnDocument: 'after' }
      );
      const updated = r?.value || r;
      if (!updated) {
        const t = user.towers?.[`t${n}`];
        const left = t?.lastClaim ? Math.max(1, Math.ceil((new Date(t.lastClaim).getTime() + cfg.intervalMs - now) / 60000)) : 1;
        return res.status(400).json({ error: `Not charged yet. ${left} min left.` });
      }
      if (cfg.ads) await maybeAwardValidReferral(db, updated);
      return res.status(200).json({ success: true, reward: cfg.reward, spBalance: updated.spBalance, towers: towerState(updated, now) });
    }

    return res.status(400).json({ error: 'Invalid action. Use: unlock | claim' });
  } catch (err) {
    console.error('tower.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
      }
