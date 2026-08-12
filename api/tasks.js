// FILE PATH: api/tasks.js

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const BOT_LINK = 'http://t.me/TonSparks_bot/startapp';
const BOT_TOKEN = process.env.BOT_TOKEN;

// Only these two are ever real-verified — must match bot.js's CHANNEL/COMMUNITY.
const OFFICIAL_TARGETS = {
  channel: '@Tonsparkpayout',
  group: '@Tonspark2',
};

// Valid task categories — admin panel assigns one of these to every task.
const CATEGORIES = ['daily', 'exclusive', 'task', 'partner'];

// Returns true / false for a definite result, or null if verification
// couldn't be performed (network/API error) — null is NOT treated as
// "not a member", so a transient Telegram API hiccup doesn't wrongly
// block someone who actually joined.
async function checkOfficialMembership(userId, target) {
  const chatId = OFFICIAL_TARGETS[target];
  if (!chatId) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`);
    const d = await r.json();
    if (!d.ok) return null; // API-level error (bad token, bot not admin, etc.) — don't block on this
    return ['member', 'administrator', 'creator'].includes(d.result?.status);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-spark-qu47.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const telegramId = req.query.telegramId || req.body?.telegramId;
  const initData = req.query.initData || req.body?.initData;

  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  // initData is now REQUIRED — previously optional, letting anyone read/claim
  // for any telegramId with no proof of identity.
  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const tasksCol = db.collection('tasks');

    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    if (req.method === 'GET') {
      const { type } = req.query;

      if (type === 'refer') {
        const referredUsers = await users
          .find({ referredBy: String(telegramId) })
          .project({ firstName: 1, username: 1, createdAt: 1, completedTasks: 1, totalAdsWatched: 1, referralTask10Paid: 1, referralAds20Paid: 1, _id: 0 })
          .toArray();

        const referredSummary = referredUsers.map(r => ({
          firstName: r.firstName, username: r.username, createdAt: r.createdAt,
          tasksDone: Math.min(r.completedTasks?.length || 0, 10),
          adsWatched: Math.min(r.totalAdsWatched || 0, 20),
          task10Valid: !!r.referralTask10Paid,
          ads20Valid: !!r.referralAds20Paid,
        }));

        return res.status(200).json({
          success: true,
          referCode: user.referCode,
          referLink: `${BOT_LINK}?startapp=${user.referCode}`,
          totalReferred: user.totalReferred || 0,
          totalRefEarned: user.totalRefEarned || 0,
          totalRefEarnedSP: user.totalRefEarnedSP || 0,
          referredUsers: referredSummary,
          rewards: { onJoin: 500, onTask10: 50, onAds20: 150, task10Req: 10, ads20Req: 20 },
        });
      }

      // category filter — daily | exclusive | task | partner (optional)
      const { category } = req.query;
      const query = { active: true };
      if (category && CATEGORIES.includes(category)) query.category = category;

      const allTasks = await tasksCol.find(query).toArray();
      const completedIds = user.completedTasks || [];
      const result = allTasks.map(t => ({
        id: t.id, title: t.title, reward: t.reward,
        link: t.link, type: t.type, category: t.category || 'task',
        completed: completedIds.includes(t.id),
      }));
      return res.status(200).json({ success: true, tasks: result });
    }

    if (req.method === 'POST') {
      const { taskId } = req.body;
      if (!taskId) return res.status(400).json({ error: 'taskId required' });

      const task = await tasksCol.findOne({ id: taskId, active: true });
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Only tasks pointing at OUR OWN official channel/group get real
      // verification. Telegram/YouTube/Facebook tasks for arbitrary
      // third-party links have no API to check against — those are
      // trust-based by necessity (task.officialTarget will be unset for them).
      if (task.type === 'api' && task.officialTarget) {
        const memberStatus = await checkOfficialMembership(telegramId, task.officialTarget);
        if (memberStatus === false) {
          return res.status(400).json({ error: 'Join the channel first, then try again.' });
        }
        // memberStatus === null → verification unavailable right now (API
        // error, not the user's fault) — falls through and credits normally
        // rather than falsely blocking a genuine member.
      }

      // "daily" category tasks reset every 24h instead of being one-time —
      // track them in dailyTasksClaimed with a date stamp instead of the
      // permanent completedTasks list.
      if (task.category === 'daily') {
        const today = new Date().toISOString().slice(0, 10);
        const claimKey = `${taskId}_${today}`;
        const result = await users.findOneAndUpdate(
          { telegramId: String(telegramId), dailyTasksClaimed: { $ne: claimKey } },
          { $inc: { goldBalance: task.reward }, $push: { dailyTasksClaimed: claimKey } },
          { returnDocument: 'after' }
        );
        const updated = result?.value || result;
        if (!updated) {
          return res.status(400).json({ error: 'Already claimed today. Come back tomorrow.' });
        }
        return res.status(200).json({ success: true, reward: task.reward });
      }

      // Atomic claim: only succeeds if this task isn't already in
      // completedTasks. Previously this was a separate read-then-write,
      // so two simultaneous claims for the same task could both succeed
      // and double-credit the reward.
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), completedTasks: { $ne: taskId } },
        { $inc: { goldBalance: task.reward }, $push: { completedTasks: taskId } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) {
        return res.status(400).json({ error: 'Task already completed.' });
      }

      // Referral Tier 2: referrer gets 50 SP once their referred user has
      // completed 10 (one-time) tasks. Fires once, guarded by
      // referralTask10Paid so it can't double-pay on a later task.
      if (
        (updated.completedTasks?.length || 0) >= 10 &&
        updated.referredBy &&
        !updated.referralTask10Paid
      ) {
        const flagged = await users.findOneAndUpdate(
          { telegramId: String(telegramId), referralTask10Paid: { $ne: true } },
          { $set: { referralTask10Paid: true } },
          { returnDocument: 'after' }
        );
        if (flagged?.value || flagged) {
          await users.updateOne(
            { telegramId: updated.referredBy },
            { $inc: { spBalance: 50, totalRefEarnedSP: 50 } }
          );
        }
      }

      return res.status(200).json({ success: true, reward: task.reward });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('tasks.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
            }
