#!/usr/bin/env node
// Thin per-repo entry point: loads this repo's config and runs the shared
// generator core. Keeps `npm run build:primitives` / `check:primitives`
// working unchanged. The actual generator logic lives in
// scripts/primitives-core.mjs — vendored byte-identically across bare-agent,
// bareguard, and litectx (pinned by test/primitives-core.test.mjs). Never edit
// primitives-core.mjs in a way that diverges from the other repos' copies;
// change the CANONICAL copy (this one, in bare-agent) and re-vendor.
//
//   node scripts/gen-primitives.mjs           # write ./primitives.json
//   node scripts/gen-primitives.mjs --check    # CI gate: verify the file is current + valid, write nothing
//
// See docs/product/prd.md § "Primitives manifest".
import { run } from './primitives-core.mjs';
import config from '../primitives.config.mjs';

await run(config);
