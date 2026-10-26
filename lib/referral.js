// FILE PATH: lib/referral.js
//
// "Valid referral" check shared by api/tasks.js, api/adwatch.js and api/tower.js.
// When a referred friend has finished VALID_TASKS tasks AND watched VALID_ADS ads,
// the friend is marked refereeValid and the referrer gets REFERRAL_REWARD_SP once.

import { VALID_TASKS, VALID_ADS, REFERRAL_REWARD_SP } from './constants.js';

// `user` = the friend's document AFTER the update that just happened.
// Never throws — a referral hiccup must never break the task/ad reward itself.
export async function maybeAwardValidReferral(db, user) {
  try {
    if (!user || !user.referredBy || user.refereeValid) return;

    const tasksDone = (user.completedTasks || []).length;
    const adsDone = user.totalAdsWatched || 0;
    if (tasksDone < VALID_TASKS || adsDone < VALID_ADS) return;

    const users = db.collection('users');

    // Atomic: only ONE request can flip refereeValid false -> true, so the
    // referrer is paid exactly once even if two claims arrive together.
    const flipped = await users.findOneAndUpdate(
      { telegramId: user.telegramId, refereeValid: { $ne: true } },
      { $set: { refereeValid: true, refereeValidAt: new Date() } },
      { returnDocument: 'after' }
    );
    const done = flipped?.value || flipped;
    if (!done) return; // somebody else already awarded it

    await users.updateOne(
      { telegramId: String(user.referredBy) },
      { $inc: { spBalance: REFERRAL_REWARD_SP, totalRefEarnedSP: REFERRAL_REWARD_SP, validReferralCount: 1 } }
    );
  } catch (err) {
    console.error('referral.js error:', err);
  }
}
