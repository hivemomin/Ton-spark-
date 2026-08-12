// FILE PATH: api/withdraw.js

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

// 25 SP = $1
const MIN_WITHDRAW_SP = 1000; // ≈ $40 before fee, ≈ $36 after 10% fee
const SP_TO_USDT = 1 / 25;
const WITHDRAW_FEE = 0.10; // 10% — same for Binance UID and TonKeeper

// ── Withdraw gate requirements ──────────────────────────────────
const MIN_TASKS_COMPLETED = 5;
const MIN_LIGHTNING_CLAIMS = 1;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-spark-qu47.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
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

    // ── Withdraw gate ──────────────────────────────────────────
    const tasksCompleted = (user.completedTasks || []).length;
    const lightningClaims = user.lightning?.totalClaims || 0;

    const missing = [];
    if (tasksCompleted < MIN_TASKS_COMPLETED)
      missing.push(`complete ${MIN_TASKS_COMPLETED - tasksCompleted} more task(s)`);
    if (lightningClaims < MIN_LIGHTNING_CLAIMS)
      missing.push(`claim your Lightning Farm at least once`);

    if (missing.length > 0) {
      return res.status(400).json({
        error: `Withdraw requirements not met: ${missing.join(', ')}.`,
        requirements: {
          tasksCompleted, tasksRequired: MIN_TASKS_COMPLETED,
          lightningClaims, lightningClaimsRequired: MIN_LIGHTNING_CLAIMS,
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

    // The fee is applied here, server-side, so the amount actually paid out
    // always matches what the fee-adjusted preview promised the user —
    // previously this line ignored the fee entirely and paid the full
    // gross amount, silently contradicting the "after fee" preview shown
    // in the app.
    const grossUsdt = amount * SP_TO_USDT;
    const usdtAmount = parseFloat((grossUsdt * (1 - WITHDRAW_FEE)).toFixed(4));

    const doc = {
      telegramId: String(telegramId),
      username: user.username || '',
      firstName: user.firstName || '',
      method,
      address: String(address),
      spAmount: amount,
      usdtAmount,
      status: 'pending',
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
