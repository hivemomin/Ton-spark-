// FILE PATH: api/tasks.js

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { maybeAwardValidReferral } from '../lib/referral.js';
import { toSp, VALID_TASKS, VALID_ADS, REFERRAL_REWARD_SP, WITHDRAW_COMMISSION_PERCENT } from '../lib/constants.js';

const BOT_LINK = 'http://t.me/TonSparks_bot/startapp';
const BOT_TOKEN = process.env.BOT_TOKEN;

// Only these two are ever real-verified — must match bot.js's CHANNEL/COMMUNITY.
const OFFICIAL_TARGETS = {
  channel: '@Tonsparkpayout',
  group: '@Tonspark2',
};

// Valid task categories — admin panel assigns one of these to every task.
const CATEGORIES = ['daily', 'exclusive', 'task', 'partner'];

// Rewards are paid in SP. Tasks created before Gold was removed store a Gold number → converted (÷ 40).
// Tasks created from now on are saved with rewardUnit:'sp' and paid as-is.
const spOf = (t) => (t.rewardUnit === 'sp' ? Number(t.reward) || 0 : toSp(t.reward));

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
          .project({ firstName: 1, username: 1, createdAt: 1, completedTasks: 1, totalAdsWatched: 1, refereeValid: 1, _id: 0 })
          .toArray();

        const referredSummary = referredUsers.map(r => ({
          firstName: r.firstName, username: r.username, createdAt: r.createdAt,
          tasksDone: Math.min(r.completedTasks?.length || 0, VALID_TASKS),
          adsWatched: Math.min(r.totalAdsWatched || 0, VALID_ADS),
          // "Valid referral" — this friend has completed VALID_TASKS tasks
          // AND watched VALID_ADS ads, unlocking withdrawals above the free
          // tier for the referrer.
          isValidReferral: !!r.refereeValid,
        }));

        return res.status(200).json({
          success: true,
          referCode: user.referCode,
          referLink: `${BOT_LINK}?startapp=${user.referCode}`,
          totalReferred: user.totalReferred || 0,
          totalRefEarned: 0,
          totalRefEarnedSP: user.totalRefEarnedSP || 0,
          commissionEarnedSP: user.referralCommissionEarned || 0,
          validReferrals: user.validReferralCount || 0,
          referredUsers: referredSummary,
          rewards: {
            rewardSp: REFERRAL_REWARD_SP, commissionPercent: WITHDRAW_COMMISSION_PERCENT,
            validReferralTasksReq: VALID_TASKS, validReferralAdsReq: VALID_ADS,
          },
        });
      }

      // category filter — daily | exclusive | task | partner (optional)
      const { category } = req.query;
      const query = { active: true };
      if (category && CATEGORIES.includes(category)) query.category = category;

      const allTasks = await tasksCol.find(query).toArray();
      const completedIds = user.completedTasks || [];
      const result = allTasks.map(t => ({
        id: t.id, title: t.title, reward: spOf(t),
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
          { $inc: { spBalance: spOf(task) }, $push: { dailyTasksClaimed: claimKey } },
          { returnDocument: 'after' }
        );
        const updated = result?.value || result;
        if (!updated) {
          return res.status(400).json({ error: 'Already claimed today. Come back tomorrow.' });
        }
        return res.status(200).json({ success: true, reward: spOf(task) });
      }

      // Atomic claim: only succeeds if this task isn't already in
      // completedTasks. Previously this was a separate read-then-write,
      // so two simultaneous claims for the same task could both succeed
      // and double-credit the reward.
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), completedTasks: { $ne: taskId } },
        { $inc: { spBalance: spOf(task) }, $push: { completedTasks: taskId } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) {
        return res.status(400).json({ error: 'Task already completed.' });
      }

      // Referral: when this was the task that made the friend a "valid referral"
      // (10 tasks + 10 ads), the referrer gets +300 SP (lib/referral.js).
      await maybeAwardValidReferral(db, updated);

      return res.status(200).json({ success: true, reward: spOf(task) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('tasks.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
        }
