import { describe, test } from 'node:test';

// Workflow-source assertions for abofs/stonyx-workflows#22 (story A).
//
// AC2 anti-drift: the version derivation must live in scripts/derive-version.mjs
// and npm-publish.yml must CALL it, not carry a second copy of the arithmetic.
// Without this, the characterization tests above would validate a transcription.

describe('npm-publish.yml invokes the derivation script (#22 AC2)', () => {
  test('TODO: "Calculate next alpha version" run body references scripts/derive-version.mjs', { todo: true }, () => {});

  test('TODO: "Calculate next beta version" run body references scripts/derive-version.mjs', { todo: true }, () => {});

  test('TODO: neither run body retains inline version arithmetic (nextPatch / -beta.\')', { todo: true }, () => {});
});

describe('self-ci.yml gates this repo (#22 AC3)', () => {
  test('TODO: self-ci.yml exists and parses', { todo: true }, () => {});

  test('TODO: its on: keys include both push and pull_request', { todo: true }, () => {});
});
