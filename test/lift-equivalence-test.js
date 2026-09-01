import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { deriveVersion } from '../scripts/derive-version.mjs';
import { stepRunBody } from './helpers/workflow-yaml.js';

// Differential proof that scripts/derive-version.mjs is behaviour-identical to
// the two heredocs it was lifted out of, for abofs/stonyx-workflows#22.
//
// SME Phase 4 (Test Coverage, HIGH-1): this check existed only in the
// engineer's shell. Its purpose is not to pass today -- two reviewers already
// confirmed that independently -- it is to be RE-RUNNABLE when #23 and #24
// deliberately change the derivation output, so the reviewer of those PRs can
// separate the intended fix from lift damage mechanically instead of by hand.
//
// The heredocs are extracted programmatically, never re-typed. `git show` is
// not usable: Self CI checks out at depth 1, so main@692d122 is not in the
// object store on the runner (verified: exit 128). The blob is therefore
// committed as a fixture and pinned by its git object hash, which is
// recomputed here offline -- so the fixture cannot be edited to make this test
// agree with a script that has drifted.

// `git rev-parse 692d122:.github/workflows/npm-publish.yml`
const BLOB_SHA = '38a0b3f5fd710240005bb8cf3e0cd7fa65b65a70';

const ORIGINAL_PATH = new URL('./fixtures/npm-publish-692d122.yml', import.meta.url);
const original = readFileSync(ORIGINAL_PATH);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/oauth-registry-state.json', import.meta.url), 'utf8'));

/** Compile a channel's original heredoc arithmetic into a callable. */
function liftHeredoc(channel) {
  const lines = stepRunBody(original.toString('utf8'), `Calculate next ${channel} version`).split('\n');
  const start = lines.findIndex((l) => l.includes('if (!Array.isArray(allVersions))'));
  const end = lines.findIndex((l) => l.includes('console.log('));
  assert.ok(start !== -1 && end > start, `could not locate the ${channel} arithmetic in the original heredoc`);

  const source = lines.slice(start, end + 1).join('\n').replace(/console\.log\((.*)\);\s*$/, 'return $1;');
  assert.match(source, /return /, 'the console.log -> return rewrite must have applied');
  return new Function('latestStable', 'allVersions', source);
}

// Deterministic, so a mismatch is always reproducible.
const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const STABLES = ['0.1.0', '0.0.0', '1.2.3', '2.4.7', '0.1.10', '10.20.30'];

const EDGE_SETS = [
  fixture.versions,
  [],
  '0.1.0', // npm returns a bare string for a single-version package
  ['0.1.1-beta.'], // empty suffix
  ['0.1.1-beta.-1', '0.1.1-beta.007', '0.1.1-beta.1e3'], // parseInt oddities
  ['0.1.1-alpha.5', '0.1.1-beta.9'], // cross-channel contamination
  ['0.1.11-beta.3', '0.1.1-beta.2'], // 0.1.1 vs 0.1.11 prefix collision
  ['garbage', '', 'x'],
  ['0.1.1-beta.9007199254740993'],
];

const rand = mulberry32(22);
const VERSION_SETS = [...EDGE_SETS];
while (VERSION_SETS.length < 72) {
  const n = Math.floor(rand() * 6);
  VERSION_SETS.push(Array.from({ length: n }, () => {
    const ch = rand() < 0.5 ? 'alpha' : 'beta';
    return `0.1.${Math.floor(rand() * 3)}-${ch}.${Math.floor(rand() * 200)}`;
  }));
}

describe('scripts/derive-version.mjs is equivalent to the main@692d122 heredocs (#22 AC1)', () => {
  test('the pinned original workflow is the exact blob from main@692d122', () => {
    const header = Buffer.from(`blob ${original.length}\0`, 'utf8');
    const sha = createHash('sha1').update(Buffer.concat([header, original])).digest('hex');
    assert.equal(sha, BLOB_SHA, 'fixtures/npm-publish-692d122.yml is not the blob it claims to be');
  });

  test('both arms agree on every input pair', () => {
    let comparisons = 0;

    for (const channel of ['alpha', 'beta']) {
      const originalArm = liftHeredoc(channel);

      for (const latestStable of STABLES) {
        for (const allVersions of VERSION_SETS) {
          // Each side gets its own copy: the lifted code reassigns allVersions.
          const before = originalArm(latestStable, Array.isArray(allVersions) ? [...allVersions] : allVersions);
          const after = deriveVersion({
            channel,
            latestStable,
            allVersions: Array.isArray(allVersions) ? [...allVersions] : allVersions,
          });

          assert.equal(after, before, `channel=${channel} latestStable=${latestStable} allVersions=${JSON.stringify(allVersions)}`);
          comparisons++;
        }
      }
    }

    // Pinned so the grid cannot silently shrink to nothing and still pass.
    assert.equal(comparisons, STABLES.length * VERSION_SETS.length * 2);
    assert.equal(comparisons, 864);
  });
});
