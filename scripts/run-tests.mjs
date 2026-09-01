/**
 * Test runner for this repo (`pnpm test`).
 *
 * This exists for one reason: `node --test <glob>` exits 0 and reports
 * `tests 0` when the glob matches nothing. A rename of the test files, a move
 * out of `test/`, or an edit to the pattern would therefore leave `Self CI`
 * green while running no tests at all -- a silent hole under the check that
 * abofs/stonyx-workflows#23 and #24 rely on as their only gate.
 *
 * So the glob is resolved here first, asserted against a floor, and the
 * resulting file list is handed to `node --test` explicitly. The list that is
 * checked is the same list that is run, so the two cannot drift apart.
 */

import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Matches the family convention: every @stonyx/* sibling globs `*-test.*`.
const TEST_GLOB = 'test/**/*-test.js';

// Floor, not an exact count: new test files are welcome, zero is a defect.
const MIN_TEST_FILES = 2;

const files = globSync(TEST_GLOB).sort();

if (files.length < MIN_TEST_FILES) {
  console.error(
    `test discovery failed: ${TEST_GLOB} matched ${files.length} file(s), expected at least ${MIN_TEST_FILES}.\n` +
    'Test files were renamed or moved without updating TEST_GLOB in scripts/run-tests.mjs.\n' +
    'Failing loudly rather than reporting a green run of zero tests.',
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
