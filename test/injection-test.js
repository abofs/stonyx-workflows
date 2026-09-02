import { describe, test } from 'node:test';

// Consumer-controlled-string injection sinks in the reusable workflows, for
// abofs/stonyx-workflows#32.
//
// Seven sinks were verified in refinement, six of them by executed canary. The
// convention this suite enforces is a single sentence: no consumer-controlled
// string ever becomes program text or a shell-string fragment.
//
// Scaffold commit -- every case below is a TODO stub. The implementation
// commits that follow fill them in, one per AC, and each assertion names the
// concrete broken state that turns it red before it is written.

describe('AC1 -- S1a/S1b: alpha/beta derivation blocks (#32)', () => {
  test.todo('a single-quote payload in the package name creates no canary and fails the step');
  test.todo('a $(...) payload in the package name creates no canary and fails the step');
  test.todo('a valid @stonyx/* name still derives the pinned alpha/beta version');
});

describe('AC2 -- S2: Update all Stonyx dependencies to latest (#32)', () => {
  test.todo('a shell-metacharacter dependency key creates no canary and fails the step');
  test.todo('valid dependency keys are still rewritten to the resolved versions');
});

describe('AC3 -- S1/S2 fail loudly instead of catch (e) {} (#32)', () => {
  test.todo('a non-404 npm view failure fails the derivation step with a diagnostic');
  test.todo('a genuine E404 still falls back to the local version');
  test.todo('a non-404 npm view failure fails the dependency-update step with a diagnostic');
});

describe('AC4 -- npm naming grammar is enforced before any sink (#32)', () => {
  test.todo('names violating the npm grammar are rejected at every derivation entry point');
});

describe('AC5 -- S3/S5: the two github-script sinks (structural only) (#32)', () => {
  test.todo('npm-publish.yml alpha comment reads process.env, not an interpolated literal');
  test.todo('cascade.yml dispatch reads process.env, not an interpolated literal');
});

describe('AC6 -- S4: $GITHUB_OUTPUT line injection (#32)', () => {
  test.todo('a newline-bearing package name cannot forge extra output keys');
  test.todo('a newline-bearing package version cannot forge extra output keys');
});

describe('AC7 -- S6: custom-version shell interpolation (#32)', () => {
  test.todo('a shell-metacharacter custom-version creates no canary and fails the step');
  test.todo('a valid custom version still reaches pnpm version unchanged');
});
