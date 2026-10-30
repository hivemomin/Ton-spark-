// FILE PATH: lib/referral.js
//
// Referral rewards, paid to the REFERRER step by step as the referred friend progresses.
// Every step pays exactly once (an atomic flag flip on the friend's document guards it):
//
//   Step 1  friend joined the payout channel + verified   → REF_JOIN_SP   (50 SP)
//   Step 2  friend watched VALID_ADS ads                  → REF_ADS_SP    (200 SP)
//   Step 3  friend completed VALID_TASKS tasks            → REF_TASKS_SP  (200 SP)
//   Step 4  15% withdraw commission — handled in api/bot.js when the admin APPROVES a withdrawal.
//
// After steps 2 + 3 the friend is marked `refereeValid` (used by api/withdraw.js: bigger
// withdrawals need 1 valid referral) and the referrer's validReferralCount goes up by one.
//
// Called from api/tasks.js, api/adwatch.js, api/tower.js and api/user.js (verifyChannel).
// Never throws — a referral hiccup must never break the task / ad reward itself.

import {
  VALID_TASKS, VALID_ADS, REF_JOIN_SP, REF_ADS_SP, REF_TASKS_SP,
} from './constants.js';
import { tgSend } from './telegram.js';

// flag = field on the FRIEND's document that records "this step was already paid".
const STEPS = [
  { key: 'join',  flag: 'refJoinPaid',  sp: REF_JOIN_SP,  label: 'joined the payout channel',
    done: (u) => u.channelJoined === true },
  { key: 'ads',   flag: 'refAdsPaid',   sp: REF_ADS_SP,   label: `watched ${VALID_ADS} ads`,
    done: (u) => (u.totalAdsWatched || 0) >= VALID_ADS },
  { key: 'tasks', flag: 'refTasksPaid', sp: REF_TASKS_SP, label: `completed ${VALID_TASKS} tasks`,
    done: (u) => (u.completedTasks || []).length >= VALID_TASKS },
];

// `user` = the friend's document AFTER the update that just happened.
export async function maybeAwardReferralSteps(db, user) {
  try {
    if (!user || !user.referredBy) return;
    // Friends who were ALREADY marked valid under the old single-reward system were paid in full back then —
    // never pay their ads/tasks steps a second time (only the new channel step can still be earned).
    const due = STEPS.filter((s) => !user[s.flag] && s.done(user) && !(user.refereeValid && s.key !== 'join'));
    const needValid = !user.refereeValid && user.refAdsPaid && user.refTasksPaid;
    if (!due.length && !needValid) return;

    const users = db.collection('users');

    // Pay nobody who is banned / locked (same rule as the withdraw commission in bot.js).
    const referrer = await users.findOne(
      { telegramId: String(user.referredBy) },
      { projection: { isBanned: 1, accountLocked: 1 } }
    );
    if (!referrer || referrer.isBanned || referrer.accountLocked) return;

    for (const s of due) {
      // Atomic: only ONE request can flip this step's flag false -> true, so the
      // referrer is paid exactly once even if two claims arrive at the same moment.
      const flipped = await users.findOneAndUpdate(
        { telegramId: user.telegramId, [s.flag]: { $ne: true } },
        { $set: { [s.flag]: true, [`${s.flag}At`]: new Date() } },
        { returnDocument: 'after' }
      );
      const got = flipped?.value || flipped;
      if (!got) continue; // somebody else already paid this step

      await users.updateOne(
        { telegramId: String(user.referredBy) },
        { $inc: { spBalance: s.sp, totalRefEarnedSP: s.sp } }
      );
      tgSend(String(user.referredBy),
        `🎁 <b>Referral reward!</b>\n\nYour friend <b>${user.firstName || 'a friend'}</b> ${s.label}.\nYou earned <b>+${s.sp} SP</b> ⚡`
      ).catch(() => {});
    }

    // Valid referral = ads step AND tasks step both paid (flips once). Re-read so a parallel request's flag is seen.
    const fresh = await users.findOne(
      { telegramId: user.telegramId },
      { projection: { refAdsPaid: 1, refTasksPaid: 1, refereeValid: 1 } }
    );
    if (fresh && !fresh.refereeValid && fresh.refAdsPaid && fresh.refTasksPaid) {
      const mark = await users.findOneAndUpdate(
        { telegramId: user.telegramId, refereeValid: { $ne: true } },
        { $set: { refereeValid: true, refereeValidAt: new Date() } },
        { returnDocument: 'after' }
      );
      if (mark?.value || mark) {
        await users.updateOne({ telegramId: String(user.referredBy) }, { $inc: { validReferralCount: 1 } });
      }
    }
  } catch (err) {
    console.error('referral.js error:', err);
  }
}

// Old name kept so api/tasks.js, api/adwatch.js and api/tower.js keep working unchanged.
export const maybeAwardValidReferral = maybeAwardReferralSteps;
