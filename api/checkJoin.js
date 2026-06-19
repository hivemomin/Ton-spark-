// api/checkJoin.js
// GET ?userId=...&force=1
// Checks whether the user has joined BOTH the official Channel and Community
// using the Telegram Bot API (getChatMember). The bot must be an ADMIN in
// both the channel and the group for this to work.

const { db } = require('../lib/firebaseAdmin');
const { handlePreflight } = require('../lib/helpers');

const CHANNEL_ID = '@TonsparkSp';
const GROUP_ID = '@Tonsparksp_chats';
const BOT_TOKEN = process.env.BOT_TOKEN;

const OK_STATUSES = ['member', 'administrator', 'creator'];

async function isMember(chatId, userId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
  const r = await fetch(url);
  const data = await r.json();
  if (!data.ok) return false;
  return OK_STATUSES.includes(data.result?.status);
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const [inChannel, inGroup] = await Promise.all([
      isMember(CHANNEL_ID, userId),
      isMember(GROUP_ID, userId),
    ]);

    const joined = inChannel && inGroup;

    if (joined) {
      await db.collection('users').doc(String(userId)).update({ hasJoinedCommunity: true }).catch(() => {});
    }

    return res.json({ joined, inChannel, inGroup });
  } catch (err) {
    console.error('[checkJoin]', err);
    // Fail open-ish: don't block the whole app if Telegram API hiccups,
    // but report not-joined so the modal stays until it succeeds.
    return res.status(500).json({ joined: false, error: 'Server error' });
  }
};
