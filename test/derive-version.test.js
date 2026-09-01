import { describe, test } from 'node:test';

// Characterization tests for the version derivation lifted out of
// .github/workflows/npm-publish.yml. See abofs/stonyx-workflows#22 (story A).
//
// These pin TODAY's output, bugs included. #23 (B) and #24 (C) are the fixes;
// when they land, these assertions are expected to change and that diff is the
// point of this file.

describe('deriveVersion — characterization against the @stonyx/oauth registry state (#22 AC1)', () => {
  test('TODO: fixture pins the registry state documented in #22 (151 versions, latest 0.1.0, highest beta 0.1.1-beta.127)', { todo: true }, () => {});

  test('TODO: beta arm derives 0.1.1-beta.128', { todo: true }, () => {});

  test('TODO: alpha arm derives 0.1.1-alpha.22', { todo: true }, () => {});
});
