import crypto from 'crypto';

// How old a Telegram WebApp initData payload is allowed to be before we
// stop trusting it. initData is HMAC-signed by Telegram at the moment the
// Mini App is opened (auth_date), so this isn't about session expiry in
// the usual sense — it's about not honoring a *captured/replayed* initData
// string indefinitely. Telegram itself recommends checking auth_date;
// 24h comfortably covers a normal open-app session without forcing people
// to constantly reopen the bot.
const MAX_INIT_DATA_AGE_SECONDS = 24 * 3600;

export function verifyTelegramInit(initData, maxAgeSeconds = MAX_INIT_DATA_AGE_SECONDS) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');
    const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    // Constant-time comparison — a plain !== leaks timing info about how
    // many leading bytes of the hash matched, which in theory helps an
    // attacker guess their way to a valid hash byte-by-byte. timingSafeEqual
    // needs equal-length buffers, so mismatched lengths are rejected first.
    const expectedBuf = Buffer.from(expectedHash, 'hex');
    const gotBuf = Buffer.from(hash, 'hex');
    if (expectedBuf.length !== gotBuf.length) return null;
    if (!crypto.timingSafeEqual(expectedBuf, gotBuf)) return null;

    // Reject stale initData so a leaked/logged/screen-recorded initData
    // string can't be replayed forever to impersonate someone — it only
    // works within maxAgeSeconds of when Telegram actually issued it.
    const authDate = Number(params.get('auth_date'));
    if (!authDate || Number.isNaN(authDate)) return null;
    const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
    if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) return null;

    const user = JSON.parse(params.get('user') || '{}');
    return user;
  } catch {
    return null;
  }
}

export function isAdmin(telegramId) {
  return String(telegramId) === String(process.env.ADMIN_ID);
}
