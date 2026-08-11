// FILE PATH: api/bot.js

import { getDb } from '../lib/mongodb.js';

const ADMIN_ID = process.env.ADMIN_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = 'http://t.me/TonSparks_bot/startapp';
const APP_URL = 'https://ton-spark-qu47.vercel.app';
const CHANNEL = '@Tonsparkpayout';
const COMMUNITY = '@Tonspark2';
const START_PHOTO = 'https://i.postimg.cc/7Yvq0Mvk/file-000000003a68720caa1783ce4ae59cb7.png';

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
    try { await send(u.telegramId, `📢 <b>Ton Spark Update</b>\n\n${text}`, extra); sent++; } catch { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  await send(chatId, `✅ Done! Sent: <b>${sent}</b> | Failed: <b>${failed}</b>`, { reply_markup: adminKb });
}

async function isMember(userId, chat) {
  try {
    const r = await tgApi('getChatMember', { chat_id: chat, user_id: userId });
    return ['member', 'administrator', 'creator'].includes(r.result?.status);
  } catch { return false; }
}

// ── Admin keyboard ──────────────────────────────────────────────
const adminKb = {
  inline_keyboard: [
    [{ text: '📊 Dashboard',     callback_data: 'a_stats'       }, { text: '💸 Withdrawals',   callback_data: 'a_pending'     }],
    [{ text: '👤 User Lookup',   callback_data: 'a_user'        }, { text: '🏆 Top Referrers', callback_data: 'a_toprefer'   }],
    [{ text: '📅 Weekly Refer',  callback_data: 'a_weekly'      }, { text: '📋 Add Task',      callback_data: 'a_addtask'    }],
    [{ text: '📝 Task List',     callback_data: 'a_tasklist'    }, { text: '🎟 Add Promo',     callback_data: 'a_addpromo'   }],
    [{ text: '📢 Broadcast',     callback_data: 'a_broadcast'   }],
    [{ text: '💰 Send SP',       callback_data: 'a_sendsp'      }, { text: '🪙 Send Gold',     callback_data: 'a_sendgold'    }],
  ]
};

const backKb = { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

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

    // ── User: check channel join ──────────────────────────────
    if (data.startsWith('check_join_')) {
      const userId = data.replace('check_join_', '');
      if (fromId !== userId) { await answer(cb.id, '⛔ Not your button'); return res.status(200).json({ ok: true }); }
      const [ch, com] = await Promise.all([isMember(userId, CHANNEL), isMember(userId, COMMUNITY)]);
      if (!ch || !com) {
        await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ Join both channels first!', show_alert: true });
        return res.status(200).json({ ok: true });
      }
      const user = await users.findOne({ telegramId: userId });
      const ref  = user?.referCode || '';
      await send(chatId, `✅ <b>Verified! Welcome to Ton Spark!</b>\n\n⚡ Farm Lightning · Earn Gold · Withdraw crypto!`, {
        reply_markup: { inline_keyboard: [
          [{ text: '🚀 Open Ton Spark', web_app: { url: APP_URL } }],
          [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL+'?startapp='+ref)}&text=${encodeURIComponent('⚡ Join Ton Spark! Earn SP coins!')}` }],
        ]}
      });
      return res.status(200).json({ ok: true });
    }

    // All callbacks below — admin only
    if (fromId !== String(ADMIN_ID)) return res.status(200).json({ ok: true });

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
      if (!approve) {
        await users.updateOne({ telegramId: w.telegramId }, { $inc: { spBalance: w.spAmount }, $set: { withdrawPending: false } });
      } else {
        await users.updateOne({ telegramId: w.telegramId }, { $set: { withdrawPending: false } });
      }
      await withdrawals.updateOne({ _id: new ObjectId(wid) }, {
        $set: { status: approve ? 'approved' : 'rejected', processedAt: new Date() }
      });
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: approve ? '✅ Approved' : '❌ Rejected', show_alert: true });
      const notif = approve
        ? `✅ <b>Withdrawal Approved!</b>\n\n💰 ${w.spAmount} SP → ${w.usdtAmount} USDT\n📤 ${w.method}\n📍 <code>${w.address}</code>`
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
        `Reward: <b>${s.reward} Gold</b>\n` +
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
        `Reward: <b>${s.reward} Gold</b>\n` +
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
      s.currency = data === 'promo_cur_gold' ? 'gold' : 'sp';
      s.step = 'promo_reward';
      await edit(chatId, msgId, `Currency: <b>${s.currency === 'gold' ? 'Gold' : 'SP'}</b>\n\nEnter <b>reward</b> per code:`);
      return res.status(200).json({ ok: true });
    }

    // ── Admin menu buttons ────────────────────────────────────
    if (data === 'a_menu') {
      await edit(chatId, msgId, '👑 <b>Ton Spark Admin Panel</b>\n\nSelect an option:', { reply_markup: adminKb });
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_stats') {
      const total   = await users.countDocuments();
      const today   = new Date(); today.setHours(0,0,0,0);
      const newToday = await users.countDocuments({ createdAt: { $gte: today } });
      const pendingW = await withdrawals.countDocuments({ status: 'pending' });
      const farmers = await users.countDocuments({ 'lightning.totalClaims': { $gt: 0 } });
      const taskCnt = await tasks.countDocuments({ active: true });
      const goldAgg = await users.aggregate([{ $group: { _id: null, t: { $sum: '$goldBalance' } } }]).toArray();
      const spAgg   = await users.aggregate([{ $group: { _id: null, t: { $sum: '$spBalance' } } }]).toArray();
      await edit(chatId, msgId,
        `📊 <b>Dashboard</b>\n\n` +
        `👥 Total Users: <b>${total}</b>\n` +
        `🆕 Today Joined: <b>${newToday}</b>\n` +
        `📋 Active Tasks: <b>${taskCnt}</b>\n` +
        `⏳ Pending Withdrawals: <b>${pendingW}</b>\n` +
        `⚡ Users Who Farmed Lightning: <b>${farmers}</b>\n` +
        `🪙 Total Gold: <b>${goldAgg[0]?.t || 0}</b>\n` +
        `💰 Total SP: <b>${spAgg[0]?.t || 0}</b>`,
        { reply_markup: backKb }
      );
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_pending') {
      const list = await withdrawals.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(10).toArray();
      if (!list.length) {
        await edit(chatId, msgId, '✅ No pending withdrawals.', { reply_markup: backKb });
        return res.status(200).json({ ok: true });
      }
      await edit(chatId, msgId, `💸 <b>${list.length} pending withdrawal(s)</b> — sending details below:`, { reply_markup: backKb });
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

    if (data === 'a_tasklist') {
      const list = await tasks.find({ active: true }).sort({ createdAt: -1 }).limit(30).toArray();
      if (!list.length) {
        await edit(chatId, msgId, '📋 No active tasks.', { reply_markup: backKb });
        return res.status(200).json({ ok: true });
      }
      await edit(chatId, msgId, `📝 <b>${list.length} active task(s)</b> — details below:`, { reply_markup: backKb });
      for (const t of list) {
        await send(chatId,
          `${catLabel(t.category || 'task')}\n` +
          `📋 <b>${t.title}</b>\n` +
          `💰 Reward: <b>${t.reward} Gold</b>\n` +
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

    if (data === 'a_sendgold') {
      state[fromId] = { step: 'sendgold_id' };
      await edit(chatId, msgId, '🪙 Enter <b>Telegram ID</b> to send Gold to:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
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
      await send(chatId, `👑 <b>Ton Spark Admin Panel</b>\n\nWelcome back, Admin!`, { reply_markup: adminKb });
      return res.status(200).json({ ok: true });
    }

    const [ch, com] = await Promise.all([isMember(fromId, CHANNEL), isMember(fromId, COMMUNITY)]);
    if (!ch || !com) {
      await sendPhoto(chatId, START_PHOTO,
        `👋 <b>Welcome to Ton Spark!</b>\n\n⚠️ Join our official channels to continue.`,
        { reply_markup: { inline_keyboard: [
          [{ text: '📢 Official Channel', url: 'https://t.me/Tonsparkpayout' }, { text: '💬 Community', url: 'https://t.me/Tonspark2' }],
          [{ text: '✅ Check & Open App', callback_data: `check_join_${fromId}` }],
        ]}}
      );
      return res.status(200).json({ ok: true });
    }

    const user = await users.findOne({ telegramId: fromId });
    const ref  = user?.referCode || '';
    await sendPhoto(chatId, START_PHOTO,
      `⚡ <b>Welcome to Ton Spark!</b>\n\nFarm Lightning · Earn Gold · Withdraw crypto!\n\n💰 Binance & TonKeeper USDT withdrawals\n👥 Refer friends for bonus Gold`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🚀 Open Ton Spark', web_app: { url: APP_URL } }],
        [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL+'?startapp='+ref)}&text=${encodeURIComponent('⚡ Join Ton Spark! Earn SP coins!')}` }],
      ]}}
    );
    return res.status(200).json({ ok: true });
  }

  // ── Admin multi-step flows ──────────────────────────────────
  if (fromId !== String(ADMIN_ID)) return res.status(200).json({ ok: true });

  const s = state[fromId];
  if (!s) {
    await send(chatId, '👑 <b>Ton Spark Admin Panel</b>', { reply_markup: adminKb });
    return res.status(200).json({ ok: true });
  }

  // User lookup
  if (s.step === 'user_lookup') {
    const u = await users.findOne({ telegramId: text });
    delete state[fromId];
    if (!u) { await send(chatId, '❌ User not found.', { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }
    const wCount = await withdrawals.countDocuments({ telegramId: text });
    await send(chatId,
      `👤 <b>User Info</b>\n\n` +
      `ID: <code>${u.telegramId}</code>\n` +
      `Name: <b>${u.firstName}</b> (@${u.username || 'none'})\n` +
      `💰 Balance: <b>${u.spBalance} SP</b>\n` +
      `🪙 Gold: <b>${u.goldBalance}</b>\n` +
      `👥 Referrals: <b>${u.totalReferred || 0}</b>\n` +
      `🎁 Ref Earned: <b>${u.totalRefEarned || 0} Gold</b>\n` +
      `📤 Withdrawals: <b>${wCount}</b>\n` +
      `⚡ Lightning Claims: <b>${u.lightning?.totalClaims || 0}</b>\n` +
      `🚫 Banned: <b>${u.isBanned ? 'YES ⛔' : 'No ✅'}</b>\n` +
      `📅 Joined: ${new Date(u.createdAt).toLocaleDateString()}`,
      { reply_markup: { inline_keyboard: [
        [u.isBanned
          ? { text: '✅ Unban User', callback_data: `unban_${u.telegramId}` }
          : { text: '🚫 Ban User',   callback_data: `ban_${u.telegramId}` }
        ],
        [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
      ]}}
    );
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

  // Send Gold
  if (s.step === 'sendgold_id') {
    s.targetId = text; s.step = 'sendgold_amount';
    await send(chatId, `🪙 How many <b>Gold</b> to send to <code>${text}</code>?`);
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'sendgold_amount') {
    const amt = parseInt(text);
    if (!amt || isNaN(amt)) { await send(chatId, '❌ Invalid number'); return res.status(200).json({ ok: true }); }
    const u = await users.findOne({ telegramId: s.targetId });
    delete state[fromId];
    if (!u) { await send(chatId, '❌ User not found.', { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }
    await users.updateOne({ telegramId: s.targetId }, { $inc: { goldBalance: amt } });
    await send(chatId, `✅ Sent <b>${amt} Gold</b> to <code>${s.targetId}</code>`, { reply_markup: adminKb });
    await send(s.targetId, `🎁 You received <b>${amt} Gold</b> from admin!`);
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
      [{ text: '🪙 Gold', callback_data: 'promo_cur_gold' }, { text: '💰 SP', callback_data: 'promo_cur_sp' }],
      [{ text: '◀️ Cancel', callback_data: 'a_menu' }],
    ]}});
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'promo_reward') {
    s.reward = parseInt(text);
    if (!s.reward || isNaN(s.reward)) { await send(chatId, `❌ Invalid. Enter ${s.currency === 'gold' ? 'Gold' : 'SP'} reward:`); return res.status(200).json({ ok: true }); }
    s.step = 'promo_maxuses';
    await send(chatId, `Reward: <b>${s.reward} ${s.currency === 'gold' ? 'Gold' : 'SP'}</b>\n\nMax uses per code? (0 = unlimited):`);
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
      `💰 Reward: <b>${s.reward} ${s.currency === 'gold' ? 'Gold' : 'SP'}</b> each\n` +
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
  if (s.step === 'task_link') { s.link = text === 'none' ? '' : text; s.step = 'task_reward'; await send(chatId, `📋 <b>Step 4/6</b>\n\nEnter <b>Gold reward</b> amount:`); return res.status(200).json({ ok: true }); }
  if (s.step === 'task_reward') {
    s.reward = parseInt(text);
    if (!s.reward || isNaN(s.reward)) { await send(chatId, '❌ Invalid reward. Enter a number:'); return res.status(200).json({ ok: true }); }
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
    await tasks.insertOne({ id: taskId, title: s.title, category: s.category, link: s.link, reward: s.reward, maxCompletions: s.maxCompletions, type: s.type, officialTarget: s.officialTarget || null, active: true, createdAt: new Date(), completedCount: 0 });
    await send(chatId,
      `✅ <b>Task Created!</b>\n\n${catLabel(s.category)}\n📋 ${s.title}\n💰 ${s.reward} Gold\n🔗 ${s.link || 'No link'}\n👥 Max: ${s.maxCompletions || 'Unlimited'}\n🔧 Type: ${s.type}`,
      { reply_markup: adminKb }
    );
    return res.status(200).json({ ok: true });
  }

  // Default — show menu
  await send(chatId, '👑 <b>Ton Spark Admin Panel</b>', { reply_markup: adminKb });
  res.status(200).json({ ok: true });
}
