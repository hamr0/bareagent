'use strict';

/**
 * Creates browsing tools via barebrowse (optional dep).
 * Returns { tools, close } or null if barebrowse is not installed.
 * @param {object} [opts] - Options passed to barebrowse createBrowseTools
 * @returns {Promise<{tools: Array, close: Function}|null>}
 */
async function createBrowsingTools(opts = {}) {
  try {
    // barebrowse is an optional dep; the subpath is declared as an ambient `any`
    // module in types/shims.d.ts and resolves to `any` at runtime.
    const { createBrowseTools } = await import('barebrowse/bareagent');
    return createBrowseTools(opts);
  } catch {
    return null;
  }
}

module.exports = { createBrowsingTools };
