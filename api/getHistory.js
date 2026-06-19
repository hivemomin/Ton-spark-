// api/getHistory.js
// GET ?userId=...
// Returns the user's withdrawal history as a transaction timeline.
// (Task/spark/lootbox earnings are high-frequency and kept client-side only;
// withdrawals are the durable, audit-worthy record stored server-side.)

const { db } = require('../lib/firebaseAdmin');
const { handlePreflight } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const snap = await db
      .collection('withdrawals')
      .where('userId', '==', String(userId))
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const history = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        type: 'withdrawal',
        amount: d.amountSP,
        date: d.date,
        note: `Withdraw → ${d.method || 'tonkeeper'} (${d.status || 'pending'})`,
        status: d.status,
      };
    });

    return res.json({ history });
  } catch (err) {
    console.error('[getHistory]', err);
    return res.status(500).json({ error: 'Server error', history: [] });
  }
};
