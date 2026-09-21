'use strict';

// Completeness guard for the primitives manifest.
//
// A primitive is any exported symbol whose JSDoc carries @when (see
// scripts/gen-primitives.mjs + docs/product/prd.md § "Primitives manifest").
// This test fails if a PUBLIC export is neither in primitives.json nor on the
// deliberate-exclusion allow-list below — so a NEW export can never silently
// miss the manifest. The allow-list is the repo's curation policy, owned here
// (the generator stays generic and knows nothing of these names).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const manifest = require(path.join(ROOT, 'primitives.json'));
const manifested = new Set(manifest.primitives.map((p) => p.name));
const pkg = require(path.join(ROOT, 'package.json'));

// Every public entry point, DERIVED from package.json "exports" (no hand-sync
// needed — resolved through the package name so a broken exports map target
// is caught here too, not just a broken src path).
const EXPORT_KEYS = Object.keys(pkg.exports).filter(
  (k) => k !== './package.json' && k !== './primitives.json'
);
const SELF_REF_SPECIFIERS = EXPORT_KEYS.map(
  (k) => (k === '.' ? pkg.name : pkg.name + k.slice(1))
);

// Deliberate exclusions — WHY each is out (see the PRD decision + session notes):
const EXCLUDED = new Set([
  // Bare error classes: you catch them, you don't construct them as a capability —
  // they live inside the `fails` line of whatever throws them.
  'BareAgentError', 'ProviderError', 'ToolError', 'TimeoutError',
  'ValidationError', 'CircuitOpenError', 'HaltError',
  // Provider short-aliases: same class already manifested under `<X>Provider`.
  'Anthropic', 'OpenAI', 'Gemini', 'Ollama', 'CLIPipe', 'Fallback', 'Jev',
  // Calibration test-harness surface: `calibrate` is the primitive; these are its fixtures/helpers.
  'CALIBRATION_CASES', 'INJECTION_BATTERY', 'scoreCase', 'gradeRun', 'constantHonored',
  // Neutral-unit converters: the SEAMS (unitAssembler/unitTrimmer/harvestKey) are the primitives.
  'toUnits', 'fromUnits',
  // Niche config helper (the default action translator for wireGate).
  'defaultActionTranslator',
]);

function allExports() {
  const names = new Set();
  for (const specifier of SELF_REF_SPECIFIERS) {
    const mod = require(specifier);
    for (const n of Object.keys(mod)) names.add(n);
  }
  return names;
}

test('every public export is manifested or explicitly excluded', () => {
  const missing = [...allExports()].filter((n) => !manifested.has(n) && !EXCLUDED.has(n)).sort();
  assert.deepStrictEqual(missing, [],
    `These exports are neither in primitives.json nor on the exclusion allow-list. ` +
    `Add @when/@fails/@example to each (and run \`npm run build:primitives\`), ` +
    `or add it to EXCLUDED here with a reason:\n  ${missing.join('\n  ')}`);
});

test('every package.json export subpath resolves through the package name', () => {
  // Self-referencing (`require('bare-agent/x')` from inside the package) resolves
  // via this package's OWN "exports" — Node never consults node_modules for it —
  // so there is no shadowing-install risk to guard against; it always exercises
  // the working tree's exports map, which is exactly what a broken map breaks.
  const failures = [];
  for (let i = 0; i < EXPORT_KEYS.length; i++) {
    try {
      require(SELF_REF_SPECIFIERS[i]);
    } catch (e) {
      failures.push(`${EXPORT_KEYS[i]} (require('${SELF_REF_SPECIFIERS[i]}')): ${e.message}`);
    }
  }
  assert.deepStrictEqual(failures, [],
    `These package.json "exports" subpaths do not resolve via the package name — ` +
    `the exports map is broken for a real consumer even though the src file may exist:\n  ${failures.join('\n  ')}`);
});

test('exclusion allow-list has no stale entries', () => {
  // An excluded name that is ALSO manifested, or no longer exported, means the list drifted.
  const exportNames = allExports();
  const stale = [...EXCLUDED].filter((n) => manifested.has(n) || !exportNames.has(n)).sort();
  assert.deepStrictEqual(stale, [],
    `EXCLUDED entries that are now manifested or no longer exported — remove them:\n  ${stale.join('\n  ')}`);
});

test('manifest is well-formed: every entry has the required fields', () => {
  for (const p of manifest.primitives) {
    for (const f of ['name', 'category', 'when', 'import', 'signature', 'fails', 'example']) {
      assert.ok(p[f] && String(p[f]).trim(), `primitive ${p.name || '(unnamed)'} missing field: ${f}`);
    }
  }
});

test('manifest shape is exactly {package, primitives} — pins the no-version decision', () => {
  // Suite-wide convention: no `version` field (package.json carries the authoritative
  // one, beside the manifest in the same tarball). This pins it so it cannot drift back.
  assert.deepStrictEqual(Object.keys(manifest).sort(), ['package', 'primitives']);
});

test('every @example is syntactically valid ESM', () => {
  // A copy-paste example that does not even parse is a confident wrong answer to
  // "how do I call this?". Syntax-only check (node --check) — never executes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prim-ex-'));
  try {
    for (const p of manifest.primitives) {
      const file = path.join(dir, `${p.name.replace(/[^\w$]/g, '_')}.mjs`);
      fs.writeFileSync(file, p.example + '\n');
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      } catch (e) {
        assert.fail(`primitive ${p.name}: @example is not valid ESM syntax:\n${p.example}\n\n${(e.stderr || '').toString()}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
