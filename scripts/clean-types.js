#!/usr/bin/env node
'use strict';

/**
 * Remove generated .d.ts before `tsc` re-emits them.
 *
 * `tsc` treats a pre-existing co-located .d.ts as a declaration *input* and
 * refuses to overwrite it (error TS5055), so `build:types` is not idempotent
 * without this clean — a second local run (or a publish from a tree that
 * already has emitted declarations) would fail. Pure Node, no deps, so it
 * works cross-platform (the rest of the toolchain shells out to nothing).
 *
 * Only the GENERATED declarations under src/, tools/, bin/ and the root
 * index.d.ts are removed. The hand-written shared shapes in types/ are
 * tracked in git and left untouched.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src', 'tools', 'bin'];

let removed = 0;

/** @param {string} dir */
function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist yet — nothing to clean
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith('.d.ts')) {
      fs.rmSync(full);
      removed++;
    }
  }
}

for (const dir of DIRS) walk(path.join(ROOT, dir));

const rootDts = path.join(ROOT, 'index.d.ts');
if (fs.existsSync(rootDts)) {
  fs.rmSync(rootDts);
  removed++;
}
// types/*.d.ts are intentionally NOT touched — they are hand-written and tracked.

if (removed) {
  process.stdout.write(`[clean-types] removed ${removed} generated .d.ts\n`);
}
