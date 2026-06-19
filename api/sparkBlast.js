// api/sparkBlast.js
// POST { userId }
// Server picks the random reward itself (10-20 SP) and enforces the 4-hour
// cooldown using a timestamp stored in Firestore — this is the real source
// of truth. The frontend's localStorage timer is just a UX countdown;
// without this server check, anyone could clear localStorage and re-blast
// instantly. Reward is intentionally NOT trusted from the client.

const { db, admin } = require('../lib/firebaseAdmin');
const { handlePreflight } = require('../lib/helpers');

const SPARK_CD_MS = 4 * 60 * 60 * 1000; // 4 hours
const MIN_REWARD = 10;
const MAX_REWARD = 20;

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const userRef = db.collection('users').doc(String(userId));

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) return { error: 'User not found' };
      const user = snap.data();

      if (user.isBanned) return { error: 'Account banned' };

      const lastBlast = user.lastSparkBlastAt || 0;
      const now = Date.now();
      if (now - lastBlast < SPARK_CD_MS) {
        const remainingMs = SPARK_CD_MS - (now - lastBlast);
        return { error: 'Cooldown active', cooldown: true, remainingMs };
      }

      const reward = Math.floor(Math.random() * (MAX_REWARD - MIN_REWARD + 1)) + MIN_REWARD;

      tx.update(userRef, {
        diamondBalance: admin.firestore.FieldValue.increment(reward),
        lastSparkBlastAt: now,
        sparkTotalBlasts: admin.firestore.FieldValue.increment(1),
        sparkTotalEarned: admin.firestore.FieldValue.increment(reward),
      });

      return { success: true, reward };
    });

    if (result.error) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    console.error('[sparkBlast]', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
