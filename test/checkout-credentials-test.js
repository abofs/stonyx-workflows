import { describe, test } from 'node:test';

// SCAFFOLD -- abofs/stonyx-workflows#35.
//
// The guarantee: an `actions/checkout` step that is handed a credential other
// than the ambient `github.token` must not leave that credential in
// `.git/config`, because consumer code runs in the same job afterwards.
//
// Stubs first, on purpose. The fix lands in a later commit so that the RED
// state of each assertion below is a matter of record rather than of trust.

describe('#35 -- a privileged checkout does not persist its credential', () => {
  test('every actions/checkout step in the repo is found, with the population pinned off raw text', { todo: true }, () => {});
  test('every checkout taking a token other than github.token sets persist-credentials: false', { todo: true }, () => {});
  test('a checkout step whose with: block cannot be read is refused, never skipped', { todo: true }, () => {});
});

describe('#35 -- the guard can fail (non-vacuity)', () => {
  test('deleting persist-credentials from a REAL workflow file reds the guard', { todo: true }, () => {});
  test('flipping persist-credentials to true in a REAL workflow file reds the guard', { todo: true }, () => {});
  test('a synthetic checkout carrying the PAT without the setting is reported', { todo: true }, () => {});
  test('control: the same synthetic checkout WITH the setting is silent', { todo: true }, () => {});
  test('control: a synthetic checkout with no token: at all is silent', { todo: true }, () => {});
});

describe('#35 -- the cascade path still receives its credential explicitly', () => {
  test('every step that pushes supplies the token at its point of use', { todo: true }, () => {});
  test('no push step relies on ambient .git/config credentials', { todo: true }, () => {});
});
