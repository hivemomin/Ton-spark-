// lib/towers.js — Electricity tower config + state, shared by api/tower.js and api/user.js
// (api/user.js sends the tower state with the login response, so opening the Electricity tab needs NO extra request).

const HOUR = 3600000;

// ads:true → a rewarded ad is shown before the claim. Flip to false to make a tower ad-free.
export const TOWERS = {
  1: { cost: 0,     reward: 25,  intervalMs: 1 * HOUR,  ads: true },
  2: { cost: 500,   reward: 50,  intervalMs: 2 * HOUR,  ads: true },
  3: { cost: 3000,  reward: 100, intervalMs: 4 * HOUR,  ads: true },
  4: { cost: 10000, reward: 150, intervalMs: 12 * HOUR, ads: true },
};

export function towerState(user, now) {
  const out = {};
  for (const [n, cfg] of Object.entries(TOWERS)) {
    const t = user.towers?.[`t${n}`] || {};
    const unlocked = cfg.cost === 0 || !!t.unlocked;
    const last = t.lastClaim ? new Date(t.lastClaim).getTime() : null;
    const readyAt = last ? last + cfg.intervalMs : 0;
    const nextMs = unlocked ? Math.max(0, readyAt - now) : 0;
    out[n] = {
      n: Number(n), cost: cfg.cost, reward: cfg.reward, intervalMs: cfg.intervalMs, ads: cfg.ads,
      unlocked, canClaim: unlocked && nextMs === 0, nextMs,
      totalClaims: t.claims || 0, totalSp: t.total || 0,
    };
  }
  return out;
}
