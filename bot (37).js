// FILE PATH: api/bot.js

import { getDb } from '../lib/mongodb.js';
import { handleSignupCallback } from '../lib/signupBursts.js';
import { WITHDRAW_COMMISSION_PERCENT } from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = 'http://t.me/TonSparks_bot/startapp';
const APP_URL = 'https://ton-spark-qu47.vercel.app';
const PAYMENT_CHANNEL = 'https://t.me/Tonsparkpayouts'; // payment proofs channel (no join required to use the app)
const START_PHOTO = 'https://kommodo.ai/i/mgdYlC0uQTN9sE1lBKpZ';

// Task categories the admin can assign — must match tasks.js CATEGORIES.
const CATEGORIES = [
  { key: 'daily',     label: '🔁 Daily' },
  { key: 'exclusive', label: '⭐ Exclusive' },
  { key: 'task',      label: '📋 Task' },
  { key: 'partner',   label: '🤝 Partner' },
];
const catLabel = (key) => (CATEGORIES.find(c => c.key === key) || {}).label || key;

// Multi-step state storage
const state = {};

// ── Telegram helpers ────────────────────────────────────────────
async function tgApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const send = (chatId, text, extra = {}) =>
  tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

const sendPhoto = (chatId, photo, caption, extra = {}) =>
  tgApi('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });

const edit = (chatId, msgId, text, extra = {}) =>
  tgApi('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', ...extra });

const answer = (id, text = '') =>
  tgApi('answerCallbackQuery', { callback_query_id: id, text });

async function runBroadcast(chatId, usersCol, text, replyMarkup) {
  const all = await usersCol.find({}, { projection: { telegramId: 1 } }).toArray();
  let sent = 0, failed = 0;
  await send(chatId, `📢 Broadcasting to <b>${all.length}</b> users...`);
  const extra = replyMarkup ? { reply_markup: replyMarkup } : {};
  for (const u of all) {
    try { await send(u.telegramId, `📢 <b>Ton Spark Electricity Update</b>\n\n${text}`, extra); sent++; } catch { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  await send(chatId, `✅ Done! Sent: <b>${sent}</b> | Failed: <b>${failed}</b>`, { reply_markup: adminKb });
}

// ── Admin keyboard ──────────────────────────────────────────────
const adminKb = {
  inline_keyboard: [
    [{ text: '📊 Dashboard',     callback_data: 'a_stats'       }, { text: '💸 Withdrawals',   callback_data: 'a_pending'     }],
    [{ text: '👤 User Lookup',   callback_data: 'a_user'        }, { text: '🏆 Top Referrers', callback_data: 'a_toprefer'   }],
    [{ text: '📅 Weekly Refer',  callback_data: 'a_weekly'      }, { text: '📋 Add Task',      callback_data: 'a_addtask'    }],
    [{ text: '📝 Task List',     callback_data: 'a_tasklist'    }, { text: '🎟 Add Promo',     callback_data: 'a_addpromo'   }],
    [{ text: '📢 Broadcast',     callback_data: 'a_broadcast'   }, { text: '🆕 Signup Bursts', callback_data: 'a_signups'    }],
    [{ text: '💰 Send SP',       callback_data: 'a_sendsp'      }],
  ]
};


// ── Shared user-profile text/keyboard (User Lookup + 👤 Profile buttons on alerts) ──
async function userInfoText(u, withdrawals) {
  const wCount = await withdrawals.countDocuments({ telegramId: u.telegramId });
  const age = u.createdAt ? Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000) : 0;
  return (
    `👤 <b>User Info</b>\n\n` +
    `ID: <code>${u.telegramId}</code>\n` +
    `Name: <b>${u.firstName}</b> (@${u.username || 'none'})\n` +
    `💰 SP: <b>${Number(u.spBalance || 0).toLocaleString()}</b>\n` +
    `👥 Referrals: <b>${u.totalReferred || 0}</b> (valid ${u.validReferralCount || 0}) · referred by: <code>${u.referredBy || '—'}</code>\n` +
    `🎁 Referral earned: <b>${u.totalRefEarnedSP || 0} SP</b> + commission <b>${u.referralCommissionEarned || 0} SP</b>\n` +
    `📺 Ads: <b>${u.totalAdsWatched || 0}</b> · ✅ Tasks: <b>${(u.completedTasks || []).length}</b>\n` +
    `📤 Withdrawals: <b>${wCount}</b>\n` +
    `🚩 Multi-account flag: <b>${u.multiAccountFlag ? 'YES' : 'No'}</b> · 🤖 Bot hits: <b>${u.botSuspectCount || 0}</b>\n` +
    `🔒 Locked: <b>${u.accountLocked ? 'YES (' + (u.accountLockedReason || '?') + ')' : 'No'}</b> · 🚫 Banned: <b>${u.isBanned ? 'YES ⛔' : 'No ✅'}</b>\n` +
    `🌐 Signup IP: <code>${u.signupIp || '—'}</code>\n` +
    `📅 Joined: ${new Date(u.createdAt).toLocaleDateString()} (${age}d ago)`
  );
}
const userInfoKb = (u) => ({ inline_keyboard: [
  [u.isBanned ? { text: '✅ Unban User', callback_data: `unban_${u.telegramId}` } : { text: '🚫 Ban User', callback_data: `ban_${u.telegramId}` }],
  [u.accountLocked ? { text: '🔓 Unlock', callback_data: `unlock_${u.telegramId}` } : { text: '🔒 Lock', callback_data: `lock_${u.telegramId}` }],
  [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
] });

const backKb = { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };

// Prev / page / Next row + Back button for paginated admin lists. `base` = 'a_pending' → a_pending_p2 …
function pagerKb(base, page, pages) {
  const row = [];
  if (page > 1) row.push({ text: '◀️ Prev', callback_data: `${base}_p${page - 1}` });
  row.push({ text: `${page}/${pages}`, callback_data: `${base}_p${page}` });
  if (page < pages) row.push({ text: 'Next ▶️', callback_data: `${base}_p${page + 1}` });
  return { inline_keyboard: [row, [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  // ── Webhook authenticity check ───────────────────────────────
  // Without this, every "admin-only" branch below is gated purely on
  // `fromId === ADMIN_ID`, and fromId comes straight out of req.body —
  // which is just whatever JSON is POSTed here. That's fine as long as
  // ONLY Telegram can reach this URL with real updates, but the URL
  // itself (APP_URL + /api/bot) is guessable, and ADMIN_ID is a plain
  // numeric Telegram user ID, not a real secret. Anyone who works both
  // out could POST a forged update claiming to be the admin and walk
  // straight into /sendgold, /sendsp, withdrawal approval, ban/unban —
  // i.e. mint themselves unlimited Gold/SP. Telegram supports setting a
  // secret_token on the webhook (via setWebhook) that it then echoes
  // back on every real call in the X-Telegram-Bot-Api-Secret-Token
  // header; a forged POST from anywhere else won't have it.
  //
  // Set TELEGRAM_WEBHOOK_SECRET in the environment to a long random
  // string, then re-register the webhook with that same value:
  //   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<APP_URL>/api/bot&secret_token=<THAT_STRING>
  // Until TELEGRAM_WEBHOOK_SECRET is set, this check is skipped (so an
  // existing webhook already pointed here keeps working) — but that
  // means the admin-impersonation hole above stays open until it's set
  // AND the webhook is re-registered with the matching secret_token.
  const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (WEBHOOK_SECRET) {
    const gotToken = req.headers['x-telegram-bot-api-secret-token'];
    if (gotToken !== WEBHOOK_SECRET) {
      console.warn('bot.js: rejected webhook call with missing/invalid secret token');
      return res.status(401).json({ ok: false });
    }
  }

  const update = req.body;

  // getDb() was previously called unguarded here — if MongoDB is
  // unreachable (bad MONGODB_URI, Atlas IP whitelist, paused cluster,
  // etc.) this line throws, the whole function crashes, and Telegram
  // never gets a reply. From the user's side that looks exactly like
  // "/start does nothing." Wrapping it means we log the real reason
  // and still return 200 so Telegram doesn't hammer us with retries.
  let db;
  try {
    db = await getDb();
  } catch (err) {
    console.error('bot.js getDb() failed:', err);
    // Tell the admin directly in Telegram what broke — without this,
    // a DB failure is invisible: Telegram gets its 200 OK so it never
    // shows an error, and the user who sent /start just gets silence.
    if (ADMIN_ID) {
      try {
        await tgApi('sendMessage', {
          chat_id: ADMIN_ID,
          text: `⚠️ <b>Database connection failed</b>\n\n<code>${String(err?.message || err).slice(0, 500)}</code>`,
          parse_mode: 'HTML',
        });
      } catch { /* if even this fails, nothing more we can do here */ }
    }
    return res.status(200).json({ ok: true });
  }
  const users      = db.collection('users');
  const withdrawals = db.collection('withdrawals');
  const tasks      = db.collection('tasks');
  const promos     = db.collection('promos');

  // ══════════════════════════════════════════════════════════════
  // CALLBACK QUERY
  // ══════════════════════════════════════════════════════════════
  if (update.callback_query) {
    const cb     = update.callback_query;
    const fromId = String(cb.from.id);
    const data   = cb.data;
    const chatId = cb.message.chat.id;
    const msgId  = cb.message.message_id;

    await answer(cb.id);

    // All callbacks below — admin only
    if (fromId !== String(ADMIN_ID)) return res.status(200).json({ ok: true });

    // ── 🆕 Signup Bursts (a_signups · sb_*) — lib/signupBursts.js ──
    if (data === 'a_signups' || data.startsWith('sb_')) {
      const handled = await handleSignupCallback(data, { db, chatId, msgId, send, edit, backKb });
      if (handled) return res.status(200).json({ ok: true });
    }

    // ── Lock / Unlock / Profile buttons from the security alerts ──
    if (data.startsWith('lock_') || data.startsWith('unlock_')) {
      const isLock = data.startsWith('lock_');
      const target = data.replace('unlock_', '').replace('lock_', '');
      await users.updateOne({ telegramId: target }, isLock
        ? { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'admin' } }
        : { $set: { accountLocked: false, botSuspectCount: 0 }, $unset: { accountLockedAt: '', accountLockedReason: '' } });
      await send(chatId, `${isLock ? '🔒 Locked' : '🔓 Unlocked'}: <code>${target}</code>`, { reply_markup: backKb });
      return res.status(200).json({ ok: true });
    }
    if (data.startsWith('lookup_')) {
      const target = data.replace('lookup_', '');
      const u = await users.findOne({ telegramId: target });
      if (!u) { await send(chatId, '❌ User not found.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
      await send(chatId, await userInfoText(u, withdrawals), { reply_markup: userInfoKb(u) });
      return res.status(200).json({ ok: true });
    }

    // ── Approve / Reject withdrawal ───────────────────────────
    if (data.startsWith('wd_approve_') || data.startsWith('wd_reject_')) {
      const approve = data.startsWith('wd_approve_');
      const wid = data.replace('wd_approve_', '').replace('wd_reject_', '');
      const { ObjectId } = await import('mongodb');
      const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
      if (!w || w.status !== 'pending') {
        await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Already processed', show_alert: true });
        return res.status(200).json({ ok: true });
      }
      // Atomic status flip first — a double-tap on Approve can never pay the commission twice.
      const flipped = await withdrawals.findOneAndUpdate(
        { _id: new ObjectId(wid), status: 'pending' },
        { $set: { status: approve ? 'approved' : 'rejected', processedAt: new Date() } }
      );
      if (!(flipped?.value || flipped)) {
        await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Already processed', show_alert: true });
        return res.status(200).json({ ok: true });
      }
      let commission = 0;
      if (!approve) {
        await users.updateOne({ telegramId: w.telegramId }, { $inc: { spBalance: w.spAmount }, $set: { withdrawPending: false } });
      } else {
        await users.updateOne({ telegramId: w.telegramId }, { $set: { withdrawPending: false } });
        // ── 15% referral commission (NEWTUBE): paid to the referrer on every approved withdrawal, gross SP amount ──
        const referrerId = w.referrerId || (await users.findOne({ telegramId: w.telegramId }, { projection: { referredBy: 1 } }))?.referredBy;
        if (referrerId) {
          commission = Math.floor((w.spAmount || 0) * (WITHDRAW_COMMISSION_PERCENT / 100));
          if (commission > 0) {
            const paid = await users.findOneAndUpdate(
              { telegramId: referrerId, isBanned: { $ne: true }, accountLocked: { $ne: true } },
              { $inc: { spBalance: commission, referralCommissionEarned: commission } }
            );
            if (paid) {
              send(referrerId, `💰 <b>Referral Commission!</b>\n\nOne of your referrals just withdrew ${(w.spAmount || 0).toLocaleString()} SP.\nYou earned <b>+${commission.toLocaleString()} SP</b> (${WITHDRAW_COMMISSION_PERCENT}% commission) ⚡`).catch(() => {});
            } else commission = 0;
          }
          await withdrawals.updateOne({ _id: new ObjectId(wid) }, { $set: { referrerCommissionPaid: commission } });
        }
      }
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: approve ? '✅ Approved' : '❌ Rejected', show_alert: true });
      const notif = approve
        ? `✅ <b>Withdrawal Approved!</b>\n\n💰 ${w.spAmount} SP → ${w.usdtAmount} USDT\n📤 ${w.method}\n📍 <code>${w.address}</code>\n\n📢 Payment proofs: ${PAYMENT_CHANNEL}`
        : `❌ <b>Withdrawal Rejected.</b>\nYour ${w.spAmount} SP has been refunded.`;
      await send(w.telegramId, notif);
      return res.status(200).json({ ok: true });
    }

    // ── Ban / Unban from user lookup ──────────────────────────
    if (data.startsWith('ban_') || data.startsWith('unban_')) {
      const isBan  = data.startsWith('ban_');
      const target = data.replace('ban_', '').replace('unban_', '');
      await users.updateOne({ telegramId: target }, { $set: { isBanned: isBan } });
      await edit(chatId, msgId, `${isBan ? '🚫 Banned' : '✅ Unbanned'}: <code>${target}</code>`, { reply_markup: backKb });
      return res.status(200).json({ ok: true });
    }

    // ── Task category selection (step 2/6) ─────────────────────
    if (data.startsWith('task_cat_')) {
      const s = state[fromId];
      if (!s || s.step !== 'task_category') return res.status(200).json({ ok: true });
      const catKey = data.replace('task_cat_', '');
      if (!CATEGORIES.some(c => c.key === catKey)) return res.status(200).json({ ok: true });
      s.category = catKey;
      s.step = 'task_link';
      await edit(chatId, msgId, `📋 <b>Step 3/6</b>\n\nCategory: ✅ <b>${catLabel(catKey)}</b>\n\nEnter <b>task link</b> (or type <code>none</code>):`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    // ── Task type selection ───────────────────────────────────
    if (data === 'task_type_api' || data === 'task_type_none') {
      const s = state[fromId];
      if (!s || s.step !== 'task_type') return res.status(200).json({ ok: true });
      s.type = data === 'task_type_api' ? 'api' : 'none';

      if (s.type === 'api') {
        // Real verification only works against OUR OWN official channel/group —
        // force the admin to pick one of those two rather than typing an
        // arbitrary link, so the check always points at something the bot
        // can actually verify.
        s.step = 'task_official_target';
        await edit(chatId, msgId, '📡 Verify against which official target?', { reply_markup: { inline_keyboard: [
          [{ text: '📢 Official Channel', callback_data: 'task_target_channel' }],
          [{ text: '👥 Official Group',   callback_data: 'task_target_group' }],
          [{ text: '◀️ Cancel', callback_data: 'a_menu' }],
        ]}});
        return res.status(200).json({ ok: true });
      }

      s.step = 'task_confirm';
      const preview =
        `📋 <b>Task Preview:</b>\n\n` +
        `Category: <b>${catLabel(s.category)}</b>\n` +
        `Title: <b>${s.title}</b>\n` +
        `Link: ${s.link || 'none'}\n` +
        `Reward: <b>${s.reward} SP</b>\n` +
        `Max: <b>${s.maxCompletions || 'Unlimited'}</b>\n` +
        `Type: <b>${s.type}</b> (trust-based, no verification)\n\n` +
        `Type <b>CONFIRM</b> to save:`;
      await edit(chatId, msgId, preview, { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    // ── Task official-target selection (channel vs group) ─────
    if (data === 'task_target_channel' || data === 'task_target_group') {
      const s = state[fromId];
      if (!s || s.step !== 'task_official_target') return res.status(200).json({ ok: true });
      s.officialTarget = data === 'task_target_channel' ? 'channel' : 'group';
      s.step = 'task_confirm';
      const preview =
        `📋 <b>Task Preview:</b>\n\n` +
        `Category: <b>${catLabel(s.category)}</b>\n` +
        `Title: <b>${s.title}</b>\n` +
        `Link: ${s.link || 'none'}\n` +
        `Reward: <b>${s.reward} SP</b>\n` +
        `Max: <b>${s.maxCompletions || 'Unlimited'}</b>\n` +
        `Type: <b>api</b> — verified against official ${s.officialTarget}\n\n` +
        `⚠️ Make sure the bot is admin in that ${s.officialTarget}!\n\n` +
        `Type <b>CONFIRM</b> to save:`;
      await edit(chatId, msgId, preview, { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    // ── Promo currency selection ───────────────────────────────
    if (data === 'promo_cur_gold' || data === 'promo_cur_sp') {
      const s = state[fromId];
      if (!s || s.step !== 'promo_currency') return res.status(200).json({ ok: true });
      s.currency = 'sp';
      s.step = 'promo_reward';
      await edit(chatId, msgId, `Currency: <b>SP</b>\n\nEnter <b>reward</b> per code:`);
      return res.status(200).json({ ok: true });
    }

    // ── Admin menu buttons ────────────────────────────────────
    if (data === 'a_menu') {
      await edit(chatId, msgId, '👑 <b>Ton Spark Electricity — Admin Panel</b>\n\nSelect an option:', { reply_markup: adminKb });
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_stats') {
      const total   = await users.countDocuments();
      const today   = new Date(); today.setHours(0,0,0,0);
      const newToday = await users.countDocuments({ createdAt: { $gte: today } });
      const pendingW = await withdrawals.countDocuments({ status: 'pending' });
      const taskCnt = await tasks.countDocuments({ active: true });
      const lockedCnt = await users.countDocuments({ accountLocked: true });
      const flaggedCnt = await users.countDocuments({ multiAccountFlag: true });
      const spAgg   = await users.aggregate([{ $group: { _id: null, t: { $sum: '$spBalance' } } }]).toArray();
      await edit(chatId, msgId,
        `📊 <b>Dashboard</b>\n\n` +
        `👥 Total Users: <b>${total}</b>\n` +
        `🆕 Today Joined: <b>${newToday}</b>\n` +
        `📋 Active Tasks: <b>${taskCnt}</b>\n` +
        `⏳ Pending Withdrawals: <b>${pendingW}</b>\n` +
        `🔒 Locked accounts: <b>${lockedCnt}</b> · 🚩 Multi-account flags: <b>${flaggedCnt}</b>\n` +
        `💰 Total SP held: <b>${Math.floor(spAgg[0]?.t || 0).toLocaleString()}</b>`,
        { reply_markup: backKb }
      );
      return res.status(200).json({ ok: true });
    }

    // ── 💸 Pending withdrawals — PAGINATED (5 per page, oldest first) ──
    const pendM = data.match(/^a_pending(?:_p(\d+))?$/);
    if (pendM) {
      const PER = 5;
      const total = await withdrawals.countDocuments({ status: 'pending' });
      if (!total) {
        await edit(chatId, msgId, '✅ No pending withdrawals.', { reply_markup: backKb });
        return res.status(200).json({ ok: true });
      }
      const pages = Math.max(1, Math.ceil(total / PER));
      const page = Math.min(Math.max(parseInt(pendM[1], 10) || 1, 1), pages);
      const list = await withdrawals.find({ status: 'pending' }).sort({ createdAt: 1 }).skip((page - 1) * PER).limit(PER).toArray();
      await edit(chatId, msgId, `💸 <b>${total} pending withdrawal(s)</b> · page ${page}/${pages}\nDetails below ⬇️`, { reply_markup: pagerKb('a_pending', page, pages) });
      for (const w of list) {
        await send(chatId,
          `💸 <b>Withdrawal Request</b>\n\n` +
          `👤 <code>${w.telegramId}</code> (@${w.username || '?'})\n` +
          `💰 ${w.spAmount} SP → <b>${w.usdtAmount} USDT</b>\n` +
          `📤 Method: <b>${w.method}</b>\n` +
          `📍 Address: <code>${w.address}</code>\n` +
          `📅 ${new Date(w.createdAt).toLocaleString()}`,
          { reply_markup: { inline_keyboard: [[
            { text: '✅ Approve', callback_data: `wd_approve_${w._id}` },
            { text: '❌ Reject',  callback_data: `wd_reject_${w._id}`  },
          ]]}}
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_user') {
      state[fromId] = { step: 'user_lookup' };
      await edit(chatId, msgId, '👤 Send the <b>Telegram numeric ID</b> of the user:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_toprefer') {
      const top = await users.find().sort({ totalReferred: -1 }).limit(20).toArray();
      let out = '🏆 <b>All-time Top 20 Referrers</b>\n\n';
      top.forEach((u, i) => { out += `${i+1}. @${u.username || u.firstName} — <b>${u.totalReferred || 0}</b> refs\n`; });
      await edit(chatId, msgId, out || 'No data yet.', { reply_markup: backKb });
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_weekly') {
      const weekAgo = new Date(Date.now() - 7*24*60*60*1000);
      const pipeline = [
        { $match: { createdAt: { $gte: weekAgo }, referredBy: { $ne: null } } },
        { $group: { _id: '$referredBy', count: { $sum: 1 } } },
        { $sort: { count: -1 } }, { $limit: 20 },
      ];
      const weekly = await users.aggregate(pipeline).toArray();
      let out = '📅 <b>Weekly Top 20 Referrers</b>\n\n';
      for (let i = 0; i < weekly.length; i++) {
        const u = await users.findOne({ telegramId: weekly[i]._id });
        out += `${i+1}. @${u?.username || u?.firstName || weekly[i]._id} — <b>${weekly[i].count}</b> refs\n`;
      }
      await edit(chatId, msgId, out || 'No data this week.', { reply_markup: backKb });
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_addtask') {
      state[fromId] = { step: 'task_title' };
      await edit(chatId, msgId,
        `📋 <b>Add Task — Step 1/6</b>\n\nEnter the <b>task title</b>:`,
        { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } }
      );
      return res.status(200).json({ ok: true });
    }

    // ── 📝 Task list — PAGINATED (8 per page, newest first) ──
    const tlM = data.match(/^a_tasklist(?:_p(\d+))?$/);
    if (tlM) {
      const PER = 8;
      const total = await tasks.countDocuments({ active: true });
      if (!total) {
        await edit(chatId, msgId, '📋 No active tasks.', { reply_markup: backKb });
        return res.status(200).json({ ok: true });
      }
      const pages = Math.max(1, Math.ceil(total / PER));
      const page = Math.min(Math.max(parseInt(tlM[1], 10) || 1, 1), pages);
      const list = await tasks.find({ active: true }).sort({ createdAt: -1 }).skip((page - 1) * PER).limit(PER).toArray();
      await edit(chatId, msgId, `📝 <b>${total} active task(s)</b> · page ${page}/${pages}\nDetails below ⬇️`, { reply_markup: pagerKb('a_tasklist', page, pages) });
      for (const t of list) {
        await send(chatId,
          `${catLabel(t.category || 'task')}\n` +
          `📋 <b>${t.title}</b>\n` +
          `💰 Reward: <b>${t.reward} SP</b>\n` +
          `👥 Completed: <b>${t.completedCount || 0}</b>${t.maxCompletions ? ` / ${t.maxCompletions}` : ' / Unlimited'}\n` +
          `🔗 ${t.link || 'No link'}\n` +
          `🔧 Type: <b>${t.type}</b>`,
          { reply_markup: { inline_keyboard: [[{ text: '🗑 Remove Task', callback_data: `task_del_${t.id}` }]] } }
        );
      }
      return res.status(200).json({ ok: true });
    }

    // ── Remove task ────────────────────────────────────────────
    if (data.startsWith('task_del_')) {
      const taskId = data.replace('task_del_', '');
      await tasks.updateOne({ id: taskId }, { $set: { active: false } });
      await edit(chatId, msgId, `🗑 Task removed: <code>${taskId}</code>`, { reply_markup: backKb });
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_addpromo') {
      state[fromId] = { step: 'promo_count' };
      await edit(chatId, msgId,
        '🎟 <b>Create Promo Codes</b>\n\nHow many codes to generate?\n(e.g. 5 = 5 unique codes)',
        { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } }
      );
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_broadcast') {
      state[fromId] = { step: 'broadcast_msg' };
      await edit(chatId, msgId, '📢 Type your <b>broadcast message</b>:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    if (data === 'bc_addlink') {
      const s = state[fromId];
      if (!s || s.step !== 'broadcast_link_choice') return res.status(200).json({ ok: true });
      s.step = 'broadcast_link_url';
      await edit(chatId, msgId, '🔗 Link-er URL den (http:// othoba https:// diye shuru):');
      return res.status(200).json({ ok: true });
    }

    if (data === 'bc_skip') {
      const s = state[fromId];
      if (!s || s.step !== 'broadcast_link_choice') return res.status(200).json({ ok: true });
      const msgText = s.text;
      delete state[fromId];
      await runBroadcast(chatId, users, msgText, null);
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_sendsp') {
      state[fromId] = { step: 'sendsp_id' };
      await edit(chatId, msgId, '💰 Enter <b>Telegram ID</b> to send SP to:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
      return res.status(200).json({ ok: true });
    }


    return res.status(200).json({ ok: true });
  }

  // ══════════════════════════════════════════════════════════════
  // TEXT MESSAGES
  // ══════════════════════════════════════════════════════════════
  const msg = update.message;
  if (!msg?.text) return res.status(200).json({ ok: true });

  const fromId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text   = msg.text.trim();

  // ── /start ─────────────────────────────────────────────────
  if (text.startsWith('/start')) {
    if (fromId === String(ADMIN_ID)) {
      await send(chatId, `👑 <b>Ton Spark Electricity — Admin Panel</b>\n\nWelcome back, Admin!`, { reply_markup: adminKb });
      return res.status(200).json({ ok: true });
    }

    const user = await users.findOne({ telegramId: fromId });
    const ref  = user?.referCode || '';
    await sendPhoto(chatId, START_PHOTO,
      `⚡ <b>Welcome to Ton Spark Electricity!</b>\n\nCharge power towers, watch ads, complete tasks — earn SP and withdraw real crypto (50,000 SP = $1).`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🚀 Open Ton Spark Electricity', web_app: { url: APP_URL } }],
        [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL+'?startapp='+ref)}&text=${encodeURIComponent('⚡ Join Ton Spark Electricity! Charge towers, earn SP & withdraw crypto!')}` }],
        [{ text: '💸 Payment Proofs', url: PAYMENT_CHANNEL }],
      ]}}
    );
    return res.status(200).json({ ok: true });
  }

  // ── Admin multi-step flows ──────────────────────────────────
  if (fromId !== String(ADMIN_ID)) return res.status(200).json({ ok: true });

  const s = state[fromId];
  if (!s) {
    await send(chatId, '👑 <b>Ton Spark Electricity — Admin Panel</b>', { reply_markup: adminKb });
    return res.status(200).json({ ok: true });
  }

  // User lookup
  if (s.step === 'user_lookup') {
    const u = await users.findOne({ telegramId: text });
    delete state[fromId];
    if (!u) { await send(chatId, '❌ User not found.', { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }
    await send(chatId, await userInfoText(u, withdrawals), { reply_markup: userInfoKb(u) });
    return res.status(200).json({ ok: true });
  }

  // Send SP
  if (s.step === 'sendsp_id') {
    s.targetId = text; s.step = 'sendsp_amount';
    await send(chatId, `💰 How many <b>SP</b> to send to <code>${text}</code>?`);
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'sendsp_amount') {
    const amt = parseInt(text);
    if (!amt || isNaN(amt)) { await send(chatId, '❌ Invalid number'); return res.status(200).json({ ok: true }); }
    const u = await users.findOne({ telegramId: s.targetId });
    delete state[fromId];
    if (!u) { await send(chatId, '❌ User not found.', { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }
    await users.updateOne({ telegramId: s.targetId }, { $inc: { spBalance: amt } });
    await send(chatId, `✅ Sent <b>${amt} SP</b> to <code>${s.targetId}</code>`, { reply_markup: adminKb });
    await send(s.targetId, `🎁 You received <b>${amt} SP</b> from admin!`);
    return res.status(200).json({ ok: true });
  }


  // Broadcast — step 1: capture message text, then ask about a link button
  if (s.step === 'broadcast_msg') {
    s.text = text;
    s.step = 'broadcast_link_choice';
    await send(chatId,
      `📢 <b>Message preview:</b>\n\n${text}\n\n` +
      `Ekta link button add korte chan?`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🔗 Add Link Button', callback_data: 'bc_addlink' }],
        [{ text: '⏭ Skip — Send Now', callback_data: 'bc_skip' }],
      ]}}
    );
    return res.status(200).json({ ok: true });
  }

  // Broadcast — step 2a: waiting for the URL
  if (s.step === 'broadcast_link_url') {
    if (!/^https?:\/\//i.test(text)) {
      await send(chatId, '❌ Link ta http:// othoba https:// diye shuru hote hobe. Abar den:');
      return res.status(200).json({ ok: true });
    }
    s.linkUrl = text;
    s.step = 'broadcast_link_text';
    await send(chatId, `🔗 Button-er upor ki lekha thakbe? (e.g. "Open App")`);
    return res.status(200).json({ ok: true });
  }

  // Broadcast — step 2b: waiting for the button label, then send
  if (s.step === 'broadcast_link_text') {
    const btnText = text;
    const linkUrl = s.linkUrl;
    const msgText = s.text;
    delete state[fromId];
    await runBroadcast(chatId, users, msgText, { inline_keyboard: [[{ text: btnText, url: linkUrl }]] });
    return res.status(200).json({ ok: true });
  }

  // Promo — auto generate
  if (s.step === 'promo_count') {
    const count = parseInt(text);
    if (!count || isNaN(count) || count < 1 || count > 50) { await send(chatId, '❌ Enter a number between 1 and 50:'); return res.status(200).json({ ok: true }); }
    s.count = count; s.step = 'promo_currency';
    await send(chatId, `🎟 Generating <b>${count}</b> codes\n\nReward in which currency?`, { reply_markup: { inline_keyboard: [
      [{ text: '💰 SP', callback_data: 'promo_cur_sp' }],
      [{ text: '◀️ Cancel', callback_data: 'a_menu' }],
    ]}});
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'promo_reward') {
    s.reward = parseFloat(text);
    if (!s.reward || isNaN(s.reward)) { await send(chatId, `❌ Invalid. Enter SP reward:`); return res.status(200).json({ ok: true }); }
    s.step = 'promo_maxuses';
    await send(chatId, `Reward: <b>${s.reward} SP</b>\n\nMax uses per code? (0 = unlimited):`);
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'promo_maxuses') {
    const maxUses = parseInt(text) || 9999;
    delete state[fromId];
    const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24hr
    const generated = [];
    for (let i = 0; i < s.count; i++) {
      const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
      await promos.insertOne({ code, reward: s.reward, currency: s.currency, maxUses, usedCount: 0, expiresAt: expireAt, createdAt: new Date() });
      generated.push(code);
    }
    const codeList = generated.map((c, i) => `${i+1}. <code>${c}</code>`).join('\n');
    await send(chatId,
      `✅ <b>${s.count} Promo Code(s) Created!</b>\n\n` +
      `💰 Reward: <b>${s.reward} SP</b> each\n` +
      `👥 Max uses: <b>${maxUses}</b>\n` +
      `⏰ Expires: <b>24 hours</b>\n\n` +
      `📋 <b>Codes:</b>\n${codeList}`,
      { reply_markup: adminKb }
    );
    return res.status(200).json({ ok: true });
  }

  // Task creation — 6 steps (title → category → link → reward → quantity → type)
  if (s.step === 'task_title') {
    s.title = text; s.step = 'task_category';
    await send(chatId, `📋 <b>Step 2/6</b>\n\nTitle: ✅ <b>${s.title}</b>\n\nSelect task category:`, { reply_markup: { inline_keyboard: [
      [{ text: '🔁 Daily', callback_data: 'task_cat_daily' }, { text: '⭐ Exclusive', callback_data: 'task_cat_exclusive' }],
      [{ text: '📋 Task', callback_data: 'task_cat_task' }, { text: '🤝 Partner', callback_data: 'task_cat_partner' }],
      [{ text: '◀️ Cancel', callback_data: 'a_menu' }],
    ]}});
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'task_link') { s.link = text === 'none' ? '' : text; s.step = 'task_reward'; await send(chatId, `📋 <b>Step 4/6</b>\n\nEnter <b>SP reward</b> amount (e.g. 12.5):`); return res.status(200).json({ ok: true }); }
  if (s.step === 'task_reward') {
    s.reward = parseFloat(text);
    if (!s.reward || isNaN(s.reward) || s.reward <= 0) { await send(chatId, '❌ Invalid reward. Enter a number:'); return res.status(200).json({ ok: true }); }
    s.step = 'task_quantity';
    await send(chatId, `📋 <b>Step 5/6</b>\n\nHow many users can complete this task?\n(Enter number, or <code>0</code> for unlimited):`);
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'task_quantity') {
    s.maxCompletions = parseInt(text) || 0;
    s.step = 'task_type';
    await send(chatId, `📋 <b>Step 6/6</b>\n\nTask type:`,
      { reply_markup: { inline_keyboard: [
        [{ text: '✅ Telegram API (channel/group)', callback_data: 'task_type_api' }],
        [{ text: '🌐 Regular (YouTube, FB etc.)',   callback_data: 'task_type_none' }],
      ]}}
    );
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'task_confirm') {
    if (text.toUpperCase() !== 'CONFIRM') { await send(chatId, '❌ Type <b>CONFIRM</b> to save:'); return res.status(200).json({ ok: true }); }
    delete state[fromId];
    const taskId = 'task_' + Date.now();
    await tasks.insertOne({ id: taskId, title: s.title, category: s.category, link: s.link, reward: s.reward, rewardUnit: 'sp', maxCompletions: s.maxCompletions, type: s.type, officialTarget: s.officialTarget || null, active: true, createdAt: new Date(), completedCount: 0 });
    await send(chatId,
      `✅ <b>Task Created!</b>\n\n${catLabel(s.category)}\n📋 ${s.title}\n💰 ${s.reward} SP\n🔗 ${s.link || 'No link'}\n👥 Max: ${s.maxCompletions || 'Unlimited'}\n🔧 Type: ${s.type}`,
      { reply_markup: adminKb }
    );
    return res.status(200).json({ ok: true });
  }

  // Default — show menu
  await send(chatId, '👑 <b>Ton Spark Electricity — Admin Panel</b>', { reply_markup: adminKb });
  res.status(200).json({ ok: true });
}
