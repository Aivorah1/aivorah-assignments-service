// A provider put on cooldown by one test (e.g. a mocked 429) must not be
// skipped in the next one.
beforeEach(() => {
  require('./services/providerCooldown').resetProviderCooldowns();
});
