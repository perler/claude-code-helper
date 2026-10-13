// The live tree providers, filled in by activate(). They live here, in a module
// nothing else depends on, so the launcher can nudge the Recent Sessions tree after a launch
// without depending on the views themselves.
const providers = { sess: null };

// ─── favourites ──────────────────────────────────────────────────────────────

module.exports = {
  providers,
};
