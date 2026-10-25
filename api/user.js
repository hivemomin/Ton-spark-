// FILE PATH: api/user.js
//
// Handles /api/user (register / fetch / heartbeat) plus two small
// action-routed extras that used to be their own files:
//   (channel/community join check REMOVED — no join requirement any more)
//   (one-account-per-IP gate REMOVED — Bangladesh SIM networks share IPs. Device fingerprint soft-flag is used instead.)
// Merged in because Vercel's free (Hobby) plan caps a project at 12
// serverless functions total — every file under /api counts as one,
// so folding related small endpoints into the file they're closest to
// keeps headroom for future features instead of burning a slot each time.

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { toSp, AD_NETWORKS } from '../lib/constants.js';
import { towerState } from '../lib/towers.js';
import { tgSend } from '../lib/telegram.js';
import { recordSignupAndCheckVelocity, checkAndRecordFingerprint } from '../lib/security.js';
import {
  REFERRAL_VELOCITY_WINDOW_MS, REFERRAL_VELOCITY_THRESHOLD, IP_SIGNUP_VELOCITY_THRESHOLD,
} from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_ID;

// Fields the browser never needs (anti-fraud data + big arrays) — stripped from every response.
const PRIVATE_FIELDS = ['_id', 'recentAdClaims', 'adWatchLog', 'fpHash', 'signupIp', 'multiAccountSiblings', 'refSignupLog',
  'botSuspectAt', 'botReviewAt', 'refVelocityAlertedAt', 'dailyTasksClaimed', 'promosUsed'];
function publicUser(u) {
  if (!u) return u;
  const o = { ...u };
  for (const f of PRIVATE_FIELDS) delete o[f];
  o.tasksDone = (u.completedTasks || []).length;
  delete o.completedTasks;
  // Everything the Home / Electricity / Ads / Invite screens need, sent ONCE with the login response
  // (all of it is already in the user document we just loaded → zero extra DB reads, zero extra requests).
  const now = Date.now();
  const today = new Date(now + 6 * 3600000).toISOString().slice(0, 10); // Bangladesh day
  o.refLink = `http://t.me/TonSparks_bot/startapp?startapp=${u.referCode}`;
  o.tw = towerState(u, now);
  o.ads = {};
  for (const [n, cfg] of Object.entries(AD_NETWORKS)) {
    o.ads[n] = { count: u[cfg.field]?.date === today ? (u[cfg.field].count || 0) : 0, max: cfg.max, reward: cfg.reward };
  }
  return o;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}


export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-spark-qu47.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action || req.body?.action;

  try {
    const db = await getDb();
    const users = db.collection('users');

    // ── GET /api/user?telegramId=xxx ───────────────────────────
    if (req.method === 'GET') {
      const { telegramId, initData } = req.query;
      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }

      const user = await users.findOne(
        { telegramId: String(telegramId) }
      );
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.status(200).json({ success: true, user: publicUser(user) });
    }

    // ── POST /api/user  (register / app-open heartbeat) ───────────
    if (req.method === 'POST') {
      const { telegramId, username, firstName, referCode, initData, fingerprint } = req.body;

      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }

      const tgId = String(telegramId);
      const existing = await users.findOne({ telegramId: tgId });

      if (existing) {
        const updated = await users.findOneAndUpdate(
          { telegramId: tgId },
          { $set: { lastActive: new Date() }, $inc: { appOpens: 1 } },
          { returnDocument: 'after' }
        );
        let userDoc = updated?.value || updated;
        // One-time migration: Gold was removed — any leftover Gold becomes SP (÷ 40), atomically.
        if ((userDoc.goldBalance || 0) > 0) {
          const g = userDoc.goldBalance;
          const mig = await users.findOneAndUpdate(
            { telegramId: tgId, goldBalance: g },
            { $inc: { spBalance: toSp(g) }, $set: { goldBalance: 0, goldMigratedAt: new Date() } },
            { returnDocument: 'after' }
          );
          userDoc = mig?.value || mig || userDoc;
        }
        // Device fingerprint soft-flag: only runs when this account's fingerprint changed (≈ once per device).
        if (fingerprint && typeof fingerprint === 'string' && userDoc.fpHash !== fingerprint) {
          await checkAndRecordFingerprint(db, tgId, fingerprint).catch(() => {});
          await users.updateOne({ telegramId: tgId }, { $set: { fpHash: fingerprint } }).catch(() => {});
        }
        return res.status(200).json({ success: true, user: publicUser(userDoc), isNew: false });
      }

      const myReferCode =
        'TEP' + tgId.slice(-5) + Math.random().toString(36).slice(2, 5).toUpperCase();

      const newUser = {
        telegramId: tgId,
        username: username || '',
        firstName: firstName || 'User',
        spBalance: 0,
        referCode: myReferCode,
        referredBy: null,
        totalReferred: 0,
        totalRefEarned: 0,
        totalRefEarnedSP: 0,
        dailyClaimLast: null,
        completedTasks: [],
        dailyTasksClaimed: [],
        totalAdsWatched: 0,
        promosUsed: [],
        isBanned: false,
        appOpens: 1,
        withdrawPending: false,
        signupIp: (getClientIp(req) && getClientIp(req) !== 'unknown') ? getClientIp(req) : null, // used by admin 🆕 Signup Bursts
        fpHash: (typeof fingerprint === 'string' && fingerprint.length >= 16 && fingerprint.length <= 128) ? fingerprint : null,
        createdAt: new Date(),
        lastActive: new Date(),
      };

      let referrerForAlert = null;
      if (referCode) {
        const referrer = await users.findOne({ referCode });
        if (referrer && referrer.telegramId !== tgId) {
          newUser.referredBy = referrer.telegramId;
          referrerForAlert = referrer;
        }
      }

      await users.insertOne(newUser);

      // ── Referral bookkeeping + velocity alert (NEWTUBE: 20+ signups under ONE referrer in 2 min) ──
      if (referrerForAlert) {
        const now = Date.now();
        const upd = await users.findOneAndUpdate(
          { telegramId: referrerForAlert.telegramId },
          { $inc: { totalReferred: 1 }, $push: { refSignupLog: { $each: [new Date(now)], $slice: -40 } } },
          { returnDocument: 'after' }
        );
        const ref = upd?.value || upd;
        const recent = (ref?.refSignupLog || []).filter(t => now - new Date(t).getTime() <= REFERRAL_VELOCITY_WINDOW_MS).length;
        if (ref && recent >= REFERRAL_VELOCITY_THRESHOLD && !ref.refVelocityAlertedAt && ADMIN_ID) {
          await users.updateOne({ telegramId: ref.telegramId }, { $set: { refVelocityAlertedAt: new Date() } });
          tgSend(ADMIN_ID,
            `🚨 <b>Referral signup velocity</b>\n\nReferrer <code>${ref.telegramId}</code> (${ref.firstName || '—'}) got <b>${recent}</b> signups within <b>${Math.round(REFERRAL_VELOCITY_WINDOW_MS / 60000)} minutes</b> — no real promotion delivers signups this fast.\nNothing was blocked — you decide.`,
            { reply_markup: { inline_keyboard: [[{ text: '🔒 Lock referrer', callback_data: `lock_${ref.telegramId}` }, { text: '👤 Profile', callback_data: `lookup_${ref.telegramId}` }], [{ text: '🚫 Ban referrer', callback_data: `ban_${ref.telegramId}` }]] } }
          ).catch(() => {});
        }
      }

      // ── Raw-IP signup velocity: ALERT ONLY. Bangladesh mobile networks share one IP between thousands of
      //    real users (CGNAT), so this never locks anybody — the admin reviews it in 🆕 Signup Bursts. ──
      try {
        const { count } = await recordSignupAndCheckVelocity(db, getClientIp(req));
        if (count === IP_SIGNUP_VELOCITY_THRESHOLD && ADMIN_ID) {
          tgSend(ADMIN_ID,
            `⚠️ <b>Many signups from one IP</b>\n\n<b>${count}</b> new accounts from one IP in 3 minutes. Could be a shared mobile network (normal in Bangladesh) or a farm. <b>Nobody was locked.</b>\nOpen 🆕 Signup Bursts to review.`
          ).catch(() => {});
        }
      } catch (e) { console.error('ip velocity error:', e?.message); }

      // ── Device fingerprint soft flag (admin review only) ──
      if (newUser.fpHash) await checkAndRecordFingerprint(db, tgId, newUser.fpHash).catch(() => {});

      return res.status(200).json({ success: true, user: publicUser(newUser), isNew: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('user.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
        }
