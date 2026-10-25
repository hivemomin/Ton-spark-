// lib/security.js — security helpers ported from NEWTUBE (botGuard / ipRegistry / fingerprintCheck).
//
//  • getClientIp               – real client IP from Vercel headers
//  • recordSignupAndCheckVelocity – N brand-new accounts from one IP in a few minutes = scripted farm
//  • checkAndRecordFingerprint – same device fingerprint on several accounts => soft flag for admin (never auto-bans)
//  • detectBotPattern / guardAdClaim – anti-script pattern detection for ad rewards (claims are
//                                 rate-limited, patterns that a human can't produce lock the account)

import { tgSend } from './telegram.js';
import { IP_SIGNUP_VELOCITY_WINDOW_MS, MIN_AD_GAP_MS } from './constants.js';

const ADMIN_ID = process.env.ADMIN_ID;

export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ── signup velocity per raw IP ────────────────────────────────
// COLLECTION ipSignupVelocity { _id: ip, recentSignups: [Date], updatedAt }
export async function recordSignupAndCheckVelocity(db, ip) {
  if (!ip || ip === 'unknown') return { count: 0 };
  const now = new Date();
  const r = await db.collection('ipSignupVelocity').findOneAndUpdate(
    { _id: ip },
    { $push: { recentSignups: { $each: [now], $slice: -50 } }, $set: { updatedAt: now } },
    { upsert: true, returnDocument: 'after' }
  );
  const entry = r?.value !== undefined ? r.value : r;
  const start = Date.now() - IP_SIGNUP_VELOCITY_WINDOW_MS;
  const count = (entry?.recentSignups || []).filter(t => new Date(t).getTime() >= start).length;
  return { count };
}

// ── device fingerprint (soft flag only) ───────────────────────
// COLLECTION fingerprints { _id: hash, telegramIds: [..], firstSeenAt, lastSeenAt }
export async function checkAndRecordFingerprint(db, telegramId, fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'string' || fingerprint.length < 16 || fingerprint.length > 128) {
    return { flagged: false }; // no fingerprint sent → silently skip, never block
  }
  const col = db.collection('fingerprints');
  let doc;
  const run = () => col.findOneAndUpdate(
    { _id: fingerprint },
    { $addToSet: { telegramIds: telegramId }, $set: { lastSeenAt: new Date() }, $setOnInsert: { firstSeenAt: new Date() } },
    { upsert: true, returnDocument: 'before' }
  );
  try { doc = await run(); }
  catch (err) { if (err?.code === 11000) doc = await run(); else throw err; }
  const before = doc?.value !== undefined ? doc.value : doc;
  const siblings = (before?.telegramIds || []).filter(id => id !== telegramId);
  if (siblings.length) {
    await db.collection('users').updateOne(
      { telegramId },
      { $set: { multiAccountFlag: true, multiAccountSiblings: siblings.slice(0, 20) } }
    );
    return { flagged: true, siblings };
  }
  return { flagged: false };
}

// ══════════════════════════════════════════════════════════════
// AD CLAIM BOT GUARD (NEWTUBE lib/botGuard.js, adapted)
// user.recentAdClaims = [{ s: adStartMs, c: claimMs, w: watchSeconds }]  (last 8)
//   Rule A  5 ads in a row, each started ≤1.5s after the previous claim  (the app UI cannot do this)
//   Rule B  8 ads with a metronome-like cycle (spread ≤ 1s)
//   Rule C  5 ads with near-identical watch time (spread ≤ 0.3s)
//   Rule E  5 ads with metronome-like pauses (spread ≤ 0.3s)
// Only an evidence-scored "Likely script" (Rule A + young account etc.) is auto-locked.
// Everything else just pings the admin (max once / 24h / user) and the claim still pays.
// ══════════════════════════════════════════════════════════════
export const AD_BOT_SAMPLE_SIZE = 5;
export const AD_BOT_MAX_IDLE_SECONDS = 1.5;
export const AD_BOT_METRONOME_SAMPLES = 8;
export const AD_BOT_CYCLE_SPREAD_SECONDS = 1;
export const AD_BOT_CYCLE_MAX_SECONDS = 40;
export const AD_BOT_WATCH_SPREAD_SECONDS = 0.3;
export const AD_BOT_GAP_SPREAD_SECONDS = 0.3;
export const AD_BOT_GAP_MAX_SECONDS = 20;
export const AD_CLAIM_HISTORY_KEEP = 8;
const REVIEW_THROTTLE_MS = 24 * 3600 * 1000;

export function detectBotPattern(samples) {
  const n = samples.length;
  if (n >= AD_BOT_SAMPLE_SIZE) {
    const last = samples.slice(-AD_BOT_SAMPLE_SIZE);
    if (last.every((x, i) => i === 0 || (x.s - last[i - 1].c) / 1000 <= AD_BOT_MAX_IDLE_SECONDS))
      return { rule: 'A', detail: `${AD_BOT_SAMPLE_SIZE} ads in a row, each started ≤${AD_BOT_MAX_IDLE_SECONDS}s after the previous claim (the app UI cannot do that)` };
    const ws = last.map(x => x.w);
    if (Math.max(...ws) - Math.min(...ws) <= AD_BOT_WATCH_SPREAD_SECONDS)
      return { rule: 'C', detail: `${AD_BOT_SAMPLE_SIZE} ads with near-identical watch time (${Math.min(...ws).toFixed(1)}–${Math.max(...ws).toFixed(1)}s)` };
    const gaps = last.slice(1).map((x, i) => (x.s - last[i].c) / 1000);
    if (Math.max(...gaps) <= AD_BOT_GAP_MAX_SECONDS && Math.max(...gaps) - Math.min(...gaps) <= AD_BOT_GAP_SPREAD_SECONDS)
      return { rule: 'E', detail: `${AD_BOT_SAMPLE_SIZE} ads with metronome-like pauses (${Math.min(...gaps).toFixed(1)}–${Math.max(...gaps).toFixed(1)}s)` };
  }
  if (n >= AD_BOT_METRONOME_SAMPLES) {
    const last = samples.slice(-AD_BOT_METRONOME_SAMPLES);
    const cycles = last.slice(1).map((x, i) => (x.c - last[i].c) / 1000);
    if (Math.max(...cycles) <= AD_BOT_CYCLE_MAX_SECONDS && Math.max(...cycles) - Math.min(...cycles) <= AD_BOT_CYCLE_SPREAD_SECONDS)
      return { rule: 'B', detail: `${AD_BOT_METRONOME_SAMPLES} ads with a metronome-like cycle (${Math.min(...cycles).toFixed(1)}–${Math.max(...cycles).toFixed(1)}s apart)` };
  }
  return null;
}

function buildEvidence(u, hit, samples) {
  const ageDays = u.createdAt ? Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000) : 0;
  const claims = samples.slice(-6);
  const watch = claims.map(x => `${x.w}s`).join(', ') || '—';
  const gaps = claims.slice(1).map((x, i) => `${Math.max(0, (x.s - claims[i].c) / 1000).toFixed(1)}s`).join(', ') || '—';
  let script = 0, real = 0;
  if (hit.rule === 'A') script += 3;
  if (ageDays < 2) script += 1;
  if ((u.totalAdsWatched || 0) > 80 && ageDays < 3) script += 1;
  if (ageDays >= 7) real += 1;
  if (u.refereeValid) real += 1;
  if ((u.totalReferred || 0) > 0) real += 1;
  if (hit.rule === 'B') real += 1;
  const likelyScript = script >= 3 && script > real;
  const hint = likelyScript ? '🔴 Likely script' : real >= 3 && real > script ? '🟢 Likely real user' : '🟡 Unclear — check profile';
  return {
    likelyScript,
    text:
      `\n<b>Evidence</b>\nName: ${u.firstName || '—'} (@${u.username || 'none'})\n` +
      `Account age: ${ageDays}d · Gold: ${Math.floor(u.goldBalance || 0)} · SP: ${u.spBalance || 0}\n` +
      `Ads lifetime: ${u.totalAdsWatched || 0} · Multi-account flag: ${u.multiAccountFlag ? 'YES 🚩' : 'No'}\n` +
      `Tap→claim times: ${watch}\nGaps between ads: ${gaps}\nHint: <b>${hint}</b> (script ${script} / real ${real})\n`,
  };
}

// Returns true ONLY when the account is locked (caller must then reject the claim).
async function lockForBotPattern(db, user, hit, samples) {
  const users = db.collection('users');
  const id = user.telegramId;
  if (user.accountLocked) return true;
  if (user.isBanned) return true;
  await users.updateOne({ telegramId: id }, { $inc: { botSuspectCount: 1 }, $set: { botSuspectAt: new Date() } }).catch(() => {});
  let ev = { text: '', likelyScript: false };
  try { ev = buildEvidence(user, hit, samples); } catch { /* best effort */ }

  if (ev.likelyScript) {
    const res = await users.findOneAndUpdate(
      { telegramId: id, accountLocked: { $ne: true } },
      { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'bot_pattern' } }
    );
    if (res && ADMIN_ID) {
      tgSend(ADMIN_ID,
        `🤖 <b>Bot / script pattern detected (ads)</b>\n\nUser: <code>${id}</code>\nRule ${hit.rule}: ${hit.detail}\n${ev.text}\nThe account is now 🔒 locked (no withdraw, no ad rewards).`,
        { reply_markup: { inline_keyboard: [[{ text: '🔓 Unlock', callback_data: `unlock_${id}` }, { text: '👤 Profile', callback_data: `lookup_${id}` }], [{ text: '🚫 Ban', callback_data: `ban_${id}` }]] } }
      ).catch(() => {});
    }
    return !!res;
  }

  const cutoff = new Date(Date.now() - REVIEW_THROTTLE_MS);
  const mark = await users.updateOne(
    { telegramId: id, $or: [{ botReviewAt: { $exists: false } }, { botReviewAt: { $lt: cutoff } }] },
    { $set: { botReviewAt: new Date() } }
  );
  if (mark?.modifiedCount > 0 && ADMIN_ID) {
    tgSend(ADMIN_ID,
      `⚠️ <b>Suspicious ad pattern — NOT locked</b>\n\nUser: <code>${id}</code>\nRule ${hit.rule}: ${hit.detail}\n${ev.text}\nNothing was blocked. Lock the account yourself if you think it is a script.`,
      { reply_markup: { inline_keyboard: [[{ text: '🔒 Lock', callback_data: `lock_${id}` }, { text: '👤 Profile', callback_data: `lookup_${id}` }], [{ text: '🚫 Ban', callback_data: `ban_${id}` }]] } }
    ).catch(() => {});
  }
  return false;
}

// Called by adwatch.js / tower.js right BEFORE crediting a reward.
//   user      – user document (already loaded)
//   watchMs   – client-reported tap→finish time (clamped here; used only for pattern rules)
// Returns { ok:true, entry } or { ok:false, status, error }
export async function guardAdClaim(db, user, watchMs) {
  if (user.accountLocked && user.accountLockedReason === 'bot_pattern')
    return { ok: false, status: 403, error: 'Account locked for suspicious activity. Contact support.' };

  const now = Date.now();
  const log = Array.isArray(user.recentAdClaims) ? user.recentAdClaims : [];
  const prev = log[log.length - 1];
  if (prev && now - prev.c < MIN_AD_GAP_MS)
    return { ok: false, status: 429, error: 'Please wait a few seconds before the next ad.' };

  const w = Math.min(Math.max(Number(watchMs) || 0, 0), 180000) / 1000;
  const entry = { s: Math.round(now - w * 1000), c: now, w: Math.round(w * 10) / 10 };
  const samples = [...log, entry].slice(-AD_CLAIM_HISTORY_KEEP);

  const hit = detectBotPattern(samples);
  if (hit) {
    const locked = await lockForBotPattern(db, user, hit, samples);
    if (locked) return { ok: false, status: 403, error: 'Account locked for suspicious activity. Contact support.' };
  }
  return { ok: true, entry, samples };
}

// Persist the history (call after a successful reward). Single small $set.
export async function saveAdClaimLog(db, telegramId, samples) {
  await db.collection('users').updateOne({ telegramId }, { $set: { recentAdClaims: samples } }).catch(() => {});
}
