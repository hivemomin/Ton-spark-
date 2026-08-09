// FILE PATH: api/adwatch.js
//
// GigaPub daily ad-watch rewards. Up to MAX_PER_DAY watches, resetting at
// midnight (server date), each crediting REWARD SP. The client shows the
// real GigaPub ad via window.showGiga() and only calls this endpoint once
// that promise resolves — same trust model as the rest of the app's
// ad/task flows (client-attested, not independently verifiable).

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const REWARD = 10;
const MAX_PER_DAY = 10;
const todayKey = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-spark-beta.vercel.app');
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
  const today = todayKey();

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    const currentCount = user.gigaAds?.date === today ? (user.gigaAds.count || 0) : 0;

    if (req.method === 'GET') {
      return res.status(200).json({ success: true, count: currentCount, max: MAX_PER_DAY, reward: REWARD });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Atomic path A: same-day counter still under the cap.
    let result = await users.findOneAndUpdate(
      { telegramId: tgId, 'gigaAds.date': today, 'gigaAds.count': { $lt: MAX_PER_DAY } },
      { $inc: { spBalance: REWARD, 'gigaAds.count': 1 } },
      { returnDocument: 'after' }
    );
    let updated = result?.value || result;

    if (!updated) {
      if (user.gigaAds?.date === today) {
        // Same day, counter simply maxed out.
        return res.status(400).json({ error: `Daily limit reached (${MAX_PER_DAY}/${MAX_PER_DAY}). Come back tomorrow.` });
      }
      // Atomic path B: it's a new day — reset-and-credit in one update,
      // guarded so a stale doc can't be reset twice concurrently.
      result = await users.findOneAndUpdate(
        { telegramId: tgId, 'gigaAds.date': { $ne: today } },
        { $set: { 'gigaAds.date': today, 'gigaAds.count': 1 }, $inc: { spBalance: REWARD } },
        { returnDocument: 'after' }
      );
      updated = result?.value || result;
      if (!updated) {
        return res.status(400).json({ error: `Daily limit reached (${MAX_PER_DAY}/${MAX_PER_DAY}). Come back tomorrow.` });
      }
    }

    return res.status(200).json({ success: true, reward: REWARD, count: updated.gigaAds.count, max: MAX_PER_DAY });
  } catch (err) {
    console.error('adwatch.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
