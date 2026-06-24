// THE single compile-time diagnostics gate.
//
// `DEBUG` is NOT a runtime binding — it is an AMBIENT identifier the bundler's `define` substitutes with
// a literal at build time (see tsup.config.ts):
//   - the published / library build → `DEBUG` ⇒ `false`  ⇒ esbuild's syntax minifier folds `if (false)`
//     and dead-code-eliminates every diagnostic branch + its strings ⇒ ZERO production cost.
//   - the demo / dev build          → `DEBUG` ⇒ `true`   ⇒ full instrumentation (the demo is our harness).
//
// It is ambient (no import) so the three bundled entries (index / worker / present-worker) gate with a
// bare `if (DEBUG)`. Substituting the bareword identifier — rather than inlining an imported const — is
// what makes the elimination reliable for BLOCK-form gates too (esbuild does not inline an imported const
// into a multi-statement `if` block, even under full minify; it does fold a defined bareword).
//
// The diagnostics are OBSERVE-ONLY: the player runs byte-identically with DEBUG true or false.
//
// HARD RULE: only ever reference `DEBUG` from a module that goes through the bundler (index.ts,
// worker/*.ts, present-worker.ts and their transitive imports). NEVER from a module the node test harness
// loads directly under `--experimental-strip-types` (config/errors/types/policy/codec, controller/*,
// source/*, instrument/*, render/color, …) — there is no `define` there, so `DEBUG` would be undefined.
declare const DEBUG: boolean;
