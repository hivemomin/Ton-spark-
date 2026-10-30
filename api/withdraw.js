// FILE PATH: api/withdraw.js

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { BOT_SUSPECT_HOLD_COUNT, SP_PER_USDT, MIN_WITHDRAW_SP, WD_MIN_TOWER_CLAIMS, WD_MIN_TASKS, WITHDRAW_FEE } from '../lib/constants.js';

// Currency system: SP is the only currency: (Gold + Convert were removed), and
// 50,000 SP = $1 USDT.
const SP_TO_USDT = 1 / SP_PER_USDT; // 50,000 SP = $1

// ── Withdraw gate requirements ──────────────────────────────────
// Lifetime requirements (values live in lib/constants.js): 3 tower claims + 5 tasks + 2,000 SP minimum.
const FREE_WITHDRAW_USDT = 0.15; // withdrawals at/under this need no valid referral

// "Valid referral" — a friend you referred counts as valid once THEY have
// completed this many tasks AND watched this many ads (kept in sync with
// VALID_TASKS/VALID_ADS in tasks.js and adwatch.js, which set the
// refereeValid flag checked below).
const VALID_REFERRAL_TASKS = 10;
const VALID_REFERRAL_ADS = 10;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-spark-qu47.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // ── GET: the user's last withdrawals (Profile tab) ───────────
  if (req.method === 'GET') {
    const gid = req.query?.telegramId;
    const gtg = verifyTelegramInit(req.query?.initData || '');
    if (!gid || !gtg || String(gtg.id) !== String(gid)) return res.status(403).json({ error: 'Invalid Telegram session' });
    try {
      const db = await getDb();
      // PAGINATED: ?page=1,2,3… (10 per page, newest first)
      const PAGE_SIZE = 10;
      const col = db.collection('withdrawals');
      const total = await col.countDocuments({ telegramId: String(gid) });
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const page = Math.min(Math.max(parseInt(req.query?.page, 10) || 1, 1), totalPages);
      const rows = await col
        .find({ telegramId: String(gid) }, { projection: { _id: 0, spAmount: 1, usdtAmount: 1, method: 1, status: 1, createdAt: 1 } })
        .sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).toArray();
      res.setHeader('Cache-Control', 'private, max-age=20');
      return res.status(200).json({ success: true, withdrawals: rows, page, totalPages, total });
    } catch (err) {
      console.error('withdraw.js GET error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId, initData, method, address, spAmount } = req.body;

  if (!telegramId || !method || !address || !spAmount)
    return res.status(400).json({ error: 'telegramId, method, address, spAmount required' });

  // spAmount must be a real, finite, positive number — reject "abc", NaN, Infinity, etc.
  const amount = Number(spAmount);
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: 'Invalid spAmount.' });

  if (!['tonkeeper', 'binance'].includes(method))
    return res.status(400).json({ error: 'method must be tonkeeper or binance' });

  if (amount < MIN_WITHDRAW_SP)
    return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAW_SP} SP.` });

  if (method === 'binance') {
    if (!/^\d{6,12}$/.test(String(address)))
      return res.status(400).json({ error: 'Invalid Binance UID. Must be 6-12 digits.' });
  }
  if (method === 'tonkeeper') {
    if (!/^(UQ|EQ)[A-Za-z0-9_-]{46}$/.test(String(address)))
      return res.status(400).json({ error: 'Invalid TON address format.' });
  }

  // initData is now REQUIRED — previously optional (`if (initData) {...}`),
  // which let anyone skip verification entirely by just omitting the field
  // and withdraw from ANY telegramId with no proof of ownership.
  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId))
    return res.status(403).json({ error: 'Invalid Telegram session' });

  try {
    const db = await getDb();
    const users = db.collection('users');
    const withdrawals = db.collection('withdrawals');

    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });
    // Security (NEWTUBE): locked accounts (signup burst / bot pattern / IP velocity) cannot withdraw,
    // and accounts with repeated bot-rule hits are held until the admin reviews them.
    if (user.accountLocked)
      return res.status(403).json({ error: 'Withdrawals are on hold for this account while it is being reviewed. Contact support.' });
    if ((user.botSuspectCount || 0) >= BOT_SUSPECT_HOLD_COUNT)
      return res.status(403).json({ error: 'Withdrawals are on hold pending an admin review. Contact support.' });

    // ── Withdraw gate ──────────────────────────────────────────
    // Fee-adjusted USDT value is computed up front because the free-tier
    // threshold below is decided by it — everything else about the payout
    // math stays the same as before, just moved earlier.
    const grossUsdt = amount * SP_TO_USDT;
    const usdtAmount = parseFloat((grossUsdt * (1 - WITHDRAW_FEE)).toFixed(4));

    const tasksCompleted = (user.completedTasks || []).length;
    const towerClaims = ['t1', 't2', 't3', 't4'].reduce((n, k) => n + (user.towers?.[k]?.claims || 0), 0);

    const missing = [];
    if (towerClaims < WD_MIN_TOWER_CLAIMS)
      missing.push(`collect your towers ${WD_MIN_TOWER_CLAIMS - towerClaims} more time(s) in Electricity (${WD_MIN_TOWER_CLAIMS} claims needed)`);
    if (tasksCompleted < WD_MIN_TASKS)
      missing.push(`complete ${WD_MIN_TASKS - tasksCompleted} more task(s) (${WD_MIN_TASKS} needed)`);

    // Withdrawals above the free tier need at least one "valid" referral —
    // a friend you referred who has completed 5 tasks AND watched 20 ads.
    let hasValidReferral = true;
    if (usdtAmount > FREE_WITHDRAW_USDT) {
      const validRefCount = await users.countDocuments({ referredBy: String(telegramId), refereeValid: true });
      hasValidReferral = validRefCount >= 1;
      if (!hasValidReferral)
        missing.push(`get 1 valid referral (a friend who completed ${VALID_REFERRAL_TASKS} tasks and watched ${VALID_REFERRAL_ADS} ads) — withdrawals over $${FREE_WITHDRAW_USDT} require this`);
    }

    if (missing.length > 0) {
      return res.status(400).json({
        error: `Withdraw requirements not met: ${missing.join(', ')}.`,
        requirements: {
          tasksCompleted, tasksRequired: WD_MIN_TASKS,
          towerClaims, towerClaimsRequired: WD_MIN_TOWER_CLAIMS,
          hasValidReferral, freeWithdrawUsdt: FREE_WITHDRAW_USDT,
        },
      });
    }

    const pending = await withdrawals.findOne({ telegramId: String(telegramId), status: 'pending' });
    if (pending) return res.status(400).json({ error: 'You already have a pending withdrawal.' });

    // Atomic balance deduction: only succeeds if spBalance is still >= amount
    // at the moment of the update. Previously this was a separate
    // read-then-write (findOne, then updateOne), so two withdrawal requests
    // fired at the same time could both pass the balance check before either
    // deduction landed — letting a user withdraw more than their real
    // balance (a classic race condition / double-spend).
    const deducted = await users.findOneAndUpdate(
      { telegramId: String(telegramId), spBalance: { $gte: amount } },
      { $inc: { spBalance: -amount } },
      { returnDocument: 'after' }
    );
    const updatedUser = deducted?.value || deducted;
    if (!updatedUser) {
      return res.status(400).json({ error: 'Insufficient balance.' });
    }

    // The fee was already applied above (usdtAmount) so what we paid out
    // matches what the gate check and the frontend's "after fee" preview
    // both promised.
    const doc = {
      telegramId: String(telegramId),
      username: user.username || '',
      firstName: user.firstName || '',
      method,
      address: String(address),
      spAmount: amount,
      usdtAmount,
      status: 'pending',
      referrerId: user.referredBy || null, // 15% commission goes to this user when the admin approves
      referrerCommissionPaid: 0,
      createdAt: new Date(),
    };

    try {
      await withdrawals.insertOne(doc);
    } catch (insertErr) {
      // If logging the withdrawal fails, refund the deduction so the
      // balance we already took isn't lost with no record of why.
      await users.updateOne({ telegramId: String(telegramId) }, { $inc: { spBalance: amount } });
      throw insertErr;
    }

    return res.status(200).json({
      success: true,
      usdtAmount,
      method,
      message: 'Withdrawal submitted. Admin will process within 24-48 hours.',
    });
  } catch (err) {
    console.error('withdraw.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
      }
