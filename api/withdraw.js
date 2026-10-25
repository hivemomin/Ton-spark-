// lib/referral.js — NEWTUBE-style referral reward.
//
//  • The friend becomes a VALID referral after VALID_TASKS tasks + VALID_ADS ads.
//  • At that moment the referrer gets REFERRAL_REWARD_SP (300 SP) — once, atomic.
//  • Plus WITHDRAW_COMMISSION_PERCENT (15%) of every withdrawal the friend makes
//    (paid by api/bot.js when the admin approves the withdrawal).

import { REFERRAL_REWARD_SP, VALID_TASKS, VALID_ADS } from './constants.js';
import { tgSend } from './telegram.js';

// `user` = the referred user's document AFTER the action that may have completed the requirements.
export async function maybeAwardValidReferral(db, user) {
  if (!user?.referredBy || user.refereeValid) return false;
  if ((user.completedTasks?.length || 0) < VALID_TASKS) return false;
  if ((user.totalAdsWatched || 0) < VALID_ADS) return false;
  if (user.accountLocked || user.isBanned) return false; // farmed / locked accounts never pay their referrer

  const users = db.collection('users');
  // Atomic: only ONE concurrent call can flip refereeValid false→true.
  const flagged = await users.findOneAndUpdate(
    { telegramId: user.telegramId, refereeValid: { $ne: true } },
    { $set: { refereeValid: true, refereeValidAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!(flagged?.value || flagged)) return false;

  const paid = await users.findOneAndUpdate(
    { telegramId: user.referredBy, isBanned: { $ne: true }, accountLocked: { $ne: true } },
    { $inc: { spBalance: REFERRAL_REWARD_SP, totalRefEarnedSP: REFERRAL_REWARD_SP, validReferralCount: 1 } }
  );
  if (paid) {
    tgSend(user.referredBy,
      `🎉 <b>Referral verified!</b>\n\nOne of your friends completed ${VALID_TASKS} tasks and ${VALID_ADS} ads.\nYou earned <b>+${REFERRAL_REWARD_SP} SP</b> ⚡\n\nYou will also earn a commission on every withdrawal they make.`
    ).catch(() => {});
  }
  return true;
}
