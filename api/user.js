// FILE PATH: api/user.js
//
// Handles /api/user (register / fetch / heartbeat) plus two small
// action-routed extras that used to be their own files:
//   (channel/community join check REMOVED — no join requirement any more)
//   ?action=ipcheck    — GET,  was api/ipcheck.js
//   ?action=ipswitch   — POST, was the POST branch of api/ipcheck.js
// Merged in because Vercel's free (Hobby) plan caps a project at 12
// serverless functions total — every file under /api counts as one,
// so folding related small endpoints into the file they're closest to
// keeps headroom for future features instead of burning a slot each time.

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { toSp } from '../lib/constants.js';
import { tgSend } from '../lib/telegram.js';
import { recordSignupAndCheckVelocity, checkAndRecordFingerprint } from '../lib/security.js';
import {
  REFERRAL_VELOCITY_WINDOW_MS, REFERRAL_VELOCITY_THRESHOLD, IP_SIGNUP_VELOCITY_THRESHOLD,
} from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_ID;
const MAX_IP_SWITCHES = 2;

// Fields the browser never needs (anti-fraud data + big arrays) — stripped from every response.
const PRIVATE_FIELDS = ['_id', 'recentAdClaims', 'adWatchLog', 'fpHash', 'signupIp', 'multiAccountSiblings', 'refSignupLog',
  'botSuspectAt', 'botReviewAt', 'refVelocityAlertedAt', 'dailyTasksClaimed', 'promosUsed'];
function publicUser(u) {
  if (!u) return u;
  const o = { ...u };
  for (const f of PRIVATE_FIELDS) delete o[f];
  o.tasksDone = (u.completedTasks || []).length;
  delete o.completedTasks;
  return o;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}


// One-account-per-IP check. Shared by GET ?action=ipcheck and the POST
// register/open call, so the app needs only ONE request on startup.
// Returns null when there's no conflict, otherwise the conflict payload.
async function checkIpConflict(db, users, user, ip) {
  if (!ip || ip === 'unknown') return null;
  const ipRegistry = db.collection('ipRegistry');
  const existing = await ipRegistry.findOne({ ip });
  if (!existing) {
    await ipRegistry.updateOne({ ip }, { $set: { ip, telegramId: user.telegramId, updatedAt: new Date() } }, { upsert: true });
    return null;
  }
  if (existing.telegramId === user.telegramId) {
    // Touch updatedAt at most once a day (it only drives a 1-year TTL) — saves a DB write per open.
    const stale = !existing.updatedAt || Date.now() - new Date(existing.updatedAt).getTime() > 86400000;
    if (stale) await ipRegistry.updateOne({ ip }, { $set: { updatedAt: new Date() } });
    return null;
  }
  const owner = await users.findOne(
    { telegramId: existing.telegramId },
    { projection: { firstName: 1, username: 1, telegramId: 1 } }
  );
  return {
    conflict: true,
    owner: owner ? { firstName: owner.firstName, username: owner.username, telegramId: owner.telegramId } : null,
    switchesLeft: Math.max(0, MAX_IP_SWITCHES - (user.ipSwitchCount || 0)),
  };
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

    // ── GET /api/user?action=ipcheck ───────────────────────────
    if (req.method === 'GET' && action === 'ipcheck') {
      const telegramId = req.query.telegramId;
      const initData = req.query.initData || '';
      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }

      const tgId = String(telegramId);
      const ip = getClientIp(req);
      if (!ip || ip === 'unknown') return res.status(200).json({ success: true, conflict: false });

      const user = await users.findOne({ telegramId: tgId });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const ipRegistry = db.collection('ipRegistry');
      const existing = await ipRegistry.findOne({ ip });
      if (!existing) {
        await ipRegistry.updateOne({ ip }, { $set: { ip, telegramId: tgId, updatedAt: new Date() } }, { upsert: true });
        return res.status(200).json({ success: true, conflict: false });
      }
      if (existing.telegramId === tgId) {
        await ipRegistry.updateOne({ ip }, { $set: { updatedAt: new Date() } });
        return res.status(200).json({ success: true, conflict: false });
      }
      const owner = await users.findOne(
        { telegramId: existing.telegramId },
        { projection: { firstName: 1, username: 1, telegramId: 1 } }
      );
      return res.status(200).json({
        success: true,
        conflict: true,
        owner: owner ? { firstName: owner.firstName, username: owner.username, telegramId: owner.telegramId } : null,
        switchesLeft: Math.max(0, MAX_IP_SWITCHES - (user.ipSwitchCount || 0)),
      });
    }

    // ── POST /api/user  {action:'ipswitch'} ────────────────────
    if (req.method === 'POST' && action === 'ipswitch') {
      const { telegramId, initData } = req.body;
      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });
      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }
      const tgId = String(telegramId);
      const ip = getClientIp(req);
      if (!ip || ip === 'unknown') return res.status(400).json({ error: 'Could not determine connection.' });

      const user = await users.findOne({ telegramId: tgId });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const switchesUsed = user.ipSwitchCount || 0;
      if (switchesUsed >= MAX_IP_SWITCHES) {
        return res.status(403).json({ error: 'No account switches remaining for this account.' });
      }

      const ipRegistry = db.collection('ipRegistry');
      const existing = await ipRegistry.findOne({ ip });
      if (existing && existing.telegramId === tgId) {
        return res.status(200).json({ success: true, alreadyOwner: true });
      }

      const updated = await users.findOneAndUpdate(
        { telegramId: tgId, ipSwitchCount: { $lt: MAX_IP_SWITCHES } },
        { $set: { spBalance: 0, goldBalance: 0 }, $inc: { ipSwitchCount: 1 } },
        { returnDocument: 'after' }
      );
      if (!updated?.value && !updated) {
        return res.status(403).json({ error: 'No account switches remaining for this account.' });
      }

      await ipRegistry.updateOne({ ip }, { $set: { ip, telegramId: tgId, updatedAt: new Date() } }, { upsert: true });
      return res.status(200).json({ success: true, switchesLeft: Math.max(0, MAX_IP_SWITCHES - (switchesUsed + 1)) });
    }

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
        const ipConflict = await checkIpConflict(db, users, userDoc, getClientIp(req));
        if (ipConflict) return res.status(200).json({ success: true, ipConflict });
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
        ipSwitchCount: 0,
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

      // ── Raw-IP signup velocity: 15+ brand-new accounts from ONE IP inside 3 min = scripted farm → auto-lock ──
      try {
        const { count } = await recordSignupAndCheckVelocity(db, getClientIp(req));
        if (count >= IP_SIGNUP_VELOCITY_THRESHOLD) {
          await users.updateOne({ telegramId: tgId }, { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'ip_velocity' } });
          newUser.accountLocked = true;
          if (ADMIN_ID && count === IP_SIGNUP_VELOCITY_THRESHOLD) {
            tgSend(ADMIN_ID,
              `🚨 <b>IP signup velocity</b>\n\n<b>${count}</b> new accounts from one IP (<code>${getClientIp(req)}</code>) in 3 minutes. New accounts from this IP are auto-locked (no withdraw).\nOpen 🆕 Signup Bursts to review and unlock real users.`
            ).catch(() => {});
          }
        }
      } catch (e) { console.error('ip velocity error:', e?.message); }

      // ── Device fingerprint soft flag (admin review only) ──
      if (newUser.fpHash) await checkAndRecordFingerprint(db, tgId, newUser.fpHash).catch(() => {});

      const ipConflictNew = await checkIpConflict(db, users, newUser, getClientIp(req));
      if (ipConflictNew) return res.status(200).json({ success: true, ipConflict: ipConflictNew });
      return res.status(200).json({ success: true, user: publicUser(newUser), isNew: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('user.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
        }
