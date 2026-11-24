// AI providers that failed in a way waiting won't fix soon (rate limit, quota,
// auth, missing key) are skipped for a while instead of costing every worksheet
// a round trip. Shared by the worksheet pipeline (quizVision.js) and the
// health check (GET /quiz/providers). No dependencies, so tests can reset it.
const COOLDOWN_MS = 10 * 60 * 1000;
const LASTING = ['RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_FAILURE', 'DISABLED'];
const downUntil = new Map();

function markProviderResult(name, status) {
  if (LASTING.includes(status)) downUntil.set(name, Date.now() + COOLDOWN_MS);
  else if (status === 'OK') downUntil.delete(name);
}

function isProviderCoolingDown(name) {
  const until = downUntil.get(name);
  return !!until && until > Date.now();
}

function resetProviderCooldowns() { downUntil.clear(); }

module.exports = { markProviderResult, isProviderCoolingDown, resetProviderCooldowns, COOLDOWN_MS };
