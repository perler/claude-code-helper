// The live tree providers, filled in by activate(). They live here, in a module
// nothing else depends on, so the launcher can nudge the Recent Sessions and Agent
// Sessions trees after a launch without depending on the views themselves.
const providers = { sess: null, agent: null };

// ─── favourites ──────────────────────────────────────────────────────────────

module.exports = {
  providers,
};
