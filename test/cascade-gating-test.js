import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { conditionSource, evaluate, interpolate, truthy } from './helpers/actions-expression.js';
import { dedent, runDispatch } from './helpers/cascade-dispatch.js';
import { envOf, parseSteps, readWorkflow, runBodyOf, stepScalarOf } from './helpers/workflow-yaml.js';


const NEW_PUBLISH = readWorkflow('npm-publish.yml');
const NEW_CASCADE = readWorkflow('cascade.yml');

const FIXTURES = {
  'npm-publish-7fb718b.yml': '9101da428da52d98641e2b322614c2b6c7e22efb',
  'cascade-7fb718b.yml': 'cf4eadd9a6542d690f58ed78ad080050516fd705',
};
const fixtureBytes = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const OLD_PUBLISH = fixtureBytes('npm-publish-7fb718b.yml').toString('utf8');
const OLD_CASCADE = fixtureBytes('cascade-7fb718b.yml').toString('utf8');


function hasRun(step) {
  try { runBodyOf(step); return true; } catch { return false; }
}

function jobOutputs(text) {
  const job = text.indexOf('\njobs:\n  publish:\n');
  if (job === -1) throw new Error('could not find jobs: > publish:');
  const m = text.slice(job).match(/^ {4}outputs:\n((?: {6}.*\n)+)/m);
  if (!m) throw new Error('could not find the publish job outputs: mapping');
  return Object.fromEntries(m[1].trimEnd().split('\n').map((l) => {
    const kv = l.match(/^ {6}(['"]?)([\w-]+)\1\s*:\s*(\S(?:.*\S)?)\s*$/);
    if (!kv || /(^|\s)#/.test(kv[3])) throw new Error(`unreadable publish job output line: ${JSON.stringify(l)}`);
    return [kv[2], kv[3]];
  }));
}


function npmStub(table, logPath) {
  return [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');`,
    `const table = ${JSON.stringify(table)};`,
    "const key = args.join(' ');",
    'if (!Object.prototype.hasOwnProperty.call(table, key)) {',
    "  process.stderr.write('npm ERR! code E404\\nnpm ERR! 404 Not Found - unexpected invocation in test stub: ' + key + '\\n');",
    '  process.exit(1);',
    '}',
    "process.stdout.write(table[key] + '\\n');",
    '',
  ].join('\n');
}

function pnpmStub(logPath) {
  return [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');`,
    "if (args[0] === 'version') {",
    "  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));",
    "  const [core, pre] = pkg.version.split('-');",
    "  let [maj, min, pat] = core.split('.').map(Number);",
    '  let next = args[1];',
    "  if (next === 'patch') next = pre ? core : `${maj}.${min}.${pat + 1}`;",
    "  else if (next === 'minor') next = `${maj}.${min + 1}.0`;",
    "  else if (next === 'major') next = `${maj + 1}.0.0`;",
    '  pkg.version = next;',
    "  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');",
    '}',
    '',
  ].join('\n');
}

const CRON_PACKAGE = {
  name: '@stonyx/cron',
  version: '0.2.1-beta.173',
  dependencies: { stonyx: '0.3.0-beta.9' },
  devDependencies: { '@stonyx/utils': '0.2.3-beta.37' },
};

const CRON_VERSIONS = [
  '0.2.0',
  ...Array.from({ length: 174 }, (_, n) => `0.2.1-beta.${n}`),
  ...Array.from({ length: 12 }, (_, n) => `0.2.1-alpha.${n}`),
];

function registry({ utilsBeta = '0.2.3-beta.37' } = {}) {
  return {
    'view stonyx dist-tags.beta': '0.3.0-beta.9',
    'view stonyx dist-tags.latest': '0.2.9',
    'view @stonyx/utils dist-tags.beta': utilsBeta,
    'view @stonyx/utils dist-tags.latest': '0.2.2',
    'view @stonyx/cron dist-tags.latest': '0.2.0',
    'view @stonyx/cron versions --json': JSON.stringify(CRON_VERSIONS),
  };
}

const SCENARIOS = {
  alpha: {
    github: { event_name: 'pull_request', ref: 'refs/pull/7/merge', ref_name: '7/merge', head_ref: 'feat/x' },
    inputs: { 'cascade-source': '' },
    npm: registry(),
  },
  devPush: {
    github: { event_name: 'push', ref: 'refs/heads/dev', ref_name: 'dev', head_ref: '' },
    inputs: { 'cascade-source': '' },
    npm: registry(),
  },
  mainPush: {
    github: { event_name: 'push', ref: 'refs/heads/main', ref_name: 'main', head_ref: '' },
    inputs: { 'cascade-source': '' },
    npm: registry(),
  },
  cascadeChanged: {
    github: { event_name: 'repository_dispatch', ref: 'refs/heads/dev', ref_name: 'dev', head_ref: '' },
    inputs: { 'cascade-source': '@stonyx/utils' },
    npm: registry({ utilsBeta: '0.2.3-beta.38' }),
  },
  cascadeUnchanged: {
    github: { event_name: 'repository_dispatch', ref: 'refs/heads/dev', ref_name: 'dev', head_ref: '' },
    inputs: { 'cascade-source': '@stonyx/utils' },
    npm: registry(),
  },
};

const EXECUTED_BY_NAME = /^(Bump version|Update all Stonyx dependencies to latest$)/;

function simulateJob(workflowText, scenario) {
  const workspace = mkdtempSync(join(tmpdir(), 'wf60-sim-'));
  try {
    const bin = join(workspace, 'bin');
    mkdirSync(bin);
    mkdirSync(join(workspace, '.stonyx-workflows', 'scripts'), { recursive: true });
    copyFileSync(
      new URL('../scripts/derive-version.mjs', import.meta.url),
      join(workspace, '.stonyx-workflows', 'scripts', 'derive-version.mjs'),
    );
    writeFileSync(join(workspace, 'package.json'), JSON.stringify(scenario.packageJson ?? CRON_PACKAGE, null, 2) + '\n');

    const npmLog = join(workspace, 'npm.log');
    const pnpmLog = join(workspace, 'pnpm.log');
    const gitLog = join(workspace, 'git.log');
    for (const f of [npmLog, pnpmLog, gitLog]) writeFileSync(f, '');
    writeFileSync(join(bin, 'npm'), npmStub(scenario.npm, npmLog));
    writeFileSync(join(bin, 'pnpm'), pnpmStub(pnpmLog));
    writeFileSync(join(bin, 'git'), [`#!${process.execPath}`,
      `require('fs').appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`, ''].join('\n'));
    for (const s of ['npm', 'pnpm', 'git']) chmodSync(join(bin, s), 0o755);

    const ctx = {
      github: { server_url: 'https://github.com', ...scenario.github },
      inputs: { 'version-type': '', 'custom-version': '', 'node-version': '24.13.0', 'pnpm-version': '9', ...scenario.inputs },
      secrets: { CASCADE_PAT: 'cascade-pat-placeholder' },
      job: { workflow_sha: '7fb718b0000000000000000000000000000000000' },
      steps: {},
    };

    const ran = [];
    const executed = [];
    let failure = null;

    for (const step of parseSteps(workflowText).filter((s) => s.job === 'publish')) {
      const rawIf = stepScalarOf(step, 'if', { optional: true });
      const runs = rawIf === null ? true : truthy(evaluate(conditionSource(rawIf), ctx));
      if (!runs) continue;
      ran.push(step.name);

      const id = stepScalarOf(step, 'id', { optional: true });
      const execute = hasRun(step) && (id !== null || EXECUTED_BY_NAME.test(step.name));
      const outputs = {};
      if (execute) {
        executed.push(step.name);
        const env = Object.fromEntries(Object.entries(envOf(step)).map(([k, v]) => [k, interpolate(v, ctx)]));
        const outFile = join(workspace, 'github-output');
        writeFileSync(outFile, '');
        const script = join(workspace, 'step.sh');
        writeFileSync(script, dedent(runBodyOf(step)) + '\n');
        const result = spawnSync('bash', ['--noprofile', '--norc', '-e', script], {
          cwd: workspace,
          encoding: 'utf8',
          env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, GITHUB_OUTPUT: outFile, ...env },
        });
        if (result.status !== 0) {
          failure = { step: step.name, status: result.status, stderr: result.stderr };
          break;
        }
        for (const line of readFileSync(outFile, 'utf8').split('\n').filter(Boolean)) {
          const eq = line.indexOf('=');
          outputs[line.slice(0, eq)] = line.slice(eq + 1);
        }
      }
      if (id !== null) ctx.steps[id] = { outputs, conclusion: 'success' };
    }

    const outputs = failure
      ? null
      : Object.fromEntries(Object.entries(jobOutputs(workflowText)).map(([k, v]) => [k, interpolate(v, ctx)]));

    const readLog = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return {
      ran,
      executed,
      failure,
      outputs,
      pnpmCalls: readLog(pnpmLog),
      gitCalls: readLog(gitLog),
      packageJson: JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}


async function simulateRun({ publish, cascade }, scenarioName) {
  const job = simulateJob(publish, SCENARIOS[scenarioName]);
  const dispatch = job.failure
    ? null
    : await runDispatch(cascade, { packageName: job.outputs['package-name'], publishedVersion: job.outputs['published-version'] });
  return { ...job, dispatch };
}

const OLD = { publish: OLD_PUBLISH, cascade: OLD_CASCADE };
const NEW = { publish: NEW_PUBLISH, cascade: NEW_CASCADE };

const PUBLISH_STEPS = ['Publish to NPM (alpha)', 'Publish to NPM (beta)', 'Publish to NPM (stable)'];
const PUSH_STEPS = ['Commit version bump and create tag (beta)', 'Commit version bump and create tag (stable)'];
const STABLE_TRIO = ['Publish to NPM (stable)', 'Commit version bump and create tag (stable)', 'Create GitHub Release (stable)'];
const BETA_TRIO = ['Publish to NPM (beta)', 'Commit version bump and create tag (beta)', 'Create GitHub Release (beta)'];
const DERIVATION_STEPS = ['Resolve stonyx-workflows ref', 'Checkout stonyx-workflows (for version derivation script)'];

function assertRanAndSkipped(run, { ran, skipped }, label) {
  for (const name of ran) assert.ok(run.ran.includes(name), `${label}: ${name} must run`);
  for (const name of skipped) assert.ok(!run.ran.includes(name), `${label}: ${name} must not run`);
}

function behaviour(run, onlySteps) {
  return {
    ran: onlySteps ? run.ran.filter((n) => onlySteps.includes(n)) : run.ran,
    pnpmCalls: run.pnpmCalls,
    packageJson: run.packageJson,
    publishedVersion: run.outputs && run.outputs['published-version'],
    versionChannel: run.outputs && run.outputs['version-channel'],
    dispatched: run.dispatch && run.dispatch.dispatched,
    dispatchError: run.dispatch && run.dispatch.error && run.dispatch.error.message,
  };
}

const OLD_STEP_NAMES = parseSteps(OLD_PUBLISH).map((s) => s.name);


describe('#60 harness controls -- the simulation can see the defect it is used to rule out', () => {
  for (const [name, blobSha] of Object.entries(FIXTURES)) {
    test(`the pinned baseline ${name} is the exact blob from main@7fb718b`, () => {
      const bytes = fixtureBytes(name);
      const sha = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes])).digest('hex');
      assert.equal(sha, blobSha, `fixtures/${name} is not the blob it claims to be`);
    });
  }

  test('main@7fb718b: an alpha (pull_request) run publishes an alpha AND dispatches to stonyx-orm', async () => {
    const run = await simulateRun(OLD, 'alpha');
    assert.equal(run.failure, null, run.failure && run.failure.stderr);
    assert.ok(run.ran.includes('Publish to NPM (alpha)'));
    assert.match(run.outputs['published-version'], /-alpha\.\d+$/);
    assert.deepEqual(run.dispatch.repos, ['abofs/stonyx-orm'], 'the measured #60 problem 1');
  });

  test('main@7fb718b: a cascade that changes no range still bumps, publishes, pushes and dispatches', async () => {
    const run = await simulateRun(OLD, 'cascadeUnchanged');
    assert.equal(run.failure, null, run.failure && run.failure.stderr);
    assert.deepEqual(run.packageJson.devDependencies, CRON_PACKAGE.devDependencies, 'no range moved');
    assert.ok(run.ran.includes('Publish to NPM (beta)'));
    assert.ok(run.ran.includes('Commit version bump and create tag (beta)'));
    assert.match(run.outputs['published-version'], /-beta\.\d+$/);
    assert.deepEqual(run.dispatch.repos, ['abofs/stonyx-orm'], 'the measured #60 problem 2');
  });

  test('main@7fb718b: a cascade whose range moved really is detected as a change by the harness', async () => {
    const run = await simulateRun(OLD, 'cascadeChanged');
    assert.equal(run.failure, null, run.failure && run.failure.stderr);
    assert.equal(run.packageJson.devDependencies['@stonyx/utils'], '0.2.3-beta.38');
  });

  test('envOf and jobOutputs refuse a continued or commented value, and read a one-line value as written', () => {
    const stepWith = (envLines) => parseSteps(['jobs:', '  j:', '    steps:', '      - name: s', '        env:',
      ...envLines.map((l) => `          ${l}`), '        run: true', ''].join('\n'))[0];
    assert.deepEqual(envOf(stepWith(['A: one', 'B: "two"', "C: 'it''s'"])), { A: 'one', B: '"two"', C: "'it''s'" });
    assert.throws(() => envOf(stepWith(['A: one', '  two'])), /continues onto the next line/);
    assert.throws(() => envOf(stepWith(['A: one', '  B: two'])), /continues onto the next line/);
    assert.throws(() => envOf(stepWith(['A: one # two'])), /# comment/);
    assert.throws(() => envOf(stepWith(['A: "one', '  two"'])), /continues onto the next line|not closed/);

    const outputsLine = '      package-name: ${{ steps.package-name.outputs.name }}\n';
    assert.equal(NEW_PUBLISH.split(outputsLine).length, 2, 'the package-name output line must occur exactly once');
    assert.equal(jobOutputs(NEW_PUBLISH)['package-name'], '${{ steps.package-name.outputs.name }}');
    for (const tail of ['        || x\n', '        x: y\n']) {
      assert.throws(() => jobOutputs(NEW_PUBLISH.replace(outputsLine, outputsLine + tail)), /unreadable publish job output line/);
    }
    assert.throws(() => jobOutputs(NEW_PUBLISH.replace(outputsLine, outputsLine.replace('}}', '}} # c'))),
      /unreadable publish job output line/);
  });

  test('the evaluator refuses an expression it does not implement rather than guessing', () => {
    assert.throws(() => evaluate("startsWith(github.ref, 'refs/')", { github: {} }), /does not implement startsWith/);
    assert.throws(() => evaluate('github.ref > 1', { github: {} }), /does not understand/);
    assert.throws(() => evaluate('vars.X', {}), /unknown context root/);
  });
});

describe('#60 harness controls -- the expression evaluator computes GitHub\'s answers', () => {
  const ctx = {
    github: { event_name: 'push', ref_name: 'Main' },
    steps: { gate: { outputs: { release: 'true', empty: '' } } },
    inputs: {},
  };
  const TABLE = [
    ["!''", true], ["!'x'", false], ['!null', true], ['!true', false], ['!false', true], ["!'false'", false],
    ['!steps.gate.outputs.missing', true], ["!!'x'", true],
    ["'a' && 'b'", 'b'], ["'' && 'b'", ''], ["null && 'b'", null], ["'a' && ''", ''],
    ["'a' || 'b'", 'a'], ["'' || 'b'", 'b'], ["null || ''", ''], ["'' || null", null],
    ["'' && 'x' || 'y'", 'y'], ["'a' || 'b' && ''", 'a'], ["!'' && 'z'", 'z'], ["!'a' == false", true],
    ["('' || 'a') && 'b'", 'b'], ["'' && ('x' || 'y')", ''],
    ["'ABC' == 'abc'", true], ["'a' == 'b'", false], ["'a' != 'b'", true], ["'a' != 'A'", false],
    ["null == ''", true], ["null == 'x'", false], ['null == null', true], ['true == true', true], ['true != false', true],
    ["github.ref_name == 'main'", true], ["github.event_name != 'push'", false],
    ["steps.gate.outputs.release == 'true'", true], ["steps.gate.outputs.empty == 'true'", false],
    ["steps.nope.outputs.release == 'true'", false], ["steps.nope.outputs.release == ''", true],
    ['steps.gate.outputs.release.length', null], ["null == 'x0'", false], ["null == 'refs/heads/0'", false],
    ["contains('Hello', 'ELL')", true], ["contains('abc', 'd')", false], ["contains(null, 'a')", false],
    ["contains('', '')", true], ["contains(github.ref_name, 'AI')", true],
    ["!contains('0.2.1', 'alpha') && !contains('0.2.1', 'beta')", true],
    ["!contains('0.2.1-beta.3', 'alpha') && !contains('0.2.1-beta.3', 'beta')", false],
    ["'x' == 'y' || 'beta' == 'beta'", true], ["'x' == 'y' || 'a' == 'b'", false],
  ];
  for (const [src, expected] of TABLE) {
    test(`${src}  =>  ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(evaluate(src, ctx), expected);
    });
  }

  for (const [src, pattern] of [
    ["contains('a' 'b')", /expected \)/],
    ["contains('abc', 'b', 'zzz')", /takes 2 argument/],
    ["contains('abc')", /takes 2 argument/],
    ["always('junk')", /takes 0 argument/],
    ["'a' 'b'", /trailing tokens/],
    ["('a'", /expected \)/],
    ["'a' ==", /unexpected end/],
    ["'' == false", /number coercion/],
    ["'true' == true", /number coercion/],
    ["null == '0'", /number coercion/],
    ["null == ' '", /number coercion/], ["null == '00'", /number coercion/], ["null == '+0'", /number coercion/],
    ["null == '.0'", /number coercion/], ["null == '0.'", /number coercion/], ["null == '0o0'", /number coercion/],
    ["github.Event_Name == 'push'", /case-insensitively/], ["steps.GATE.outputs.release", /case-insensitively/],
    ['contains(true, \'t\')', /does not implement contains/],
  ]) {
    test(`refuses ${src}`, () => {
      assert.throws(() => evaluate(src, ctx), pattern);
    });
  }
});

describe('#60 AC1 -- an alpha (pull_request) publish dispatches to no dependent', () => {
  test('the alpha still bumps, publishes and comments exactly as main@7fb718b did, and nothing is pushed', async () => {
    const before = await simulateRun(OLD, 'alpha');
    const after = await simulateRun(NEW, 'alpha');
    assert.equal(after.failure, null, after.failure && after.failure.stderr);
    const { publishedVersion: _a, dispatched: _b, ...afterRest } = behaviour(after, OLD_STEP_NAMES);
    const { publishedVersion: _c, dispatched: _d, ...beforeRest } = behaviour(before);
    assert.deepEqual(afterRest, beforeRest);
    for (const name of ['Publish to NPM (alpha)', 'Comment on PR with alpha version']) {
      assert.ok(after.ran.includes(name), `${name} must still run`);
    }
    for (const name of [...PUSH_STEPS, 'Publish to NPM (beta)', 'Publish to NPM (stable)']) {
      assert.ok(!after.ran.includes(name), `${name} must not run on an alpha`);
    }
    assert.equal(after.outputs['version-channel'], 'alpha');
    for (const [label, run] of [['main@7fb718b', before], ['head', after]]) {
      assertRanAndSkipped(run, {
        ran: [...DERIVATION_STEPS, 'Calculate next alpha version', 'Publish to NPM (alpha)'],
        skipped: [...STABLE_TRIO, ...BETA_TRIO, 'Calculate next beta version'],
      }, `alpha, ${label}`);
    }
  });

  test('the job hands cascade.yml the no-cascade token, which dispatches nothing and does not fail', async () => {
    const run = await simulateRun(NEW, 'alpha');
    assert.equal(run.outputs['published-version'], 'no-cascade');
    assert.equal(run.dispatch.error, null, run.dispatch.error && run.dispatch.error.message);
    assert.deepEqual(run.dispatch.dispatched, []);
  });
});

describe('#60 AC2 -- a push to dev (beta) dispatches exactly as before', () => {
  test('steps, pnpm calls, job outputs and dispatches are identical to main@7fb718b', async () => {
    const before = await simulateRun(OLD, 'devPush');
    const after = await simulateRun(NEW, 'devPush');
    assert.equal(after.failure, null, after.failure && after.failure.stderr);
    assert.deepEqual(behaviour(after, OLD_STEP_NAMES), behaviour(before));
    assert.deepEqual(after.dispatch.repos, ['abofs/stonyx-orm']);
    assert.match(after.outputs['published-version'], /^0\.2\.1-beta\.\d+$/);
    for (const [label, run] of [['main@7fb718b', before], ['head', after]]) {
      assertRanAndSkipped(run, {
        ran: [...DERIVATION_STEPS, 'Calculate next beta version', ...BETA_TRIO],
        skipped: [...STABLE_TRIO, 'Publish to NPM (alpha)', 'Calculate next alpha version', 'Comment on PR with alpha version'],
      }, `dev push, ${label}`);
    }
  });
});

describe('#60 AC2 (stable) -- a push to main is unchanged', () => {
  test('steps, pnpm calls, job outputs and dispatches are identical to main@7fb718b', async () => {
    const before = await simulateRun(OLD, 'mainPush');
    const after = await simulateRun(NEW, 'mainPush');
    assert.equal(after.failure, null, after.failure && after.failure.stderr);
    assert.deepEqual(behaviour(after, OLD_STEP_NAMES), behaviour(before));
    assert.deepEqual(after.dispatch.repos, ['abofs/stonyx-orm']);
    assert.equal(after.outputs['published-version'], '0.2.1');
    for (const [label, run] of [['main@7fb718b', before], ['head', after]]) {
      assertRanAndSkipped(run, {
        ran: ['Bump version (stable)', ...STABLE_TRIO],
        skipped: [...BETA_TRIO, ...DERIVATION_STEPS, 'Publish to NPM (alpha)', 'Comment on PR with alpha version'],
      }, `main push, ${label}`);
    }
  });
});

describe('#60 AC3 -- a cascade that changes a Stonyx range behaves exactly as before', () => {
  test('steps, pnpm calls, job outputs and dispatches are identical to main@7fb718b', async () => {
    const before = await simulateRun(OLD, 'cascadeChanged');
    const after = await simulateRun(NEW, 'cascadeChanged');
    assert.equal(after.failure, null, after.failure && after.failure.stderr);
    assert.deepEqual(behaviour(after, OLD_STEP_NAMES), behaviour(before));
    for (const name of ['Publish to NPM (beta)', 'Commit version bump and create tag (beta)', 'Create GitHub Release (beta)']) {
      assert.ok(after.ran.includes(name), `${name} must still run`);
    }
    assert.deepEqual(after.dispatch.repos, ['abofs/stonyx-orm']);
  });
});

function runBody(stepName, env) {
  const step = parseSteps(NEW_PUBLISH).find((st) => st.name === stepName);
  assert.ok(step, `no step named ${stepName}`);
  const dir = mkdtempSync(join(tmpdir(), 'wf60-step-'));
  try {
    const out = join(dir, 'github-output');
    writeFileSync(out, '');
    writeFileSync(join(dir, 'step.sh'), dedent(runBodyOf(step)) + '\n');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-e', join(dir, 'step.sh')], {
      cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env },
    });
    return { status: r.status, stderr: r.stderr, outputKeys: readFileSync(out, 'utf8').split('\n').filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RELEASE_GATE_STEP = 'Decide whether this run releases';
const CASCADE_GATE_STEP = 'Decide whether to cascade';

describe('#60 AC4 -- a cascade that changes no Stonyx range releases nothing and ends green', () => {
  test('only the steps up to the release gate, the cleanup and the cascade gate run; both jobs end green', async () => {
    const run = await simulateRun(NEW, 'cascadeUnchanged');

    assert.equal(run.failure, null, `the publish job must conclude success: ${run.failure && run.failure.stderr}`);
    assert.deepEqual(run.ran, [
      'Checkout code',
      'Setup pnpm',
      'Set up Node.js',
      'Get package name',
      'Update all Stonyx dependencies to latest',
      RELEASE_GATE_STEP,
      'Remove stonyx-workflows checkout',
      CASCADE_GATE_STEP,
    ]);
    for (const name of [...PUBLISH_STEPS, ...PUSH_STEPS, 'Create GitHub Release (beta)', 'Create GitHub Release (stable)']) {
      assert.ok(!run.ran.includes(name), `${name} must not run`);
    }
    assert.deepEqual(run.pnpmCalls, [], 'nothing installed, tested, bumped, packed or published');
    assert.deepEqual(run.packageJson, CRON_PACKAGE, 'package.json is untouched');
    assert.equal(run.outputs['published-version'], 'no-cascade');

    assert.equal(run.dispatch.error, null, `the cascade job must conclude success: ${run.dispatch.error && run.dispatch.error.message}`);
    assert.deepEqual(run.dispatch.dispatched, [], 'no dependent is dispatched');
  });

  test('the release gate opens for a changed cascade and for every non-cascade run', () => {
    assert.deepEqual(runBody(RELEASE_GATE_STEP, { CASCADE_SOURCE: '@stonyx/utils', DEPS_CHANGED: 'true' }).outputKeys, ['release=true']);
    assert.deepEqual(runBody(RELEASE_GATE_STEP, { CASCADE_SOURCE: '@stonyx/utils', DEPS_CHANGED: 'false' }).outputKeys, ['release=false']);
    assert.deepEqual(runBody(RELEASE_GATE_STEP, { CASCADE_SOURCE: '', DEPS_CHANGED: '' }).outputKeys, ['release=true']);
  });

  for (const changed of ['', 'TRUE', 'yes', 'false\nrelease=true']) {
    test(`the release gate fails, rather than guessing, when the update step reported ${JSON.stringify(changed)}`, () => {
      const run = runBody(RELEASE_GATE_STEP, { CASCADE_SOURCE: '@stonyx/utils', DEPS_CHANGED: changed });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /Refusing to guess whether this run should release/);
      assert.deepEqual(run.outputKeys, []);
    });
  }

  for (const channel of ['beta', 'stable', 'custom', 'patch', 'minor', 'major']) {
    test(`the cascade gate hands a ${channel} release's version to cascade.yml`, () => {
      const run = runBody(CASCADE_GATE_STEP, { RELEASE: 'true', CHANNEL: channel, PUBLISHED_VERSION: '0.2.2' });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(run.outputKeys, ['version=0.2.2']);
    });
  }
  test('the cascade gate hands an alpha release the no-cascade token', () => {
    const run = runBody(CASCADE_GATE_STEP, { RELEASE: 'true', CHANNEL: 'alpha', PUBLISHED_VERSION: '0.2.1-alpha.12' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.outputKeys, ['version=no-cascade']);
  });
  for (const channel of ['', 'beta', 'stable', 'patch']) {
    test(`the cascade gate hands the no-cascade token when nothing released (channel ${JSON.stringify(channel)})`, () => {
      const run = runBody(CASCADE_GATE_STEP, { RELEASE: 'false', CHANNEL: channel, PUBLISHED_VERSION: '' });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(run.outputKeys, ['version=no-cascade']);
    });
  }

  for (const [label, env, pattern] of [
    ['an unreported release decision', { RELEASE: '', CHANNEL: 'beta', PUBLISHED_VERSION: '0.2.1-beta.174' }, /expected true or false/],
    ['an unknown channel', { RELEASE: 'true', CHANNEL: 'nightly', PUBLISHED_VERSION: '0.2.1-nightly.1' }, /unknown release channel/],
    ['a release with no recorded version', { RELEASE: 'true', CHANNEL: 'beta', PUBLISHED_VERSION: '' }, /no version was recorded/],
  ]) {
    test(`the cascade gate fails, rather than emitting a value, on ${label}`, () => {
      const run = runBody(CASCADE_GATE_STEP, env);
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, pattern);
      assert.deepEqual(run.outputKeys, []);
    });
  }
});

describe('#60 AC5 -- cascade.yml input validation is not weakened', () => {
  test('the no-cascade token, with a valid name, dispatches nothing and does not throw', async () => {
    const run = await runDispatch(NEW_CASCADE, { packageName: '@stonyx/cron', publishedVersion: 'no-cascade' });
    assert.equal(run.error, null);
    assert.deepEqual(run.dispatched, []);
    assert.ok(run.logged.some((l) => /Nothing to cascade for @stonyx\/cron/.test(l)), JSON.stringify(run.logged));
  });

  test('an invalid package name is still refused when the version is the no-cascade token', async () => {
    const run = await runDispatch(NEW_CASCADE, { packageName: '@stonyx/x`id`', publishedVersion: 'no-cascade' });
    assert.notEqual(run.error, null);
    assert.match(run.error.message, /is not a valid npm package name/);
  });

  for (const near of ['', ' no-cascade', 'no-cascade ', 'NO-CASCADE', 'no-cascade\nmalicious=1', 'no_cascade']) {
    test(`${JSON.stringify(near)} is an invalid version, not the no-cascade token`, async () => {
      const run = await runDispatch(NEW_CASCADE, { packageName: '@stonyx/cron', publishedVersion: near });
      assert.notEqual(run.error, null, `${JSON.stringify(near)} must be refused`);
      assert.match(run.error.message, /is not a valid semver version/);
      assert.deepEqual(run.dispatched, []);
    });
  }

  test('a valid version with a valid name still dispatches', async () => {
    const run = await runDispatch(NEW_CASCADE, { packageName: '@stonyx/cron', publishedVersion: '0.2.1-beta.174' });
    assert.equal(run.error, null);
    assert.deepEqual(run.repos, ['abofs/stonyx-orm']);
  });
});
