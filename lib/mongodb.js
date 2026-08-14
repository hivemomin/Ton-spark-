import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;

// Cache the connection across warm serverless invocations. If a connection
// attempt fails (e.g. IP not whitelisted yet), the cached promise must be
// cleared — otherwise every future call in that warm instance keeps
// re-awaiting the same rejected promise and never retries, even after the
// underlying problem (like the IP whitelist) is fixed.
function connect() {
  const client = new MongoClient(uri);
  const promise = client.connect();
  promise.catch(() => {
    if (global._mongoClientPromise === promise) {
      global._mongoClientPromise = null;
    }
  });
  return promise;
}

if (!global._mongoClientPromise) {
  global._mongoClientPromise = connect();
}

// Runs once per warm serverless instance (guarded by the module-level flag
// below), not on every request. createIndex is a no-op if the index
// already exists, so this is safe to call repeatedly across cold starts too.
let indexesEnsured = false;
async function ensureIndexes(db) {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    // Promo codes: auto-delete once expiresAt passes, instead of sitting in
    // the DB forever after their 24h window closes.
    await db.collection('promos').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // IP registry: bound growth by dropping entries nobody has touched in a
    // year — long enough to not weaken the one-account-per-IP check in
    // practice, short enough to stop it growing unbounded on a free tier.
    await db.collection('ipRegistry').createIndex({ updatedAt: 1 }, { expireAfterSeconds: 31536000 });
    // Withdrawal history: auto-delete records 6 months after they were
    // created, but ONLY once they're no longer pending — a partial index so
    // an open withdrawal request can never silently vanish while waiting on
    // admin review, only its long-settled history eventually clears out.
    await db.collection('withdrawals').createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 15552000, partialFilterExpression: { status: { $ne: 'pending' } } }
    );
  } catch (err) {
    // Index creation failing (e.g. race with another cold start, or an
    // existing index with different options) shouldn't break requests.
    console.error('ensureIndexes error:', err);
  }
}

export async function getDb() {
  if (!global._mongoClientPromise) {
    global._mongoClientPromise = connect();
  }
  const c = await global._mongoClientPromise;
  const db = c.db('tonspark');
  await ensureIndexes(db);
  return db;
}

export default global._mongoClientPromise;
