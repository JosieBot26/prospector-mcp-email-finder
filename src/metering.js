// ============================================================
// Prospector — Usage Metering & Rate Limiting
// ============================================================
// In-memory metering with daily reset. Tracks verifications
// per client. Free tier: 50/day. No signup required.
// ============================================================

const FREE_TIER_DAILY_LIMIT = 50;
const PAID_TIERS = {
  pro: 500,
  business: 2000,
  unlimited: Infinity,
};

// In-memory usage tracker: Map<clientId, { count, resetDate }>
const usage = new Map();

function getToday() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getUsageRecord(clientId) {
  const today = getToday();
  let record = usage.get(clientId);
  if (!record || record.resetDate !== today) {
    record = { count: 0, resetDate: today };
    usage.set(clientId, record);
  }
  return record;
}

/**
 * Check if a client can make a verification request.
 * @param {string} clientId - Client identifier (IP, API key, or session ID)
 * @param {string} [tier='free'] - Pricing tier
 * @param {number} [count=1] - Number of verifications in this request
 * @returns {{ allowed: boolean, remaining: number, limit: number, resetDate: string }}
 */
export function checkQuota(clientId, tier = 'free', count = 1) {
  const limit = PAID_TIERS[tier] || FREE_TIER_DAILY_LIMIT;
  const record = getUsageRecord(clientId);
  const remaining = Math.max(0, limit - record.count);

  return {
    allowed: record.count + count <= limit,
    remaining,
    limit,
    used: record.count,
    resetDate: record.resetDate,
  };
}

/**
 * Record usage after a successful verification.
 * @param {string} clientId
 * @param {number} [count=1]
 */
export function recordUsage(clientId, count = 1) {
  const record = getUsageRecord(clientId);
  record.count += count;
}

/**
 * Get usage stats for a client.
 */
export function getUsageStats(clientId, tier = 'free') {
  const limit = PAID_TIERS[tier] || FREE_TIER_DAILY_LIMIT;
  const record = getUsageRecord(clientId);
  return {
    used: record.count,
    remaining: Math.max(0, limit - record.count),
    limit,
    tier,
    resetDate: record.resetDate,
  };
}

/**
 * Get global stats (for admin/monitoring).
 */
export function getGlobalStats() {
  const today = getToday();
  let totalClients = 0;
  let totalVerifications = 0;

  for (const [, record] of usage) {
    if (record.resetDate === today) {
      totalClients++;
      totalVerifications += record.count;
    }
  }

  return { date: today, activeClients: totalClients, totalVerifications };
}
