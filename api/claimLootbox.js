// api/claimLootbox.js
// POST { userId }
// Moves lootboxBalance into the main diamondBalance.
// Rules: min 150 SP in lootbox to claim, max 2 claims per day (Asia/Dhaka).

const { db, admin } = require('../lib/firebaseAdmin');
const { handlePreflight, getTodayDhaka } = require('../lib/helpers');

const LOOTBOX_MIN = 150;
const LOOTBOX_MAX_DAY = 2;

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const userRef = db.collection('users').doc(String(userId));
    const today = getTodayDhaka();

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) return { error: 'User not found' };
      const user = snap.data();

      if (user.isBanned) return { error: 'Account banned' };

      const lb = parseFloat(user.lootboxBalance || 0);
      if (lb < LOOTBOX_MIN) return { error: `Minimum ${LOOTBOX_MIN} SP required in lootbox` };

      const claimsToday = user.lootboxClaimDate === today ? (user.lootboxClaimCount || 0) : 0;
      if (claimsToday >= LOOTBOX_MAX_DAY) return { error: 'Daily claim limit reached' };

      tx.update(userRef, {
        diamondBalance: admin.firestore.FieldValue.increment(lb),
        lootboxBalance: 0,
        lootboxClaimDate: today,
        lootboxClaimCount: claimsToday + 1,
      });

      return { success: true, claimed: lb };
    });

    if (result.error) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    console.error('[claimLootbox]', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
