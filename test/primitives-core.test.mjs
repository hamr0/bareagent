// Shared generator-mechanics tests for the primitives.json generator core
// (scripts/primitives-core.mjs). VENDORED byte-identically into bareguard and
// litectx alongside the core itself — do not add repo-specific assertions
// here (those stay in each repo's own test/primitives-completeness.test.js).
// See docs/product/prd.md § "Primitives manifest".
//
// Written as ESM (`.mjs`, not `.test.js`) so this ONE file parses correctly
// vendored into bare-agent (plain CommonJS, no package.json "type" field) AND
// into bareguard/litectx (`"type": "module"`) — a `.js` file's module system
// depends on the nearest package.json, but `.mjs` is always ESM regardless.
//
// Covers the union of rules the three repos' drifted generators separately
// enforced, now enforced ONCE by the shared core:
//   RULE A — a tag's body is every line up to the next tag/end of comment.
//   RULE B — @when/@fails/@category/@name/@signature must stay single-line.
//   RULE C — an unknown @tag inside a @when block fails, with alias hints.
//   RULE D — @example is the last recognized tag boundary; only a KNOWN_TAGS
//            tag closes it, so a `@word`-shaped line inside a code sample
//            (a decorator, a typo) survives as content, never truncating.
//   Class methods (an exported class's own verbs) resolve as a symbol kind,
//   both with an explicit @name override (bareguard's "Class#method" style)
//   and without one (litectx's auto-inferred "receiver.method(...)" style).
//   A pin test that fails loudly the moment this vendored core (or this
//   vendored test file) drifts a single byte from the canonical copy.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GEN_SCRIPT = path.join(ROOT, 'scripts', 'gen-primitives.mjs');
const CORE_FILE = path.join(ROOT, 'scripts', 'primitives-core.mjs');
const TEST_FILE = fileURLToPath(import.meta.url);
const HASHES_FILE = path.join(ROOT, 'scripts', 'primitives-core.hashes.json');

// ---------------------------------------------------------------------------
// Pin: the vendored core (and this vendored test file) must be byte-identical
// (CRLF-normalized, so a Windows checkout's line-ending translation can never
// trip it — see .gitattributes' `text eol=lf` pin on both files, belt-and-
// suspenders with this content hash) to the canonical copy's pinned hash.
// ---------------------------------------------------------------------------
function sha256OfNormalized(file) {
  const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

test('vendored primitives-core.mjs matches the pinned hash', () => {
  const { core } = JSON.parse(fs.readFileSync(HASHES_FILE, 'utf8'));
  assert.strictEqual(
    sha256OfNormalized(CORE_FILE),
    core,
    'scripts/primitives-core.mjs has drifted from the canonical copy (bare-agent). ' +
      'Fix upstream in bare-agent and re-vendor this exact file — never patch a local copy.',
  );
});

test('vendored primitives-core.test.mjs matches the pinned hash', () => {
  const { test: testHash } = JSON.parse(fs.readFileSync(HASHES_FILE, 'utf8'));
  assert.strictEqual(
    sha256OfNormalized(TEST_FILE),
    testHash,
    'test/primitives-core.test.mjs has drifted from the canonical copy (bare-agent). ' +
      'Fix upstream in bare-agent and re-vendor this exact file — never patch a local copy.',
  );
});

// ---------------------------------------------------------------------------
// Fixtures — a minimal, REAL npm package on disk. The generator's own CWD is
// process.cwd() (no hardcoded root), so it can be pointed at a throwaway
// fixture package via the child process's `cwd` option — the cleanest way to
// prove a generator-level failure mode without mutating this repo's own
// source tree.
// ---------------------------------------------------------------------------
function writeFixturePkg(dir, { whenLine, exampleBlock }) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-pkg', version: '0.0.0', type: 'module', main: './index.js',
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), `export { foo } from './src/foo.js';\n`);
  fs.mkdirSync(path.join(dir, 'src'));
  const example = exampleBlock || ` * @example\n * foo()\n`;
  fs.writeFileSync(path.join(dir, 'src', 'foo.js'), `/**
 * ${whenLine}
 * @fails never
${example} */
export function foo() {}
`);
}

// Same fixture shape, but writes the doc-comment BODY verbatim — each array
// element becomes one ` * <line>` inside the block — instead of assembling a
// fixed @when/@fails/@example shape. Needed to control exactly what follows a
// tag: a blank line, a whitespace-only star line, or a line that itself
// looks like a tag.
function writeFixturePkgRaw(dir, bodyLines) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-pkg', version: '0.0.0', type: 'module', main: './index.js',
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), `export { foo } from './src/foo.js';\n`);
  fs.mkdirSync(path.join(dir, 'src'));
  const body = bodyLines.map((l) => ` * ${l}`).join('\n');
  fs.writeFileSync(path.join(dir, 'src', 'foo.js'), `/**\n${body}\n */\nexport function foo() {}\n`);
}

function writeFixtureClassPkg(dir, { methodBlock, className = 'Foo', methodName = 'bar' }) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-pkg', version: '0.0.0', type: 'module', main: './index.js',
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), `export { ${className} } from './src/foo.js';\n`);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'foo.js'), `export class ${className} {
${methodBlock}
  ${methodName}(x) {
    return x;
  }
}
`);
}

// Run the generator against a fixture dir and assert it fails loud: non-zero
// exit, the given message on stderr, and no primitives.json written.
function assertGeneratorRejects(dir, messageRe) {
  let err;
  try {
    execFileSync(process.execPath, [GEN_SCRIPT], { cwd: dir, stdio: 'pipe' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'generator should exit non-zero');
  assert.strictEqual(err.status, 1);
  assert.match(err.stderr.toString(), messageRe);
  assert.strictEqual(fs.existsSync(path.join(dir, 'primitives.json')), false);
}

function withTmpDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// RULE A / B — continuation handling
// ---------------------------------------------------------------------------

test('a continued @when fails the generator loudly instead of silently truncating', () => {
  withTmpDir('prim-gen-cont-', (dir) => {
    writeFixturePkg(dir, { whenLine: '@when this description\n * wraps onto a second line' });
    assertGeneratorRejects(
      dir,
      /foo: @when spans more than one line — keep @when\/@fails on one line \(the manifest reads only the first\)/,
    );
  });
});

test('a whitespace-only star line then text still fails loudly', () => {
  withTmpDir('prim-gen-ws-', (dir) => {
    writeFixturePkgRaw(dir, [
      '@when this description',
      '   ',
      'continues here after a whitespace-only star line',
      '@fails never',
      '@example',
      'foo()',
    ]);
    assertGeneratorRejects(
      dir,
      /foo: @when spans more than one line — keep @when\/@fails on one line \(the manifest reads only the first\)/,
    );
  });
});

test('a blank line then text inside @fails still fails loudly', () => {
  withTmpDir('prim-gen-blank-', (dir) => {
    writeFixturePkgRaw(dir, [
      '@when this description stays on one line',
      '@fails never',
      '',
      'continues here after a blank line',
      '@example',
      'foo()',
    ]);
    assertGeneratorRejects(
      dir,
      /foo: @fails spans more than one line — keep @when\/@fails on one line \(the manifest reads only the first\)/,
    );
  });
});

test('a one-line @when followed by a blank line then the next tag generates cleanly', () => {
  withTmpDir('prim-gen-when-blank-ok-', (dir) => {
    writeFixturePkgRaw(dir, [
      '@when this description stays on one line',
      '',
      '@fails never',
      '@example',
      'foo()',
    ]);
    execFileSync(process.execPath, [GEN_SCRIPT], { cwd: dir, stdio: 'pipe' });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'primitives.json'), 'utf8'));
    assert.strictEqual(out.primitives.length, 1);
    assert.strictEqual(out.primitives[0].name, 'foo');
    assert.strictEqual(out.primitives[0].when, 'this description stays on one line');
  });
});

test('a continued @category also fails loudly (not just @when/@fails)', () => {
  withTmpDir('prim-gen-cat-cont-', (dir) => {
    writeFixturePkgRaw(dir, [
      '@when this description stays on one line',
      '@fails never',
      '@category custom',
      'continues here after a category tag',
      '@example',
      'foo()',
    ]);
    assertGeneratorRejects(
      dir,
      /foo: @category spans more than one line — keep @category on one line \(the manifest reads only the first\)/,
    );
  });
});

test('a single-line @when generates cleanly', () => {
  withTmpDir('prim-gen-ok-', (dir) => {
    writeFixturePkg(dir, { whenLine: '@when this description stays on one line' });
    execFileSync(process.execPath, [GEN_SCRIPT], { cwd: dir, stdio: 'pipe' });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'primitives.json'), 'utf8'));
    assert.strictEqual(out.primitives.length, 1);
    assert.strictEqual(out.primitives[0].name, 'foo');
    assert.strictEqual(out.primitives[0].when, 'this description stays on one line');
  });
});

// ---------------------------------------------------------------------------
// RULE C — unknown tags
// ---------------------------------------------------------------------------

test('a wrapped @when line that itself starts with an unknown @tag is flagged, not silently truncated', () => {
  withTmpDir('prim-gen-unk-', (dir) => {
    writeFixturePkg(dir, { whenLine: '@when this description\n * @typo this is prose continuation' });
    assertGeneratorRejects(
      dir,
      /foo: unknown tag @typo — if this is a wrapped @when\/@fails line, keep them on one line; otherwise add the tag to KNOWN_TAGS/,
    );
  });
});

test('an unknown tag with a known alias hints the correct tag', () => {
  withTmpDir('prim-gen-alias-', (dir) => {
    writeFixturePkg(dir, { whenLine: '@when this description\n * @return this is a typo for @returns' });
    assertGeneratorRejects(dir, /unknown tag @return \(did you mean @returns\?\)/);
  });
});

// ---------------------------------------------------------------------------
// RULE D — @example is the last recognized tag boundary
// ---------------------------------------------------------------------------

test('an @example line starting with an unknown @tag is kept as content, not truncated', () => {
  withTmpDir('prim-gen-ex-decorator-', (dir) => {
    writeFixturePkg(dir, {
      whenLine: '@when this description stays on one line',
      exampleBlock: ' * @example\n * // usage:\n * @decorator\n * foo()\n',
    });
    execFileSync(process.execPath, [GEN_SCRIPT], { cwd: dir, stdio: 'pipe' });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'primitives.json'), 'utf8'));
    assert.strictEqual(out.primitives.length, 1);
    assert.match(out.primitives[0].example, /\/\/ usage:/);
    assert.match(out.primitives[0].example, /@decorator/);
    assert.match(out.primitives[0].example, /foo\(\)/);
  });
});

test('a KNOWN_TAGS tag after @example still closes the example and is applied', () => {
  withTmpDir('prim-gen-ex-category-', (dir) => {
    writeFixturePkg(dir, {
      whenLine: '@when this description stays on one line',
      exampleBlock: ' * @example\n * foo()\n * @category custom-category\n',
    });
    execFileSync(process.execPath, [GEN_SCRIPT], { cwd: dir, stdio: 'pipe' });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'primitives.json'), 'utf8'));
    assert.strictEqual(out.primitives.length, 1);
    assert.strictEqual(out.primitives[0].example.trim(), 'foo()');
    assert.strictEqual(out.primitives[0].category, 'custom-category');
  });
});

// ---------------------------------------------------------------------------
// Class methods — litectx's auto-inferred (no @name) style and bareguard's
// explicit-@name style must both resolve.
// ---------------------------------------------------------------------------

test('a class method with no @name override auto-resolves with a receiver-style signature', () => {
  withTmpDir('prim-gen-method-auto-', (dir) => {
    writeFixtureClassPkg(dir, {
      methodBlock: `  /**
   * @when this description stays on one line
   * @fails never
   * @example
   * foo.bar(1)
   */`,
    });
    execFileSync(process.execPath, [GEN_SCRIPT], { cwd: dir, stdio: 'pipe' });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'primitives.json'), 'utf8'));
    assert.strictEqual(out.primitives.length, 1);
    assert.strictEqual(out.primitives[0].name, 'bar');
    assert.strictEqual(out.primitives[0].import, "import { Foo } from 'fixture-pkg'");
    // No `receivers` config entry for "Foo" -> falls back to lowercase-first-letter.
    assert.match(out.primitives[0].signature, /^foo\.bar\(/);
  });
});

test('a class method with an explicit @name override renders literally (bareguard style)', () => {
  withTmpDir('prim-gen-method-named-', (dir) => {
    writeFixtureClassPkg(dir, {
      methodBlock: `  /**
   * @when this description stays on one line
   * @name Foo#bar
   * @signature foo.bar(x) => number
   * @fails never
   * @example
   * foo.bar(1)
   */`,
    });
    execFileSync(process.execPath, [GEN_SCRIPT], { cwd: dir, stdio: 'pipe' });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'primitives.json'), 'utf8'));
    assert.strictEqual(out.primitives.length, 1);
    assert.strictEqual(out.primitives[0].name, 'Foo#bar');
    assert.strictEqual(out.primitives[0].signature, 'foo.bar(x) => number');
  });
});
