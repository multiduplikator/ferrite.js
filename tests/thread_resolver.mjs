// host-adaptive decode threads — unit test for the PURE resolver (config.ts resolveThreadCount).
//
// Proves the default: `clamp(navigator.hardwareConcurrency − 2, 2, 8)`,
// resolved at the player-creation boundary from a number passed in (DOM-free + node-testable, like
// platform.ts detectPlatform). Covers the host-class matrix, the explicit-override passthrough, the
// undefined/garbage fallback, and the derived decode-pool sizing (pool = resolved threads + 2, the
// ferritePool factory arg the decode worker passes — worker.ts:679).
//
// Run:  ~/emsdk/node/*/bin/node --experimental-strip-types tests/thread_resolver.mjs

import assert from 'node:assert/strict';
import {
  resolveThreadCount, THREAD_COUNT_MIN, THREAD_COUNT_MAX, FALLBACK_HARDWARE_CONCURRENCY,
  mergeConfig, defaultConfig,
} from '../src/config.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

// The decode worker sizes its pthread pool as resolved-threads + 2 (worker.ts:679 ferritePool) — the
// audio/demux/coordinator headroom over the frame-decode threads. Assert the pool tracks the resolver.
const POOL_HEADROOM = 2;
const pool = (threads) => threads + POOL_HEADROOM;

console.log("resolveThreadCount — host-adaptive clamp(hc − 2, 2, 8):");

// The locked matrix: hardwareConcurrency → resolved threads (and the pool that follows).
//   4→2 (floor), 6→4, 8→6, 14→8 (cap), 20→8 (cap). Pool = resolved + 2 → ceiling 10 on a capable host.
for (const [hc, want] of [[4, 2], [6, 4], [8, 6], [14, 8], [20, 8]]) {
  test(`hardwareConcurrency ${hc} → ${want} threads (pool ${pool(want)})`, () => {
    const got = resolveThreadCount('auto', hc);
    assert.equal(got, want, `hc=${hc} expected ${want} got ${got}`);
    assert.equal(pool(got), want + 2);
  });
}

test('pool ceilings at 10 on a capable host (resolved caps at 8)', () => {
  assert.equal(pool(resolveThreadCount('auto', 32)), 10);
  assert.equal(THREAD_COUNT_MAX, 8);
});

test('a 2-core host floors at 2 (no oversubscription, never < MIN)', () => {
  assert.equal(resolveThreadCount('auto', 2), THREAD_COUNT_MIN); // 2 − 2 = 0 → clamped to 2
  assert.equal(resolveThreadCount('auto', 1), THREAD_COUNT_MIN);
  assert.equal(resolveThreadCount('auto', 3), THREAD_COUNT_MIN); // 3 − 2 = 1 → clamped to 2
});

console.log('\nresolveThreadCount — fallback when hardwareConcurrency is unknown:');

for (const [label, hc] of [['undefined', undefined], ['0', 0], ['NaN', NaN], ['negative', -4], ['Infinity', Infinity]]) {
  test(`${label} → fallback (${FALLBACK_HARDWARE_CONCURRENCY}-core ⇒ 2 threads)`, () => {
    const want = Math.min(THREAD_COUNT_MAX, Math.max(THREAD_COUNT_MIN, FALLBACK_HARDWARE_CONCURRENCY - 2));
    assert.equal(resolveThreadCount('auto', hc), want);
    assert.equal(want, 2); // documented: an undetectable host is treated as a low-end quad-core
  });
}

test('non-integer hardwareConcurrency floors before clamping', () => {
  assert.equal(resolveThreadCount('auto', 8.9), 6); // floor(8.9)=8 → 8 − 2 = 6
});

console.log('\nresolveThreadCount — explicit override passthrough (a consumer choice wins):');

for (const n of [1, 2, 4, 8, 12, 16, 24]) {
  test(`explicit threads:${n} passes through unchanged (pool ${pool(n)})`, () => {
    // Even with a host that would auto-resolve differently, an explicit number is verbatim.
    assert.equal(resolveThreadCount(n, 8), n);
    assert.equal(resolveThreadCount(n, undefined), n);
    assert.equal(resolveThreadCount(n, 64), n);
    assert.equal(pool(resolveThreadCount(n, 8)), n + 2);
  });
}

console.log('\nconfig wiring — the default is the auto sentinel; validation accepts both forms:');

test("defaultConfig.threads is the 'auto' sentinel (not a fixed 8)", () => {
  assert.equal(defaultConfig.threads, 'auto');
});

test("mergeConfig() leaves 'auto' for index.ts to resolve at the DOM boundary", () => {
  assert.equal(mergeConfig().threads, 'auto');
  assert.equal(mergeConfig({}).threads, 'auto');
});

test('mergeConfig accepts an explicit numeric override and validates it', () => {
  assert.equal(mergeConfig({ threads: 4 }).threads, 4);
  assert.equal(mergeConfig({ threads: 1 }).threads, 1);
});

test("validateConfig still rejects threads < 1 and non-finite (the ≥1-or-'auto' rule)", () => {
  assert.throws(() => mergeConfig({ threads: 0 }), /threads must be/);
  assert.throws(() => mergeConfig({ threads: -2 }), /threads must be/);
  assert.throws(() => mergeConfig({ threads: NaN }), /threads must be/);
});

console.log(`\n✅ thread_resolver: ${passed} assertions passed`);
