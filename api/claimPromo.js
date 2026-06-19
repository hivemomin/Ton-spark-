// api/claimPromo.js
// POST { userId, code, validateOnly }
// Two-step flow used by the frontend:
//  1) validateOnly:true  -> just checks if the code CAN be redeemed (no side effects)
//  2) validateOnly absent -> actually redeems it (atomic, one-time per user)
//
// Promo code doc shape (collection `promoCodes`, doc id = the code itself):
//   { reward: number, maxUses: number, usedBy: string[], expiresAt: number|null, active: true }

const { db, admin } = require('../lib/firebaseAdmin');
const { handlePreflight } = require('../lib/helpers');

function checkValidity(promo, userId) {
  if (!promo) return 'not_found';
  if (promo.active === false) return 'expired';
  if (promo.expiresAt && Date.now() > promo.expiresAt) return 'expired';
  if ((promo.usedBy || []).includes(String(userId))) return 'already_used';
  if (promo.maxUses && (promo.usedBy || []).length >= promo.maxUses) return 'expired';
  return null;
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, code, validateOnly } = req.body || {};
    if (!userId || !code) return res.status(400).json({ error: 'userId and code required' });

    const codeId = String(code).trim().toUpperCase();
    const promoRef = db.collection('promoCodes').doc(codeId);

    // ── Step 1: validate only, no writes ──
    if (validateOnly) {
      const snap = await promoRef.get();
      const reason = checkValidity(snap.exists ? snap.data() : null, userId);
      if (reason) return res.json({ valid: false, reason });
      return res.json({ valid: true });
    }

    // ── Step 2: actually redeem, atomic ──
    const userRef = db.collection('users').doc(String(userId));

    const result = await db.runTransaction(async (tx) => {
      const [promoSnap, userSnap] = await Promise.all([tx.get(promoRef), tx.get(userRef)]);
      if (!userSnap.exists) return { error: 'User not found' };

      const promo = promoSnap.exists ? promoSnap.data() : null;
      const reason = checkValidity(promo, userId);
      if (reason) return { error: reason === 'already_used' ? 'Already used' : 'Invalid or expired code' };

      const reward = promo.reward || 0;

      tx.update(promoRef, { usedBy: admin.firestore.FieldValue.arrayUnion(String(userId)) });
      tx.update(userRef, { diamondBalance: admin.firestore.FieldValue.increment(reward) });

      return { success: true, reward };
    });

    if (result.error) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    console.error('[claimPromo]', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
