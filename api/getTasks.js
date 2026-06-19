// api/getTasks.js
// GET ?userId=...
// Returns all active tasks from the `tasks` collection.
// Each task doc shape: { name, type, url, reward, active }
// type is one of: telegram_channel | telegram_group | telegram_bot | social

const { db } = require('../lib/firebaseAdmin');
const { handlePreflight } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const snap = await db.collection('tasks').where('active', '==', true).get();
    const tasks = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return res.json({ tasks });
  } catch (err) {
    console.error('[getTasks]', err);
    return res.status(500).json({ error: 'Server error', tasks: [] });
  }
};
