// api/claimTask.js
// POST { userId, taskId }
// Marks a task as completed and credits the SP reward.
// Uses a Firestore transaction so the same task can never be claimed twice,
// even with rapid double-taps from the frontend.

const { db, admin } = require('../lib/firebaseAdmin');
const { handlePreflight } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, taskId } = req.body || {};
    if (!userId || !taskId) return res.status(400).json({ error: 'userId and taskId required' });

    const taskRef = db.collection('tasks').doc(String(taskId));
    const userRef = db.collection('users').doc(String(userId));

    const result = await db.runTransaction(async (tx) => {
      const [taskSnap, userSnap] = await Promise.all([tx.get(taskRef), tx.get(userRef)]);

      if (!taskSnap.exists) return { error: 'Task not found' };
      if (!userSnap.exists) return { error: 'User not found' };

      const task = taskSnap.data();
      const user = userSnap.data();

      if (user.isBanned) return { error: 'Account banned' };

      const completed = user.completedTasks || [];
      if (completed.includes(taskId)) return { error: 'Task already completed' };

      const reward = task.reward || 10;

      tx.update(userRef, {
        completedTasks: admin.firestore.FieldValue.arrayUnion(taskId),
        diamondBalance: admin.firestore.FieldValue.increment(reward),
      });

      return { success: true, reward };
    });

    if (result.error) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    console.error('[claimTask]', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
