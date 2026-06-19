// api/withdraw.js
// POST { userId, username, firstName, method, address, amount, tasksDone }
// Validates all withdrawal rules server-side (never trust the client),
// deducts balance, logs a `withdrawals` doc, and notifies the admin via
// the Telegram Bot so withdrawals can be processed manually.

const { db, admin } = require('../lib/firebaseAdmin');
const { handlePreflight, getTodayDhaka } = require('../lib/helpers');

const MIN_WITHDRAW = 1000;
const WITHDRAW_MIN_TASKS = 10;
const SP_TO_TON = 0.00003;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

async function notifyAdmin(text) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('[withdraw] notifyAdmin failed', e);
  }
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, username, firstName, method, address, amount } = req.body || {};
    if (!userId || !address || !amount) {
      return res.status(400).json({ error: 'userId, address and amount required' });
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < MIN_WITHDRAW) {
      return res.status(400).json({ error: `Minimum ${MIN_WITHDRAW} SP required` });
    }

    const userRef = db.collection('users').doc(String(userId));
    const today = getTodayDhaka();

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) return { error: 'User not found' };
      const user = snap.data();

      if (user.isBanned) return { error: 'Account banned' };
      if (user.withdrawBanned) return { error: 'Withdrawals disabled for this account' };

      const balance = parseFloat(user.diamondBalance || 0);
      if (balance < amt) return { error: 'Insufficient SP balance' };

      if (user.lastWithdrawDate === today) return { error: 'Max 1 withdrawal per day' };

      const tasksDone = (user.completedTasks || []).length;
      if (tasksDone < WITHDRAW_MIN_TASKS) {
        return { error: `Complete ${WITHDRAW_MIN_TASKS} tasks first (${tasksDone}/${WITHDRAW_MIN_TASKS})` };
      }

      const newBalance = balance - amt;
      const tonAmount = +(amt * SP_TO_TON).toFixed(4);

      tx.update(userRef, {
        diamondBalance: newBalance,
        lastWithdrawDate: today,
      });

      const withdrawalRef = db.collection('withdrawals').doc();
      tx.set(withdrawalRef, {
        userId: String(userId),
        username: username || '',
        firstName: firstName || '',
        method: method || 'tonkeeper',
        address,
        amountSP: amt,
        amountTON: tonAmount,
        status: 'pending',
        createdAt: Date.now(),
        date: today,
      });

      return { success: true, newBalance, tonAmount, withdrawalId: withdrawalRef.id };
    });

    if (result.error) return res.status(400).json({ error: result.error });

    notifyAdmin(
      `💸 <b>New Withdrawal Request</b>\n\n` +
      `User: ${firstName || ''} (@${username || 'no_username'})\n` +
      `ID: <code>${userId}</code>\n` +
      `Amount: <b>${amt} SP</b> (≈ ${result.tonAmount} TON)\n` +
      `Method: ${method || 'tonkeeper'}\n` +
      `Address: <code>${address}</code>\n` +
      `Request ID: <code>${result.withdrawalId}</code>`
    );

    return res.json(result);
  } catch (err) {
    console.error('[withdraw]', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
