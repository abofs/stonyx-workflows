import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  MissingStepKeyError,
  parseSteps,
  readWorkflow,
  runBodyOf,
  stepRunBody,
  stepsNamed,
} from './helpers/workflow-yaml.js';

// abofs/stonyx-workflows#39 -- the publish pipeline asserts nothing about what
// goes into the tarball it uploads.
//
// The control is one unconditional step in `npm-publish.yml` that packs to a
// deterministic path under `$RUNNER_TEMP`, reads THAT FILE, and hard-fails on a
// denied path; every publish step then hands that same path to the registry. So
// the bytes asserted on and the bytes published are the same object rather than
// two packs of the same tree.
//
// What this file can and cannot establish is worth stating up front, because
// one of the ACs is bounded by it:
//
//   CAN -- that the guard's real `run:` body, executed offline under the shell
//   GitHub Actions uses, accepts a clean artifact and rejects a poisoned one;
//   that the artifact it reads is the post-`prepublishOnly` one; that the exact
//   path it produced is what reaches `pnpm publish`; that the step is
//   unconditional, unique, and precedes every publish step in its job.
//
//   CANNOT -- that the RUNNER skips the later steps when this one exits
//   non-zero. That is job-level scheduling, `act` is not available here, and
//   `workflow_dispatch` on `abofs/stonyx*` is frozen. Simulating it by
//   concatenating step bodies into one shell would be a seam this suite
//   invented, and it would pass whether or not the runner behaves that way. So
//   AC2 asserts what is actually observable -- the guard exits non-zero and
//   never itself invokes a publish -- and the "later steps do not run" half is
//   carried structurally by AC5 (the guard is unconditional and precedes every
//   publish step) plus the pin below that no publish step opts out of the
//   default success() condition.
//
// The offline seam is `test/publish-glue-test.js`'s: the step's real `run:`
// body, dropped into a throwaway workspace, run under
// `bash --noprofile --norc -eo pipefail` with `pnpm` stubbed on PATH. Here the
// stub delegates `pack`/`pkg`/`run` to the REAL pnpm -- the packer is the thing
// under test for AC2 construction (a) -- and intercepts `publish`, which is
// both the network boundary and the assertion.

const NPM_PUBLISH = 'npm-publish.yml';
const npmPublish = readWorkflow(NPM_PUBLISH);

const GUARD_STEP = 'Pack and guard the release artifact';

// The deterministic artifact path. Pinned here rather than read out of the
// guard body, so that the guard and the publish steps drifting apart is a red
// in AC1 rather than a test that follows them both wherever they go.
const TARBALL_PATH = '$RUNNER_TEMP/stonyx-release.tgz';

const indentOf = (line) => line.match(/^(\s*)/)[1].length;
const BLOCK_SCALAR_HEADER = /^[|>](?:[-+][1-9]?|[1-9][-+]?)?$/;

/**
 * The mapping keys a step declares at its own key depth.
 *
 * Block-scalar payload is skipped, so a `run: |` body containing a line that
 * looks like `if: ...` is not read as the step carrying an `if:`. AC5 turns on
 * this distinction: reporting a phantom `if:` would red a correct guard, and
 * missing a real one would pass a bypassable one.
 */
function stepKeys(step) {
  const lines = step.body.split('\n');
  const keyIndent = Math.min(...lines.filter((l) => l.trim() !== '').map(indentOf));
  const keys = [];
  let scalarIndent = null;

  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    if (scalarIndent !== null) {
      if (indent > scalarIndent) continue;
      scalarIndent = null;
    }
    const match = line.match(/^\s*(['"]?)([A-Za-z_][\w.-]*)\1\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    if (indent === keyIndent) keys.push(match[2]);
    if (BLOCK_SCALAR_HEADER.test(match[3])) scalarIndent = indent;
  }

  return keys;
}

/** Every step in `text` whose `run:` body invokes `pnpm publish`, in file order. */
function publishSteps(text) {
  const found = [];
  for (const step of parseSteps(text)) {
    let body;
    try {
      body = runBodyOf(step);
    } catch (err) {
      // Only "this step has no run:" is a skip. A body that cannot be READ must
      // not silently drop out of a sweep whose whole job is completeness
      // (abofs/stonyx-workflows#37).
      if (err.code === MissingStepKeyError.CODE) continue;
      throw err;
    }
    if (/\bpnpm\s+publish\b/.test(body)) found.push({ ...step, runBody: body });
  }
  return found;
}

/**
 * How many `pnpm publish` invocations the raw file text contains.
 *
 * The AUTHORITATIVE population for AC5, counted off the bytes and sharing no
 * code with `publishSteps`. AC5 is universally quantified over what
 * `publishSteps` matched, so it passes trivially against an empty list; a
 * reader that stopped seeing a step would agree with its own omission unless
 * the expected count comes from somewhere the reader cannot influence.
 */
const rawPublishInvocations = (text) => text.match(/\bpnpm\s+publish\b/g) ?? [];

const dedent = (body) => body.split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n') + '\n';

const REAL_PNPM = (() => {
  const found = spawnSync('sh', ['-c', 'command -v pnpm'], { encoding: 'utf8' });
  const path = found.stdout.trim();
  if (!path) throw new Error('pnpm is not on PATH; this suite runs under `pnpm test` so it must be');
  return path;
})();

/**
 * A `pnpm` stub. `publish` is recorded and never executed -- it is the network
 * boundary and it is also what AC2 asserts the absence of. Everything else
 * reaches the real pnpm, because the real packer is what AC1/AC2(a)/AC3 are
 * about; a stubbed pack would prove only that the guard agrees with the stub.
 *
 * `packOverride` replaces the `pack` case, for the AC4 controls that need a
 * pack producing zero, two, or a pre-built tarball.
 */
function writePnpmStub(binDir, { log, packOverride = '' }) {
  const stub = join(binDir, 'pnpm');
  writeFileSync(stub, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log}'`,
    'if [ "$1" = "publish" ]; then',
    '  exit 0',
    'fi',
    packOverride,
    `exec '${REAL_PNPM}' "$@"`,
    '',
  ].join('\n'));
  chmodSync(stub, 0o755);
}

/** The `$3`-free way to read `--pack-destination` out of a stub invocation. */
const PACK_DEST_SH = [
  'PACK_DEST=""',
  'for arg in "$@"; do',
  '  if [ "$PREV" = "--pack-destination" ]; then PACK_DEST="$arg"; fi',
  '  PREV="$arg"',
  'done',
].join('\n');

const packOverrideProducing = (bodyLines) => [
  'if [ "$1" = "pack" ]; then',
  PACK_DEST_SH,
  '  mkdir -p "$PACK_DEST"',
  ...bodyLines,
  '  exit 0',
  'fi',
].join('\n');

/**
 * Every path in the workspace, relative and sorted, excluding the stub `.bin`
 * directory the harness itself puts there.
 */
function workspaceTree(root) {
  const found = spawnSync('sh', ['-c', "find . -mindepth 1 -not -path './.bin*' | sort"], {
    cwd: root,
    encoding: 'utf8',
  });
  return found.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

function writeTree(root, files) {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

/**
 * Run the guard step's real `run:` body in a throwaway consumer workspace.
 *
 * Returns the exit status, both streams, every argument handed to `pnpm`, and
 * the entry list of whatever tarball ended up at the deterministic path, so a
 * test can assert POSITIVELY that the fixture contained what it claims to test
 * before asserting the guard's verdict on it.
 */
function runGuard({ pkg, files = {}, packOverride = '', seed = () => {}, env: envOverrides = {} }) {
  const body = dedent(stepRunBody(npmPublish, GUARD_STEP));
  const workspace = mkdtempSync(join(tmpdir(), 'wf39-guard-'));
  const runnerTemp = mkdtempSync(join(tmpdir(), 'wf39-runnertemp-'));

  try {
    const bin = join(workspace, '.bin');
    mkdirSync(bin);
    writeFileSync(join(workspace, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    writeTree(workspace, files);

    const log = join(runnerTemp, 'pnpm-args.log');
    writeFileSync(log, '');
    writePnpmStub(bin, { log, packOverride });

    seed({ workspace, runnerTemp });

    const scriptPath = join(runnerTemp, 'step.sh');
    writeFileSync(scriptPath, body);

    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath], {
      cwd: workspace,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runnerTemp, ...envOverrides },
      encoding: 'utf8',
    });

    const tarball = join(runnerTemp, 'stonyx-release.tgz');
    const listing = existsSync(tarball)
      ? spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      : { stdout: '', status: null };

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      pnpmArgs: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
      tarballExists: existsSync(tarball),
      entries: listing.stdout.split('\n').map((l) => l.trim()).filter(Boolean),
      strayTarballs: spawnSync('sh', ['-c', "find . -maxdepth 1 -type f -name '*.tgz' | wc -l"], {
        cwd: workspace,
        encoding: 'utf8',
      }).stdout.trim(),
      // Everything the step left in the package root, so AC6 can assert on
      // what the guard ADDED rather than only on the file extension it added.
      // A pack directory inside the workspace leaves no `.tgz` behind -- the
      // tarball is moved out of it -- but it does leave an untracked directory,
      // which is enough to perturb the rebase in the tag steps.
      tree: workspaceTree(workspace),
      workspace,
      runnerTemp,
      log,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
}

/**
 * A hand-built tarball with the byte shape of the 23 real artifacts: a
 * `package/` prefix, a manifest, and a planted `package/.git/config`.
 *
 * Independent of any packer version. AC2 requires both this and the real-packer
 * construction because the historical leak mechanism no longer reproduces on
 * pnpm 9 or 10 -- the real-packer case proves fidelity to today's tool, this
 * one proves the guard reads the artifact rather than agreeing with the packer.
 */
function buildPoisonedTarball(destPath, { extraGitEntries = 0 } = {}) {
  const staging = mkdtempSync(join(tmpdir(), 'wf39-handbuilt-'));
  try {
    const files = {
      'package/package.json': JSON.stringify({ name: '@stonyx/handbuilt', version: '0.0.1' }) + '\n',
      'package/index.js': 'module.exports = {};\n',
      'package/.git/config': '[remote "origin"]\n\turl = git@github.com:abofs/example.git\n',
    };
    for (let i = 0; i < extraGitEntries; i++) files[`package/.git/refs/heads/branch-${i}`] = 'deadbeef\n';
    writeTree(staging, files);
    mkdirSync(dirname(destPath), { recursive: true });
    const packed = spawnSync('tar', ['-czf', destPath, '-C', staging, 'package'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, `hand-building the fixture tarball failed: ${packed.stderr}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * A hand-built tarball with exactly the entries given, `package/`-prefixed by
 * the caller.
 *
 * For shapes the packer will not produce on demand -- specifically a `.git`
 * GITLINK, which is a regular file and only exists in a worktree or submodule
 * checkout. Packer-independent by construction, which is the point: the guard
 * reads a tar listing, and a listing is all this needs to be.
 */
function buildTarballFrom(destPath, files) {
  const staging = mkdtempSync(join(tmpdir(), 'wf39-shape-'));
  try {
    writeTree(staging, files);
    mkdirSync(dirname(destPath), { recursive: true });
    const packed = spawnSync('tar', ['-czf', destPath, '-C', staging, ...Object.keys(files)], { encoding: 'utf8' });
    assert.equal(packed.status, 0, `hand-building the fixture tarball failed: ${packed.stderr}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const CLEAN_CONSUMER = {
  pkg: {
    name: '@stonyx/example',
    version: '0.1.1-beta.7',
    files: ['dist', 'config', 'README.md'],
    scripts: { prepublishOnly: 'node -e "process.exit(0)"' },
  },
  files: {
    'dist/index.js': 'export const hello = 1;\n',
    'dist/index.d.ts': 'export declare const hello: number;\n',
    'config/default.js': 'export default {};\n',
    'README.md': '# example\n',
    'src/index.js': 'export const hello = 1;\n',
  },
};

describe('AC1 -- the inspected artifact is the published artifact (#39)', () => {
  test('the guard runs prepublishOnly before it packs, and packs outside the package root', () => {
    const body = stepRunBody(npmPublish, GUARD_STEP);

    // Comment lines are stripped first. The guard's own comments explain what
    // `pnpm pack` does and does not run, so a scan of the raw body finds the
    // word `pnpm pack` in the PROSE ahead of the real `pnpm run prepublishOnly`
    // and reports an ordering violation that does not exist. An ordering
    // assertion has to read the executable lines.
    const executable = body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

    const prepublishAt = executable.search(/pnpm run prepublishOnly\b/);
    const packAt = executable.search(/pnpm pack\b/);

    assert.notEqual(prepublishAt, -1, 'the guard must invoke `pnpm run prepublishOnly` explicitly: `pnpm pack` runs only '
      + 'prepack and prepare, so four of the ten consumers would be guarded with no build output present');
    assert.notEqual(packAt, -1, 'the guard must pack the artifact it inspects');
    assert.ok(prepublishAt < packAt, 'prepublishOnly must run BEFORE the pack, or the pack sees a pre-build tree');

    // The destination is resolved through one level of shell variable rather
    // than being matched as a literal, because the guard names it once and
    // reuses it. Resolving it is the difference between asserting where the
    // tarball goes and asserting how the author chose to spell it.
    const assignments = Object.fromEntries(
      [...executable.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"\s*$/gm)].map((m) => [m[1], m[2]]),
    );
    const destination = executable.match(/--pack-destination\s+"([^"]+)"/);
    assert.ok(destination, 'the pack must name a destination. A bare `pnpm pack` writes the .tgz into the '
      + 'package root, where the next pack absorbs it and the rebase in the tag steps trips over it. `--out` '
      + 'is not the alternative: pnpm 9.15.9, the version npm-publish.yml pins by default, rejects it with '
      + '`Unknown option: out`');

    const resolved = destination[1].replace(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/, (whole, name) => (
      Object.hasOwn(assignments, name) ? assignments[name] : whole
    ));
    assert.match(
      resolved,
      /^\$RUNNER_TEMP\//,
      `the pack destination resolves to ${JSON.stringify(resolved)}, which is not under $RUNNER_TEMP`,
    );
  });

  test('a build that only prepublishOnly produces is present in the guarded tarball', () => {
    const run = runGuard({
      pkg: {
        name: '@stonyx/built',
        version: '0.1.0',
        files: ['dist'],
        scripts: {
          prepublishOnly:
            'node -e "const f=require(\'fs\');f.mkdirSync(\'dist\',{recursive:true});'
            + 'f.writeFileSync(\'dist/built.js\',\'built\')"',
        },
      },
      files: { 'src/index.js': 'export const x = 1;\n' },
    });

    assert.equal(run.status, 0, `a clean built package must pass; stderr:\n${run.stderr}`);
    assert.ok(
      run.entries.includes('package/dist/built.js'),
      'the guarded tarball must contain the file prepublishOnly produced. Under a bare `pnpm pack` the '
      + `dist/ tree does not exist yet and the guard inspects an empty artifact. Entries: ${JSON.stringify(run.entries)}`,
    );
  });

  test('a failing prepublishOnly hard-fails the guard rather than being swallowed', () => {
    const run = runGuard({
      pkg: {
        name: '@stonyx/badbuild',
        version: '0.1.0',
        files: ['dist'],
        scripts: { prepublishOnly: 'node -e "process.exit(3)"' },
      },
      // The `dist/` payload is what makes this test test its own name. Without
      // it the tree packs to a single `package/package.json`, so a `|| true` on
      // the prepublishOnly invocation still reds -- on the ENTRY-COUNT floor,
      // several checks downstream, with the build failure swallowed exactly as
      // the assertion message warns about. `notEqual(status, 0)` accepted that,
      // and the mutation this case is named for survived it 344/344 green.
      //
      // With a payload present the fixture is out of sample in the direction
      // that matters, and it is not an exotic one: it is every incremental
      // checkout, and every one of the four consumers that build in
      // prepublishOnly. Measured with `|| true` applied -- exit 0, a stale
      // build shipped, guard reports `passed the content guard: 3 entries`.
      files: {
        'dist/a.js': 'export const a = 1;\n',
        'dist/b.js': 'export const b = 2;\n',
      },
    });

    // The exact status, not merely non-zero. 3 is prepublishOnly's own exit
    // code arriving at the step boundary unaltered, which is the property; any
    // other non-zero value means something downstream failed instead and the
    // build's verdict was discarded on the way.
    assert.equal(run.status, 3, 'a failing prepublishOnly must fail the step WITH ITS OWN STATUS: a `|| true` here '
      + 'would guard a tarball built from a tree whose build did not complete; '
      + `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);

    // The wrong-reason pass this case previously took, pinned away directly. If
    // the step ever reaches the entry-count floor on this fixture, the build
    // failure was swallowed and the guard is only failing by luck.
    assert.doesNotMatch(
      run.stderr,
      /lists \d+ entries/,
      'the step reached the entry-count check, which means it packed -- so the failing prepublishOnly did not '
      + `stop it and this case is passing for a reason that has nothing to do with the build; stderr:\n${run.stderr}`,
    );
    assert.equal(run.tarballExists, false, 'no artifact may exist at the published path after a failed build');
    assert.deepEqual(
      run.pnpmArgs.filter((a) => a.startsWith('publish')),
      [],
      'nothing may be published once the build failed',
    );
  });

  test('every publish step hands the guard-produced tarball path to pnpm publish', () => {
    const steps = publishSteps(npmPublish);
    assert.ok(steps.length > 0, 'npm-publish.yml must contain at least one publish step');

    for (const step of steps) {
      assert.match(
        step.runBody,
        new RegExp(`pnpm\\s+publish\\s+"${TARBALL_PATH.replace(/[$/]/g, '\\$&')}"`),
        `step ${JSON.stringify(step.name)} publishes something other than the guarded tarball at `
        + `${TARBALL_PATH}. Publishing the DIRECTORY re-packs the tree, so the guarded bytes and the `
        + 'uploaded bytes stop being the same object -- which is this issue, one level down',
      );
    }
  });

  test('the guard writes the tarball to the same path the publish steps read', () => {
    const body = stepRunBody(npmPublish, GUARD_STEP);
    assert.ok(
      body.includes(TARBALL_PATH),
      `the guard body must name ${TARBALL_PATH}, the path the publish steps take as their argument`,
    );
  });
});

describe('AC2 -- a poisoned tarball hard-fails and nothing is published (#39)', () => {
  test('real packer: files: [".git/**"] ships package/.git/config and the guard rejects it', () => {
    const run = runGuard({
      pkg: {
        name: '@stonyx/poisoned',
        version: '0.1.0',
        files: ['.git/**', 'src'],
        scripts: { prepublishOnly: 'node -e "process.exit(0)"' },
      },
      files: { 'src/index.js': 'export const x = 1;\n', '.git/config': '[core]\n\tbare = false\n' },
    });

    // Anti-vacuity, asserted POSITIVELY and first: a guard that rejects a
    // tarball which never contained the poison proves nothing. The pack ran
    // inside the step, so its output is read back off the deterministic path.
    const packDir = run.pnpmArgs.find((a) => a.startsWith('pack '));
    assert.ok(packDir, `the guard must have invoked pnpm pack; it invoked ${JSON.stringify(run.pnpmArgs)}`);

    assert.notEqual(run.status, 0, `the guard must exit non-zero on a tarball carrying .git; stdout:\n${run.stdout}`);
    assert.match(
      run.stderr,
      /package\/\.git\/config/,
      'the rejection must name the offending entry, which is also the evidence that the real packer put it '
      + `in the tarball. stderr was:\n${run.stderr}`,
    );
    assert.deepEqual(
      run.pnpmArgs.filter((a) => a.startsWith('publish')),
      [],
      'the guard must never itself reach a publish',
    );
  });

  test('hand-built tarball: packer-independent poison is rejected', () => {
    let handBuilt = null;
    const run = runGuard({
      pkg: { name: '@stonyx/handbuilt', version: '0.0.1', files: ['index.js'] },
      files: { 'index.js': 'module.exports = {};\n' },
      packOverride: packOverrideProducing(['  cp "$WF39_HANDBUILT" "$PACK_DEST/handbuilt-0.0.1.tgz"']),
      seed: ({ runnerTemp }) => {
        handBuilt = join(runnerTemp, 'handbuilt-source.tgz');
        buildPoisonedTarball(handBuilt);
        process.env.WF39_HANDBUILT = handBuilt;
      },
    });
    delete process.env.WF39_HANDBUILT;

    assert.notEqual(run.status, 0, `the guard must reject a hand-built poisoned tarball; stdout:\n${run.stdout}`);
    assert.match(run.stderr, /package\/\.git\/config/, `stderr must name the entry; was:\n${run.stderr}`);
    assert.deepEqual(run.pnpmArgs.filter((a) => a.startsWith('publish')), []);
  });

  test('the hand-built fixture really does carry the poison', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf39-fixture-'));
    try {
      const path = join(dir, 'poison.tgz');
      buildPoisonedTarball(path);
      const entries = spawnSync('tar', ['-tzf', path], { encoding: 'utf8' }).stdout;
      assert.match(entries, /package\/\.git\/config/, 'the fixture builder must produce the poison it claims to');
      assert.match(entries, /package\/package\.json/, 'and the byte shape of a real npm artifact');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AC3 -- a realistic clean consumer passes and is not truncated (#39)', () => {
  test('a populated files: ["dist","config","README.md"] package passes with its payload intact', () => {
    const run = runGuard(CLEAN_CONSUMER);

    assert.equal(run.status, 0, `a legitimate consumer must not be blocked; stderr:\n${run.stderr}`);
    assert.ok(run.tarballExists, 'the guarded tarball must exist at the deterministic path');

    for (const entry of ['package/package.json', 'package/dist/index.js', 'package/config/default.js', 'package/README.md']) {
      assert.ok(
        run.entries.includes(entry),
        `the tarball must carry ${entry} -- an EMPTY tarball would pass the denylist vacuously, which is the `
        + `false-negative this case exists to exclude. Entries: ${JSON.stringify(run.entries)}`,
      );
    }
  });

  test('the publish step then hands that exact tarball to pnpm publish', () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), 'wf39-publish-'));
    const workspace = mkdtempSync(join(tmpdir(), 'wf39-publish-ws-'));
    try {
      const bin = join(workspace, '.bin');
      mkdirSync(bin);
      const log = join(runnerTemp, 'pnpm-args.log');
      writeFileSync(log, '');
      writePnpmStub(bin, { log });

      const tarball = join(runnerTemp, 'stonyx-release.tgz');
      buildPoisonedTarball(tarball); // any tarball: this case is about the ARGUMENT, not the contents

      const body = dedent(stepRunBody(npmPublish, 'Publish to NPM (beta)'));
      const scriptPath = join(runnerTemp, 'publish.sh');
      writeFileSync(scriptPath, body);

      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath], {
        cwd: workspace,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runnerTemp },
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, `the publish step must run; stderr:\n${result.stderr}`);
      const invocations = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
      assert.deepEqual(
        invocations,
        [`publish ${tarball} --tag beta --access public --no-git-checks`],
        'the publish step must upload the guarded file, by path, and nothing else',
      );
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('AC4 -- the guard fails when it inspected nothing (#39)', () => {
  test('zero tarballs produced', () => {
    const run = runGuard({
      pkg: { name: '@stonyx/none', version: '0.1.0', files: ['index.js'] },
      files: { 'index.js': 'module.exports = {};\n' },
      packOverride: packOverrideProducing([]),
    });

    assert.notEqual(run.status, 0, `a pack that produced nothing must fail the step; stdout:\n${run.stdout}`);
    assert.deepEqual(run.pnpmArgs.filter((a) => a.startsWith('publish')), []);

    // The diagnostic is pinned, not just the exit code. Without the explicit
    // count check the step still fails -- `mv "$(find ...)"` with an empty
    // argument errors -- but it fails as `mv: missing destination file
    // operand`, which reads like a broken workflow rather than like a pack that
    // produced nothing. Measured: deleting the count check left this whole
    // suite green, so the check was carrying only a message and nothing was
    // holding the message.
    assert.match(
      run.stderr,
      /expected exactly one tarball[\s\S]*found 0/,
      `the failure must say what it found; stderr:\n${run.stderr}`,
    );
  });

  test('a stale tarball from a prior run is not inspected in place of a fresh one', () => {
    const run = runGuard({
      pkg: { name: '@stonyx/stale', version: '0.1.0', files: ['index.js'] },
      files: { 'index.js': 'module.exports = {};\n' },
      packOverride: packOverrideProducing([]),
      // Both the destination path AND the pack directory are pre-populated with
      // a clean tarball, as a prior successful run would leave them. A guard
      // that reads whatever is at the path -- rather than requiring the pack it
      // just ran to have produced it -- passes here on last release's bytes.
      seed: ({ runnerTemp }) => {
        const stale = join(runnerTemp, 'stonyx-release.tgz');
        const staging = mkdtempSync(join(tmpdir(), 'wf39-stale-'));
        writeTree(staging, { 'package/package.json': '{"name":"stale","version":"0.0.1"}\n', 'package/index.js': 'x\n' });
        spawnSync('tar', ['-czf', stale, '-C', staging, 'package']);
        mkdirSync(join(runnerTemp, 'stonyx-pack'), { recursive: true });
        spawnSync('tar', ['-czf', join(runnerTemp, 'stonyx-pack', 'stale-0.0.1.tgz'), '-C', staging, 'package']);
        rmSync(staging, { recursive: true, force: true });
      },
    });

    assert.notEqual(run.status, 0, `a stale tarball must not be mistaken for this run's artifact; stdout:\n${run.stdout}`);
    assert.deepEqual(run.pnpmArgs.filter((a) => a.startsWith('publish')), []);
  });

  test('two tarballs produced', () => {
    const run = runGuard({
      pkg: { name: '@stonyx/two', version: '0.1.0', files: ['index.js'] },
      files: { 'index.js': 'module.exports = {};\n' },
      packOverride: packOverrideProducing([
        '  : > "$PACK_DEST/first-0.1.0.tgz"',
        '  : > "$PACK_DEST/second-0.1.0.tgz"',
      ]),
    });

    assert.notEqual(run.status, 0, 'two candidate tarballs is an ambiguity, not a pass. `tar tzf a.tgz b.tgz` '
      + `treats the second as a member name and never opens it; stdout:\n${run.stdout}`);
    assert.deepEqual(run.pnpmArgs.filter((a) => a.startsWith('publish')), []);
    assert.match(
      run.stderr,
      /expected exactly one tarball[\s\S]*found 2/,
      `the failure must name the ambiguity rather than surfacing as an mv error; stderr:\n${run.stderr}`,
    );
  });

  // Two anti-vacuity checks stand between a nonsense artifact and a vacuous
  // denylist scan: an ENTRY_COUNT floor and a `package/package.json` presence
  // check. They ran in that order against a single fixture -- a tarball holding
  // one empty `package/` directory entry -- which trips BOTH, and the case
  // asserted only `notEqual(status, 0)`. So either check could be deleted with
  // the whole suite staying 344/344 green, and the anti-vacuity layer could
  // erode one check at a time in silence.
  //
  // That is abofs/stonyx-workflows#37's exact shape: the fix for a vacuous
  // check, itself vacuous one level down. Each check now has a fixture the
  // OTHER check passes, and each asserts the specific reason rather than a
  // non-zero exit -- because "it failed" is what let them mask each other.

  test('a tarball with no package/package.json is not a packed artifact', () => {
    const run = runGuard({
      pkg: { name: '@stonyx/nomanifest', version: '0.1.0', files: ['index.js'] },
      files: { 'index.js': 'module.exports = {};\n' },
      // Two real files and no manifest. The ENTRY_COUNT floor PASSES on this
      // (2 >= 2), so the manifest check is the only thing that can reject it
      // and deleting the manifest check makes this case red rather than
      // silently handing it to its neighbour. Out of sample and not
      // theoretical: with the manifest check deleted the guard accepts a
      // non-package, scans the denylist over entries that can never match its
      // `^package/` anchor, and exits 0.
      packOverride: packOverrideProducing([
        '  WF39_TMP=$(mktemp -d)',
        '  mkdir -p "$WF39_TMP/package"',
        '  echo "export const a = 1;" > "$WF39_TMP/package/a.js"',
        '  echo "export const b = 2;" > "$WF39_TMP/package/b.js"',
        '  tar -czf "$PACK_DEST/nomanifest-0.1.0.tgz" -C "$WF39_TMP" package/a.js package/b.js',
        '  rm -rf "$WF39_TMP"',
      ]),
    });

    assert.notEqual(run.status, 0, 'an artifact with no manifest means the guard read something that is not a '
      + `packed package, and a denylist over its entries passes vacuously; stdout:\n${run.stdout}`);
    assert.match(
      run.stderr,
      /::error::the release artifact has no package\/package\.json/,
      'this must fail on the MANIFEST check. Failing on the entry-count floor instead means the two checks are '
      + `covering for each other again and either can be deleted unnoticed; stderr:\n${run.stderr}`,
    );
    assert.doesNotMatch(
      run.stderr,
      /lists \d+ entries/,
      `the entry-count floor must not be what rejects this fixture; stderr:\n${run.stderr}`,
    );
    // The guard dumps the listing so an operator can see what it read. Pinned,
    // because a rejection that does not say what it rejected sends the reader
    // to the packer rather than to their own package.json.
    assert.match(run.stderr, /package\/a\.js/, `the listing must be dumped; stderr:\n${run.stderr}`);
    assert.deepEqual(run.pnpmArgs.filter((a) => a.startsWith('publish')), []);
  });

  test('a tarball holding nothing but a manifest is too small to have been inspected', () => {
    const run = runGuard({
      pkg: { name: '@stonyx/lone', version: '0.1.0', files: ['index.js'] },
      files: { 'index.js': 'module.exports = {};\n' },
      // The mirror image: exactly one entry, and it IS `package/package.json`,
      // so the manifest presence check PASSES on this fixture and the
      // ENTRY_COUNT floor is the only thing that can reject it. Nothing seeded
      // this shape before, which is why deleting the floor left the suite
      // green.
      //
      // It is also the realistic one of the pair. A consumer whose `files`
      // allowlist stops matching -- a renamed dist/, a build that produced
      // nothing -- packs to exactly this, and without the floor the guard would
      // report `passed the content guard` on an empty release.
      packOverride: packOverrideProducing([
        '  WF39_TMP=$(mktemp -d)',
        '  mkdir -p "$WF39_TMP/package"',
        '  echo \'{"name":"@stonyx/lone","version":"0.1.0"}\' > "$WF39_TMP/package/package.json"',
        '  tar -czf "$PACK_DEST/lone-0.1.0.tgz" -C "$WF39_TMP" package/package.json',
        '  rm -rf "$WF39_TMP"',
      ]),
    });

    assert.notEqual(run.status, 0, 'a one-entry artifact must not be reported as inspected; '
      + `stdout:\n${run.stdout}`);
    assert.match(
      run.stderr,
      /::error::the release artifact lists 1 entries\./,
      'this must fail on the ENTRY-COUNT floor, and on the count it actually read. The manifest check passes on '
      + `this fixture by construction, so nothing else can reject it; stderr:\n${run.stderr}`,
    );
    assert.doesNotMatch(
      run.stderr,
      /has no package\/package\.json/,
      'the manifest check must not be what rejects this fixture -- it is present, and if this message appears '
      + `the fixture stopped isolating the floor; stderr:\n${run.stderr}`,
    );
    assert.deepEqual(run.pnpmArgs.filter((a) => a.startsWith('publish')), []);
  });
});

describe('AC5 -- no publish path can bypass the guard (#39)', () => {
  // Deliberately not written against `:427/:431/:435`. abofs/stonyx-workflows#35
  // may relocate or re-shape the publish steps in this same file, and an
  // assertion keyed to line numbers would either red on a correct move or, once
  // "fixed" by renumbering, stop noticing a publish that escaped the guard.
  test('the step sweep finds every pnpm publish in the file', () => {
    const matched = publishSteps(npmPublish);
    assert.equal(
      matched.length,
      rawPublishInvocations(npmPublish).length,
      'the step reader matched a different number of publish invocations than the raw file text contains -- '
      + 'one of them is in a step shape the reader does not resolve, and is therefore outside the assertion below',
    );
    assert.ok(matched.length > 0, 'a repo whose publish workflow contains no publish step is a broken pin, not a pass');
  });

  test('every publish step is preceded by the guard in the same job', () => {
    const steps = parseSteps(npmPublish);
    const guardIdxs = steps
      .map((s, i) => (s.name === GUARD_STEP ? i : -1))
      .filter((i) => i !== -1);

    assert.equal(guardIdxs.length, 1, `exactly one step must be named ${JSON.stringify(GUARD_STEP)}; found `
      + `${guardIdxs.length}. A duplicated guard is a guard whose second copy nobody maintains`);

    const guard = steps[guardIdxs[0]];

    for (const step of publishSteps(npmPublish)) {
      const idx = steps.findIndex((s) => s.index === step.index);
      assert.equal(step.job, guard.job, `publish step ${JSON.stringify(step.name)} is in job `
        + `${JSON.stringify(step.job)} but the guard is in ${JSON.stringify(guard.job)}; a guard in another `
        + 'job does not gate this one');
      assert.ok(
        guardIdxs[0] < idx,
        `publish step ${JSON.stringify(step.name)} runs BEFORE the guard, so its bytes are never inspected`,
      );
    }
  });

  test('the guard is unconditional', () => {
    const [guard] = stepsNamed(npmPublish, GUARD_STEP);
    assert.ok(guard, `no step named ${JSON.stringify(GUARD_STEP)}`);
    const keys = stepKeys(guard);
    assert.ok(
      !keys.includes('if'),
      `the guard carries an if: (${JSON.stringify(keys)}). Any condition on it is a bypass -- one that would be `
      + 'evaluated from consumer-influenced outputs, and one nobody would notice going false',
    );
  });

  test('neither the guard nor any publish step is advisory', () => {
    // The third bypass, and the only one that is total. `if:` on the guard and
    // `always()` on a publish step are both pinned above, and
    // `continue-on-error: true` steps straight past them: the guard still runs,
    // still writes the poisoned tarball to $RUNNER_TEMP, still exits non-zero
    // and still prints every ::error:: -- and the job status stays `success`,
    // so every later step's implicit success() holds and all three publish
    // steps upload the artifact the guard just rejected. Measured: the suite
    // stayed 344/344 green with `continue-on-error: true` on the guard.
    //
    // Not a hypothetical idiom. It is THIS repo's established one for making a
    // step advisory -- `security-audit.yml:45` uses it, and two agent-facing
    // docs here (`docs/agents/qa-test-engineer.md:44`,
    // `docs/agents/validation-loop-team.md:41`) plus `README.md:293` name it as
    // the way to do that. The guard invokes each consumer's full build and test
    // suite via prepublishOnly, which is exactly the step someone marks
    // advisory the first time it flakes.
    //
    // Absence of the key, not falsiness of its value. `false` is the default,
    // so writing it is a no-op one character away from the bypass; and an
    // expression form (`${{ ... }}`) cannot be evaluated here at all, which
    // makes it strictly worse than a literal.
    const [guard] = stepsNamed(npmPublish, GUARD_STEP);
    assert.ok(guard, `no step named ${JSON.stringify(GUARD_STEP)}`);

    for (const step of [guard, ...publishSteps(npmPublish)]) {
      const keys = stepKeys(step);
      assert.ok(
        !keys.includes('continue-on-error'),
        `step ${JSON.stringify(step.name)} carries continue-on-error (${JSON.stringify(keys)}). On the guard that `
        + 'is a complete bypass -- the step fails, the job stays green, and the three publish steps upload the '
        + 'tarball it rejected. On a publish step it hides a failed upload. There is no advisory mode here: a '
        + 'guard that annotates a permanent, unpublishable credential leak is not a guard',
      );
    }
  });

  test('no publish step opts out of the default success() condition', () => {
    // The offline ceiling stated honestly: this suite cannot execute the
    // runner's step scheduler, so "a failed guard stops the publish" rests on
    // GitHub Actions running a step only when all previous steps succeeded --
    // unless the step overrides that. This pins the override away, which is the
    // observable half.
    for (const step of publishSteps(npmPublish)) {
      const conditions = step.body
        .split('\n')
        .filter((l) => /^\s*if:/.test(l))
        .map((l) => l.trim());
      for (const condition of conditions) {
        assert.doesNotMatch(
          condition,
          /\b(always|failure|cancelled)\s*\(/,
          `publish step ${JSON.stringify(step.name)} has ${JSON.stringify(condition)}, which runs it even after `
          + 'the guard fails',
        );
      }
    }
  });

  test('the guard does not import anything from the .stonyx-workflows checkout', () => {
    const body = stepRunBody(npmPublish, GUARD_STEP);
    assert.doesNotMatch(
      body,
      /\.stonyx-workflows/,
      'that checkout is alpha/beta-only and is deleted before this point, so a guard depending on it would '
      + 'silently not exist on the stable path -- the one channel where a leak is permanent under `latest`',
    );
  });
});

describe('AC6 -- the guard leaves nothing packable behind (#39)', () => {
  test('a successful guard run leaves no .tgz in the package root', () => {
    const run = runGuard(CLEAN_CONSUMER);
    assert.equal(run.status, 0, `stderr:\n${run.stderr}`);
    assert.equal(
      run.strayTarballs,
      '0',
      'a .tgz left in the workspace is absorbed by the next pack and perturbs the `git pull --rebase '
      + '--autostash` in the tag steps below',
    );
  });

  // The `.tgz` count alone is not enough, and the gap is not theoretical: with
  // the pack destination moved to `./stonyx-pack` the tarball is still MOVED
  // out to $RUNNER_TEMP, so the workspace ends with zero .tgz files and an
  // untracked DIRECTORY -- green on the check above, `git status --porcelain`
  // non-empty, and the autostash in the tag steps carrying a build artifact.
  // Measured: that mutation left the whole suite green until this case existed.
  test('a successful guard run adds nothing at all to the package root', () => {
    const run = runGuard(CLEAN_CONSUMER);
    assert.equal(run.status, 0, `stderr:\n${run.stderr}`);

    const seeded = new Set(['./package.json', ...Object.keys(CLEAN_CONSUMER.files).flatMap((path) => {
      const parts = path.split('/');
      return parts.map((_, i) => `./${parts.slice(0, i + 1).join('/')}`);
    })]);

    const added = run.tree.filter((p) => !seeded.has(p));
    assert.deepEqual(
      added,
      [],
      `the guard added ${JSON.stringify(added)} to the package root. This fixture declares a no-op `
      + 'prepublishOnly, so anything here came from the guard itself -- a pack directory, a listing file, or '
      + 'a tarball. All three are absorbed by the next pack and all three dirty the worktree for the rebase.',
    );
  });

  test('a stray .tgz in the package root hard-fails rather than shipping', () => {
    const run = runGuard({
      ...CLEAN_CONSUMER,
      pkg: { ...CLEAN_CONSUMER.pkg, files: ['*'] },
      seed: ({ workspace }) => {
        writeFileSync(join(workspace, 'leftover-0.0.1.tgz'), 'not really a tarball\n');
      },
    });

    assert.notEqual(run.status, 0, `a .tgz in the package root must stop the release; stdout:\n${run.stdout}`);
    assert.match(run.stderr, /leftover-0\.0\.1\.tgz/, `the message must name it; stderr:\n${run.stderr}`);
  });

  // The guard runs exactly one destructive command, `rm -rf "$PACK_DIR"`, and
  // the `case` below it is the only thing constraining where PACK_DIR may
  // point. The two assertions here are about that pairing, and neither is about
  // the value PACK_DIR holds today -- with today's literal the invariant cannot
  // fire at all, so this is a pin on the shape a future edit will meet.

  test('the destination invariant runs before the recursive delete it constrains', () => {
    // Order, not presence. Measured with PACK_DIR repointed at a populated
    // directory outside $RUNNER_TEMP: the step printed
    // `::error::the pack destination ... is not under ...` and exited 1, and
    // the directory's contents had ALREADY been deleted. An invariant that
    // objects after the delete is a post-mortem, not a guard -- and the edit it
    // exists to catch is precisely the one where it runs too late.
    const executable = stepRunBody(npmPublish, GUARD_STEP)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l));

    const invariantAt = executable.findIndex((l) => /^\s*case\s+"\$PACK_DIR"\s+in\s*$/.test(l));
    const deleteAt = executable.findIndex((l) => /^\s*rm\s+-rf\s+"\$PACK_DIR"\s*$/.test(l));

    assert.notEqual(invariantAt, -1, 'the guard must constrain where PACK_DIR points before it deletes it');
    assert.notEqual(deleteAt, -1, 'the guard must clear a stale pack directory, or it inspects a prior run');
    assert.ok(
      invariantAt < deleteAt,
      '`rm -rf "$PACK_DIR"` runs at executable line ' + deleteAt + ' but the `case` constraining PACK_DIR is at '
      + invariantAt + '. On the future edit this invariant exists to catch, the recursive delete has already run '
      + 'against the wrong path by the time the invariant objects to it',
    );
  });

  test('an empty RUNNER_TEMP hard-fails on its own check rather than on the filesystem', () => {
    // `set -u` catches UNSET. It does not catch EMPTY, and the two behave
    // differently in a way that matters: with RUNNER_TEMP="" the pattern
    // `"$RUNNER_TEMP"/*` in the destination invariant becomes `/*`, which
    // matches every absolute path -- so the invariant PASSES rather than
    // tripping, and PACK_DIR is `/stonyx-pack`.
    //
    // The step did exit non-zero before this check existed, but on
    // `mkdir: /stonyx-pack: Read-only file system` -- the ambient filesystem
    // refusing, not this guard checking. That is not a property of the guard
    // and it does not hold where the root is writable. This asserts the reason,
    // not just the exit code, which is the difference between the two.
    const run = runGuard({ ...CLEAN_CONSUMER, env: { RUNNER_TEMP: '' } });

    assert.notEqual(run.status, 0, `an empty RUNNER_TEMP must stop the release; stdout:\n${run.stdout}`);
    assert.match(
      run.stderr,
      /::error::RUNNER_TEMP is empty/,
      'the step must fail on its own RUNNER_TEMP check. Failing on a downstream mkdir instead means the guard '
      + `is relying on the root being unwritable; stderr:\n${run.stderr}`,
    );
    assert.doesNotMatch(
      run.stderr,
      /Read-only file system|Permission denied/,
      `the check must fire before anything touches the filesystem; stderr:\n${run.stderr}`,
    );
    assert.deepEqual(run.pnpmArgs.filter((a) => a.startsWith('publish')), []);
  });
});

describe('AC7 -- the failure names the offending paths and their count (#39)', () => {
  test('a single offender is named verbatim with a count of 1', () => {
    const run = runGuard({
      pkg: {
        name: '@stonyx/named',
        version: '0.1.0',
        files: ['.git/**', 'src'],
        scripts: { prepublishOnly: 'node -e "process.exit(0)"' },
      },
      files: { 'src/index.js': 'export const x = 1;\n', '.git/config': '[core]\n' },
    });

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /package\/\.git\/config/, 'the exact path, not just the pattern that matched it');
    assert.match(run.stderr, /\b1\b/, 'and the count, so a truncated list is visible as one');
  });

  test('every offender is named when there are several', () => {
    let handBuilt = null;
    const run = runGuard({
      pkg: { name: '@stonyx/multi', version: '0.0.1', files: ['index.js'] },
      files: { 'index.js': 'module.exports = {};\n' },
      packOverride: packOverrideProducing(['  cp "$WF39_HANDBUILT" "$PACK_DEST/multi-0.0.1.tgz"']),
      seed: ({ runnerTemp }) => {
        handBuilt = join(runnerTemp, 'multi-source.tgz');
        buildPoisonedTarball(handBuilt, { extraGitEntries: 2 });
        process.env.WF39_HANDBUILT = handBuilt;
      },
    });
    delete process.env.WF39_HANDBUILT;

    assert.notEqual(run.status, 0);
    for (const entry of ['package/.git/config', 'package/.git/refs/heads/branch-0', 'package/.git/refs/heads/branch-1']) {
      assert.match(
        run.stderr,
        new RegExp(entry.replace(/[.]/g, '\\$&')),
        `${entry} must be named; a guard that reports only the first match hides the rest of the leak. `
        + `stderr:\n${run.stderr}`,
      );
    }

    // The expected count comes from the artifact, not from a literal. `tar
    // -czf` emits DIRECTORY entries as well as file entries, so a hand-built
    // fixture with three planted files under .git/ produces six matches
    // (`package/.git/`, `package/.git/refs/`, `package/.git/refs/heads/` and
    // the three files). Hard-coding 3 here reds a guard that is reporting
    // correctly -- and "fixing" it by hard-coding 6 would then red the day the
    // packer stops emitting directory entries. Deriving it means the assertion
    // is that the guard counted what is in the tarball.
    const expected = run.entries.filter((e) => /^package\/(.*\/)?\.git(\/|$)/.test(e));
    assert.ok(expected.length >= 3, `the fixture must carry several .git entries; it carried ${expected.length}`);
    assert.match(
      run.stderr,
      new RegExp(`\\b${expected.length}\\b`),
      `the reported count must be the ${expected.length} matched entries; stderr:\n${run.stderr}`,
    );
  });

  test('a .gitignore or .github entry is not mistaken for a .git directory', () => {
    const run = runGuard({
      pkg: {
        name: '@stonyx/lookalike',
        version: '0.1.0',
        files: ['*'],
        scripts: { prepublishOnly: 'node -e "process.exit(0)"' },
      },
      files: {
        '.gitignore': 'node_modules\n',
        '.gitattributes': '* text=auto\n',
        '.github/workflows/publish.yml': 'name: x\n',
        'index.js': 'module.exports = {};\n',
      },
    });

    assert.equal(
      run.status,
      0,
      'a false positive here halts publishing in all ten consumers simultaneously with no per-repo opt-out. '
      + `.gitignore is not .git/. stderr:\n${run.stderr}`,
    );
  });

  test('a nested .gitignore or .github is not mistaken for a .git directory either', () => {
    // The denylist matches `.git` at ANY depth, so every false-positive shape
    // #41 records has to be re-cleared at depth as well as at the root. It is
    // the `(/|$)` that keeps `.gitignore` and `.github/` out, and that is
    // independent of the depth prefix -- but "independent" is the reasoning,
    // and this is the measurement.
    const run = runGuard({
      pkg: {
        name: '@stonyx/nestedlookalike',
        version: '0.1.0',
        files: ['src', 'config'],
        scripts: { prepublishOnly: 'node -e "process.exit(0)"' },
      },
      files: {
        'src/.gitignore': 'dist\n',
        'src/nested/.gitattributes': '* text=auto\n',
        'src/.github/dependabot.yml': 'version: 2\n',
        'config/.gitkeep': '',
        'config/environment.js': 'export default {};\n',
        'src/index.js': 'export const x = 1;\n',
      },
    });

    // Positively established rather than assumed: the lookalikes are really in
    // the tarball. A green run over a tarball that dropped them all proves
    // nothing, and #41's whole risk is that this guard is over-broad.
    // `src/.gitignore` is seeded above but deliberately NOT required here: the
    // pinned packer drops nested `.gitignore` files from the tarball entirely,
    // measured, so requiring it reds a correct guard. The three below do ship,
    // and each is a `.git`-prefixed name at depth, which is the shape at issue.
    for (const entry of ['src/nested/.gitattributes', 'src/.github/dependabot.yml', 'config/.gitkeep']) {
      assert.ok(
        run.entries.includes(`package/${entry}`),
        `the fixture must actually ship ${entry}, or this case clears the denylist of nothing; `
        + `entries:\n${run.entries.join('\n')}`,
      );
    }
    assert.equal(
      run.status,
      0,
      'a nested .gitignore/.github/.gitkeep is not a nested .git directory, and a false positive here halts '
      + `publishing in all ten consumers at once; stderr:\n${run.stderr}`,
    );
  });

  test('a .git directory below the package root is caught, not just one at it', () => {
    // Executed against the REAL packer on both pinned majors before being
    // written: `files: ["vendor/**"]` with a credential-bearing
    // `vendor/lib/.git/config` ships `package/vendor/lib/.git/config` on
    // pnpm 9.15.9 (the version npm-publish.yml pins by default) and on 10.23.0
    // alike. Against the root-anchored `^package/\.git(/|$)` the guard exited
    // 0 and the credential shipped.
    //
    // It needs a vendored checkout or a submodule, which none of the ten
    // consumers has today -- but it is the same file the guard is named for,
    // and #41 is scoped to BREADTH (other kinds of file) rather than DEPTH (the
    // same file elsewhere), so it would fall between the two issues.
    const run = runGuard({
      pkg: {
        name: '@stonyx/nested',
        version: '0.1.0',
        files: ['vendor/**'],
        scripts: { prepublishOnly: 'node -e "process.exit(0)"' },
      },
      files: {
        'vendor/lib/index.js': 'module.exports = {};\n',
        'vendor/lib/.git/config': '[remote "origin"]\n\turl = https://x:ghp_NESTEDFAKE@github.com/a/b.git\n',
      },
    });

    assert.notEqual(
      run.status,
      0,
      'a credential-bearing .git/config one directory down reached the tarball and the guard passed it. The '
      + `denylist is anchored at the package root only; stdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
    assert.match(
      run.stderr,
      /package\/vendor\/lib\/\.git\/config/,
      `the nested offender must be named at its real path; stderr:\n${run.stderr}`,
    );
    assert.deepEqual(run.pnpmArgs.filter((a) => a.startsWith('publish')), []);
  });

  test('a .git gitlink FILE is caught, which is the $ branch of the denylist', () => {
    // `\.git(/|$)` has two branches and only the `/` one was ever exercised, so
    // narrowing the pattern to `^package/\.git/` left the suite 344/344 green.
    //
    // The `$` branch is not decoration. In a git WORKTREE or SUBMODULE checkout
    // `.git` is a regular FILE holding a `gitdir:` pointer, so it lists with no
    // trailing slash -- and this repo's own release process uses worktrees.
    // Hand-built because no packer will emit that shape on demand; the guard
    // reads a tar listing, and a listing is all this needs to be.
    let source = null;
    const run = runGuard({
      pkg: { name: '@stonyx/gitlink', version: '0.1.0', files: ['index.js'] },
      files: { 'index.js': 'module.exports = {};\n' },
      packOverride: packOverrideProducing(['  cp "$WF39_GITLINK" "$PACK_DEST/gitlink-0.1.0.tgz"']),
      seed: ({ runnerTemp }) => {
        source = join(runnerTemp, 'gitlink-source.tgz');
        buildTarballFrom(source, {
          'package/package.json': '{"name":"@stonyx/gitlink","version":"0.1.0"}\n',
          'package/index.js': 'module.exports = {};\n',
          'package/.git': 'gitdir: /home/runner/work/stonyx-cron/.git/worktrees/rel\n',
        });
        process.env.WF39_GITLINK = source;
      },
    });
    delete process.env.WF39_GITLINK;

    // The fixture's shape is the whole test, so it is asserted rather than
    // trusted: `package/.git` must be present with NO trailing slash. If tar
    // ever emitted it as a directory entry this case would silently revert to
    // exercising the `/` branch the old pattern already covered.
    assert.ok(
      run.entries.includes('package/.git'),
      `the fixture must list \`package/.git\` with no trailing slash, or it does not exercise the $ branch; `
      + `entries:\n${run.entries.join('\n')}`,
    );
    assert.ok(
      !run.entries.includes('package/.git/'),
      `\`package/.git\` must be a FILE entry here; entries:\n${run.entries.join('\n')}`,
    );

    assert.notEqual(
      run.status,
      0,
      'a .git gitlink file must be denied. It points at a real git directory, and a consumer packing a worktree '
      + `checkout ships it with no trailing slash; stdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
    assert.match(
      run.stderr,
      /^package\/\.git$/m,
      `the offender must be named exactly; stderr:\n${run.stderr}`,
    );
    assert.deepEqual(run.pnpmArgs.filter((a) => a.startsWith('publish')), []);
  });
});
