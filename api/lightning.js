// FILE PATH: api/lightning.js
//
// Lightning Farming — replaces the old Fruit Tree feature.
// Every 6 hours a "light" slowly charges up. Once charged, the user
// taps to trigger a blast (an ad is shown client-side first — see
// index.html; the ad slot is a placeholder for now) and claims a
// random 10–30 SP reward. After the blast, the 6-hour cycle restarts
// automatically.

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const COOLDOWN_MS = 6 * 3600000; // 6 hours
const MIN_REWARD = 10;
const MAX_REWARD = 30;

function rollBlastReward() {
  return MIN_REWARD + Math.floor(Math.random() * (MAX_REWARD - MIN_REWARD + 1));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-spark-qu47.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const telegramId = req.query?.telegramId || req.body?.telegramId;
  const initData   = req.query?.initData   || req.body?.initData || '';

  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  const tgId = String(telegramId);
  const now = new Date();

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    const lastClaim = user.lightning?.lastClaim ? new Date(user.lightning.lastClaim) : null;
    const readyAt = lastClaim ? lastClaim.getTime() + COOLDOWN_MS : 0;
    const canBlast = !lastClaim || now.getTime() >= readyAt;
    const nextMs = canBlast ? 0 : Math.max(0, readyAt - now.getTime());
    // 0..1 progress of the charge bar, for the client-side animation
    const chargeProgress = canBlast ? 1 : Math.min(1, (COOLDOWN_MS - nextMs) / COOLDOWN_MS);

    if (req.method === 'GET') {
      return res.status(200).json({
        success: true,
        canBlast,
        nextMs,
        chargeProgress,
        totalClaims: user.lightning?.totalClaims || 0,
        totalSpFromLightning: user.lightning?.totalSp || 0,
        minReward: MIN_REWARD,
        maxReward: MAX_REWARD,
        cooldownHours: COOLDOWN_MS / 3600000,
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action } = req.body;
    if (action !== 'blast') return res.status(400).json({ error: 'Invalid action. Use: blast' });

    // Atomic: only succeeds if the cooldown has genuinely elapsed at the
    // moment of the update — prevents double-claim from concurrent taps.
    const cutoff = new Date(now.getTime() - COOLDOWN_MS);
    const reward = rollBlastReward();
    const result = await users.findOneAndUpdate(
      {
        telegramId: tgId,
        $or: [
          { 'lightning.lastClaim': { $exists: false } },
          { 'lightning.lastClaim': null },
          { 'lightning.lastClaim': { $lte: cutoff } },
        ],
      },
      {
        $set: { 'lightning.lastClaim': now },
        $inc: { goldBalance: reward, 'lightning.totalClaims': 1, 'lightning.totalSp': reward },
      },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;
    if (!updated) {
      const remaining = Math.ceil((readyAt - now.getTime()) / 60000);
      return res.status(400).json({ error: `Not charged yet. ${Math.max(remaining, 1)} minutes left.` });
    }

    // Referral milestone (mirror of the check in tasks.js) — either a task
    // completion or a lightning claim can be the action that completes the
    // "5 tasks + 1 lightning claim" pair.
    if (
      (updated.lightning?.totalClaims || 0) >= 1 &&
      (updated.completedTasks?.length || 0) >= 5 &&
      updated.referredBy &&
      !updated.referralValidPaid
    ) {
      const flagged = await users.findOneAndUpdate(
        { telegramId: tgId, referralValidPaid: { $ne: true } },
        { $set: { referralValidPaid: true } },
        { returnDocument: 'after' }
      );
      if (flagged?.value || flagged) {
        await users.updateOne(
          { telegramId: updated.referredBy },
          { $inc: { goldBalance: 100, totalRefEarnedSP: 100 } }
        );
      }
    }

    return res.status(200).json({ success: true, reward });
  } catch (err) {
    console.error('lightning.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
      }
