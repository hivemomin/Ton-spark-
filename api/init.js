// api/init.js
// POST { userId, firstName, lastName, username, referrerCode }
// Creates the user on first open, otherwise returns the existing user.
// Also assigns a referrer (one-time) if a valid startapp param was passed.

const { db } = require('../lib/firebaseAdmin');
const { handlePreflight, defaultUser } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, firstName, lastName, username, referrerCode } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const userRef = db.collection('users').doc(String(userId));
    const snap = await userRef.get();

    // ── Existing user: just return them ──
    if (snap.exists) {
      const user = snap.data();
      if (user.isBanned) return res.json({ blocked: true });
      return res.json({ user, isNew: false });
    }

    // ── New user: create doc ──
    const newUser = defaultUser({ firstName, lastName, username });

    // Assign referrer if a valid one was provided and it's not a self-referral.
    if (referrerCode && String(referrerCode) !== String(userId)) {
      const refRef = db.collection('users').doc(String(referrerCode));
      const refSnap = await refRef.get();
      if (refSnap.exists) {
        newUser.referredBy = String(referrerCode);
        await refRef.update({
          totalInvites: (refSnap.data().totalInvites || 0) + 1,
        });
      }
    }

    await userRef.set(newUser);
    return res.json({ user: newUser, isNew: true, justCreated: true });
  } catch (err) {
    console.error('[init]', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
