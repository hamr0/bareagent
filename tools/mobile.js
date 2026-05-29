'use strict';

/** @typedef {import('../types').ToolDef} ToolDef */

/**
 * A connected baremobile page/device handle. baremobile ships no types, so the
 * surface used here is described structurally; all calls resolve to `any`.
 * @typedef {any} MobilePage
 */

/**
 * Creates mobile control tools via baremobile (optional dep).
 * Returns { tools, close } or null if baremobile is not installed.
 *
 * Tools follow the snapshot() → tap(ref) observe-act pattern.
 * Action tools auto-return a fresh snapshot so the LLM sees the result.
 * Supports dual platform: Android (default) and iOS via platform option.
 *
 * @param {object} [opts] - Options passed to baremobile connect()
 * @param {string} [opts.platform] - 'android' (default) or 'ios'
 * @param {string} [opts.device] - Device serial or 'auto'
 * @param {boolean} [opts.termux] - Use Termux ADB on-device mode
 * @returns {Promise<{tools: ToolDef[], close: Function}|null>}
 */
async function createMobileTools(opts = {}) {
  const platform = opts.platform || 'android';

  /** @type {(opts: object) => Promise<MobilePage>} */
  let connectFn;
  try {
    if (platform === 'ios') {
      // baremobile/ios is declared as an ambient `any` module in types/shims.d.ts.
      ({ connect: connectFn } = await import('baremobile/ios'));
    } else {
      ({ connect: connectFn } = await import('baremobile'));
    }
  } catch {
    return null;
  }

  const SETTLE_MS = 1000;
  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

  /** @type {MobilePage|null} */
  let _page = null;

  async function getPage() {
    if (!_page) _page = await connectFn(opts);
    return _page;
  }

  /** @param {(page: MobilePage) => any} fn */
  async function actionAndSnapshot(fn) {
    const page = await getPage();
    await fn(page);
    await settle();
    return await page.snapshot();
  }

  /** @type {ToolDef[]} */
  const tools = [
    {
      name: 'mobile_snapshot',
      description: 'Get the current mobile screen as a pruned accessibility snapshot. Returns a YAML-like tree with [ref=N] markers on interactive elements. Always call after actions to observe the result.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const page = await getPage();
        return await page.snapshot();
      },
    },
    {
      name: 'mobile_tap',
      description: 'Tap a mobile screen element by its ref from the snapshot. Returns updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'number', description: 'Element ref number from snapshot' },
        },
        required: ['ref'],
      },
      execute: async (/** @type {{ ref: number }} */ { ref }) => actionAndSnapshot((page) => page.tap(ref)),
    },
    {
      name: 'mobile_type',
      description: 'Type text into a mobile element. Taps to focus first if not focused. Returns updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'number', description: 'Element ref from snapshot' },
          text: { type: 'string', description: 'Text to type' },
          clear: { type: 'boolean', description: 'Clear existing content first (default: false)' },
        },
        required: ['ref', 'text'],
      },
      execute: async (/** @type {{ ref: number, text: string, clear?: boolean }} */ { ref, text, clear }) => actionAndSnapshot((page) => page.type(ref, text, { clear })),
    },
    {
      name: 'mobile_press',
      description: 'Press a key on the mobile device. Keys: back, home, enter, delete, tab, escape, up, down, left, right, space, power, volup, voldown, recent. Returns updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name (e.g. "back", "home", "enter")' },
        },
        required: ['key'],
      },
      execute: async (/** @type {{ key: string }} */ { key }) => actionAndSnapshot((page) => page.press(key)),
    },
    {
      name: 'mobile_scroll',
      description: 'Scroll a mobile element in a direction. Returns updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'number', description: 'Element ref to scroll' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        },
        required: ['ref', 'direction'],
      },
      execute: async (/** @type {{ ref: number, direction: string }} */ { ref, direction }) => actionAndSnapshot((page) => page.scroll(ref, direction)),
    },
    {
      name: 'mobile_swipe',
      description: 'Swipe between two screen coordinates on the mobile device. Returns updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          x1: { type: 'number', description: 'Start X' },
          y1: { type: 'number', description: 'Start Y' },
          x2: { type: 'number', description: 'End X' },
          y2: { type: 'number', description: 'End Y' },
          duration: { type: 'number', description: 'Duration in ms (default: 300)' },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
      },
      execute: async (/** @type {{ x1: number, y1: number, x2: number, y2: number, duration?: number }} */ { x1, y1, x2, y2, duration }) => actionAndSnapshot((page) => page.swipe(x1, y1, x2, y2, duration)),
    },
    {
      name: 'mobile_long_press',
      description: 'Long-press a mobile element by its ref. Returns updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'number', description: 'Element ref from snapshot' },
        },
        required: ['ref'],
      },
      execute: async (/** @type {{ ref: number }} */ { ref }) => actionAndSnapshot((page) => page.longPress(ref)),
    },
    {
      name: 'mobile_launch',
      description: 'Launch a mobile app by package name (Android) or bundle ID (iOS). Returns updated snapshot after 2s settle.',
      parameters: {
        type: 'object',
        properties: {
          pkg: { type: 'string', description: 'App identifier (e.g. "com.android.settings" or "com.apple.Preferences")' },
        },
        required: ['pkg'],
      },
      execute: async (/** @type {{ pkg: string }} */ { pkg }) => {
        const page = await getPage();
        await page.launch(pkg);
        await new Promise((r) => setTimeout(r, 2000));
        return await page.snapshot();
      },
    },
    {
      name: 'mobile_back',
      description: 'Navigate back on the mobile device. Returns updated snapshot.',
      parameters: { type: 'object', properties: {} },
      execute: async () => actionAndSnapshot((page) => page.back()),
    },
    {
      name: 'mobile_home',
      description: 'Press the home button on the mobile device. Returns updated snapshot.',
      parameters: { type: 'object', properties: {} },
      execute: async () => actionAndSnapshot((page) => page.home()),
    },
    {
      name: 'mobile_screenshot',
      description: 'Take a screenshot of the mobile screen. Returns base64-encoded PNG.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const page = await getPage();
        const buf = await page.screenshot();
        return buf.toString('base64');
      },
    },
    {
      name: 'mobile_tap_xy',
      description: 'Tap by pixel coordinates on the mobile screen. Use when elements lack refs. Returns updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
        },
        required: ['x', 'y'],
      },
      execute: async (/** @type {{ x: number, y: number }} */ { x, y }) => actionAndSnapshot((page) => page.tapXY(x, y)),
    },
  ];

  // Android-only tools
  if (platform !== 'ios') {
    tools.push(
      {
        name: 'mobile_intent',
        description: 'Launch an Android intent action for deep navigation. Skips multi-step UI navigation. Returns updated snapshot.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'Intent action (e.g. "android.settings.BLUETOOTH_SETTINGS")' },
            extras: { type: 'object', description: 'Intent extras as key-value pairs' },
          },
          required: ['action'],
        },
        execute: async (/** @type {{ action: string, extras?: object }} */ { action, extras }) => actionAndSnapshot((page) => page.intent(action, extras || {})),
      },
      {
        name: 'mobile_tap_grid',
        description: 'Tap by grid cell (e.g. "C5") for vision-based fallback. Use with mobile_grid to get cell layout. Returns updated snapshot.',
        parameters: {
          type: 'object',
          properties: {
            cell: { type: 'string', description: 'Grid cell (e.g. "C5", "A1")' },
          },
          required: ['cell'],
        },
        execute: async (/** @type {{ cell: string }} */ { cell }) => actionAndSnapshot((page) => page.tapGrid(cell)),
      },
      {
        name: 'mobile_grid',
        description: 'Get grid layout info for the mobile screen. Use with mobile_screenshot for vision-based interaction when the accessibility tree is unreliable.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          const page = await getPage();
          const grid = await page.grid();
          return grid.text;
        },
      },
    );
  }

  // iOS-only tools
  if (platform === 'ios') {
    tools.push({
      name: 'mobile_unlock',
      description: 'Unlock the iOS device with a passcode.',
      parameters: {
        type: 'object',
        properties: {
          passcode: { type: 'string', description: 'Device passcode' },
        },
        required: ['passcode'],
      },
      execute: async (/** @type {{ passcode: string }} */ { passcode }) => actionAndSnapshot((page) => page.unlock(passcode)),
    });
  }

  // Find tools (both platforms, no device call — reads refMap from last snapshot)
  tools.push({
    name: 'mobile_find_text',
    description: 'Find an interactive element by visible text or accessibility label. Searches the refMap from the last snapshot — no device call. Returns the ref number or null if not found.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text or label substring to search for' },
      },
      required: ['text'],
    },
    execute: async (/** @type {{ text: string }} */ { text }) => {
      const page = await getPage();
      const ref = page.findByText(text);
      return ref !== null && ref !== undefined ? ref : null;
    },
  });

  // Wait tools (both platforms)
  tools.push(
    {
      name: 'mobile_wait_text',
      description: 'Wait until specific text appears on the mobile screen. Polls snapshot every 500ms. Returns snapshot when found or throws on timeout.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to wait for' },
          timeout: { type: 'number', description: 'Timeout in ms (default: 10000)' },
        },
        required: ['text'],
      },
      execute: async (/** @type {{ text: string, timeout?: number }} */ { text, timeout }) => {
        const page = await getPage();
        return await page.waitForText(text, timeout || 10000);
      },
    },
    {
      name: 'mobile_wait_state',
      description: 'Wait until an element reaches a specific state. States: enabled, disabled, checked, unchecked, focused, selected. Returns snapshot when matched.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'number', description: 'Element ref from snapshot' },
          state: { type: 'string', enum: ['enabled', 'disabled', 'checked', 'unchecked', 'focused', 'selected'], description: 'Target state' },
          timeout: { type: 'number', description: 'Timeout in ms (default: 10000)' },
        },
        required: ['ref', 'state'],
      },
      execute: async (/** @type {{ ref: number, state: string, timeout?: number }} */ { ref, state, timeout }) => {
        const page = await getPage();
        return await page.waitForState(ref, state, timeout || 10000);
      },
    },
  );

  return {
    tools,
    async close() {
      if (_page) {
        _page.close();
        _page = null;
      }
    },
  };
}

module.exports = { createMobileTools };
