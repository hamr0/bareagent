'use strict';

/**
 * BA-24: the discriminator between an ABSENT usage block and a PRESENT one whose token fields are
 * legitimately 0.
 *
 * A provider that returns no usage information (the API sent a 200 with no `usage` block, or an empty
 * `{}`) must surface `usage: null` so the round reads as UNPRICEABLE — `resolveRoundCost`'s
 * `if (!usage) return {cost:null, source:null}` branch (the honest-null contract) only fires on a
 * falsy usage. Coalescing an absent block into an all-zeros object (`data.usage?.field || 0` built
 * unconditionally) launders that unknown into a $0 PRICED round — worse, at the confident `'tier'`
 * rate label, so a consumer filtering for `'default'` guesses never sees it. That laundering was the
 * BA-23 fix relocated one layer up: loop.js stopped feeding stale usage to the resolver, but every
 * http provider still MANUFACTURED a truthy zero object, so the null branch stayed unreachable on the
 * paid path.
 *
 * Per-field `|| 0` stays correct (a real round can report an individual tier as 0); it is the coalescing
 * of the WHOLE block's absence into a default object that is the bug. A present block with an explicit
 * zero — e.g. a cache-only round: `input_tokens:0` + `cache_read_input_tokens>0` — carries a signal and
 * stays priced, because that field is present (`!= null`), even at value 0.
 *
 * @param {any} block - raw provider usage object (`data.usage` / `usageMetadata` / the CLI envelope's `usage`)
 * @param {string[]} keys - the recognized raw field names for this provider
 * @returns {boolean} true iff `block` is an object carrying at least one recognized field as a non-null value
 */
function hasUsageSignal(block, keys) {
  if (!block || typeof block !== 'object') return false;
  for (const k of keys) {
    if (block[k] != null) return true;
  }
  return false;
}

module.exports = { hasUsageSignal };
