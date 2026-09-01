import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deriveVersion } from '../scripts/derive-version.mjs';

// Characterization tests for the version derivation lifted out of
// .github/workflows/npm-publish.yml. See abofs/stonyx-workflows#22 (story A).
//
// These pin TODAY's output, bugs included. #23 (B) and #24 (C) are the fixes;
// when they land, these assertions are expected to change and that diff is the
// point of this file. Do not "improve" the derivation to make them nicer.

const FIXTURE_PATH = new URL('./fixtures/oauth-registry-state.json', import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

const latestStable = fixture.distTags.latest;
const allVersions = fixture.versions;

const highest = (channel) => {
  const prefix = `0.1.1-${channel}.`;
  return Math.max(...allVersions
    .filter((v) => v.startsWith(prefix))
    .map((v) => Number(v.slice(prefix.length))));
};

describe('deriveVersion — characterization against the @stonyx/oauth registry state (#22 AC1)', () => {
  // Precondition assertions. The two expected values below are only meaningful
  // if the fixture really is the registry state #22 documents; without this,
  // a silently regenerated fixture would quietly change what AC1 asserts.
  test('fixture pins the registry state documented in #22', () => {
    assert.equal(fixture.versions.length, 151, 'fixture should hold 151 published versions');
    assert.equal(latestStable, '0.1.0', 'dist-tags.latest should be 0.1.0');
    assert.equal(highest('beta'), 127, 'highest published beta should be 0.1.1-beta.127');
    assert.equal(highest('alpha'), 21, 'highest published alpha should be 0.1.1-alpha.21');
    assert.ok(Array.isArray(allVersions), 'versions should be an array');
  });

  test('beta arm derives 0.1.1-beta.128', () => {
    assert.equal(
      deriveVersion({ channel: 'beta', latestStable, allVersions }),
      '0.1.1-beta.128',
    );
  });

  // Pinned so the two arms cannot diverge during the lift: before this story
  // they were two independently maintained copies of the same nine lines.
  test('alpha arm derives 0.1.1-alpha.22', () => {
    assert.equal(
      deriveVersion({ channel: 'alpha', latestStable, allVersions }),
      '0.1.1-alpha.22',
    );
  });

  // The heredoc accepted whatever `npm view ... versions --json` returned, and
  // npm returns a bare string rather than an array for a single-version
  // package. The lift has to keep tolerating that shape.
  test('accepts the single-version string shape npm returns', () => {
    assert.equal(
      deriveVersion({ channel: 'beta', latestStable: '0.1.0', allVersions: '0.1.0' }),
      '0.1.1-beta.0',
    );
  });

  // Characterizes the registry-unreachable fallback: the workflow passes the
  // local package.json version and an empty list, and derivation restarts at 0.
  test('restarts at .0 when no prerelease exists on the channel', () => {
    assert.equal(
      deriveVersion({ channel: 'alpha', latestStable: '2.4.7', allVersions: [] }),
      '2.4.8-alpha.0',
    );
  });

  // Characterizes the NaN filter: malformed suffixes are dropped rather than
  // poisoning Math.max.
  test('ignores versions on the channel whose suffix is not a number', () => {
    assert.equal(
      deriveVersion({
        channel: 'beta',
        latestStable: '1.2.3',
        allVersions: ['1.2.4-beta.oops', '1.2.4-beta.4', 'garbage'],
      }),
      '1.2.4-beta.5',
    );
  });
});
