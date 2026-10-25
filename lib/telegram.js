// lib/telegram.js — tiny Telegram send helper shared by API files.
const BOT_TOKEN = process.env.BOT_TOKEN;

export async function tgSend(chatId, text, extra = {}) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
    });
    return await r.json();
  } catch {
    return { ok: false };
  }
}
