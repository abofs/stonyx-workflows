import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envOf, parseSteps, readWorkflow, runBodyOf, stepScriptBody } from './helpers/workflow-yaml.js';

// Cascade gating, for abofs/stonyx-workflows#60.
//
// WHAT THIS SUITE EXECUTES, AND WHAT IT CANNOT.
//
// The questions #60 asks are about CONTROL FLOW across a whole job -- which
// steps run, which do not, and what the job hands to the consumer's `cascade`
// job -- and they live mostly in step `if:` conditions. Those are GitHub
// Actions expressions, which have no offline engine. A regex over the `if:`
// text would pin spellings, not behaviour. So this file carries a deliberately
// small evaluator for the expression subset the two workflows actually use
// (`==`, `!=`, `!`, `&&`, `||`, parentheses, string literals, context paths,
// `contains()`, `always()`, `success()`), and it THROWS on anything outside that
// subset rather than guessing. Adding a construct to a workflow `if:` that the
// evaluator does not know reds this file -- extend the evaluator, do not
// delete the case.
//
// With that, `simulateJob` walks the real `publish` job of a real
// `npm-publish.yml` text step by step:
//
//   - every `if:` is evaluated against a scenario's `github`/`inputs` context
//     and the outputs of the steps that ran before it;
//   - every step that has an `id:` (it produces outputs a later `if:` or env
//     reads), every `Bump version` step and the dependency-update step (both
//     rewrite package.json) has its REAL `run:` body executed under bash with stub `npm`/`pnpm`/`git`;
//   - every other step that would run -- install, tests, pack, publish,
//     commit/tag/push, GitHub Release, PR comment -- is RECORDED as having run
//     and not executed. Its side effect is exactly the thing being asserted on,
//     so "it was selected to run" is the observable;
//   - the job's `outputs:` are evaluated, and the consumer's `cascade` job is
//     reproduced by running the real `cascade.yml` dispatch `script:` with a
//     stub `github` client that records instead of dispatching -- the same
//     harness shape test/injection-test.js uses for #32 S5.
//
// What it does NOT model, stated rather than implied: a step failing for an
// environmental reason (a real `pnpm publish` refusing), GitHub's
// expression-level type coercions beyond string/boolean/null, and the
// consumer's `cascade` job `if:` on `main` (`!contains(head_commit.message,
// '[skip ci]')`), which is consumer-owned and unchanged by #60.
//
// "EXACTLY AS TODAY" IS MEASURED, NOT ASSERTED. The pre-#60 workflows are
// committed as fixtures (main@7fb718b, the branch point), and AC2/AC3/stable
// run the same scenario against old and new and require the same steps, the
// same pnpm calls, the same job output and the same dispatches.

const NEW_PUBLISH = readWorkflow('npm-publish.yml');
const NEW_CASCADE = readWorkflow('cascade.yml');
const OLD_PUBLISH = readFileSync(new URL('./fixtures/npm-publish-7fb718b.yml', import.meta.url), 'utf8');
const OLD_CASCADE = readFileSync(new URL('./fixtures/cascade-7fb718b.yml', import.meta.url), 'utf8');

const DISPATCH_STEP = 'Dispatch to downstream dependents';

// ---------------------------------------------------------------------------
// The expression evaluator.
// ---------------------------------------------------------------------------

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= src.length) throw new Error(`unterminated string literal in expression: ${src}`);
        if (src[j] === "'") {
          if (src[j + 1] === "'") { value += "'"; j += 2; continue; }
          break;
        }
        value += src[j++];
      }
      tokens.push({ type: 'str', value });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '&&', '||'].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
    if ('()!,'.includes(c)) { tokens.push({ type: 'op', value: c }); i++; continue; }
    const ident = src.slice(i).match(/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*/);
    if (ident) { tokens.push({ type: 'ident', value: ident[0] }); i += ident[0].length; continue; }
    throw new Error(`the test evaluator does not understand ${JSON.stringify(src.slice(i))} in expression: ${src}`);
  }
  return tokens;
}

const FUNCTIONS = {
  contains: (haystack, needle) => String(haystack ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase()),
  // The simulation only ever continues past a step that succeeded, so the
  // status functions are constants here.
  always: () => true,
  success: () => true,
};

const truthy = (v) => !(v === false || v === null || v === undefined || v === '' || v === 0);
const loosely = (a, b) => (typeof a === 'boolean' || typeof b === 'boolean')
  ? a === b
  : String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

function evaluate(src, ctx) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (value) => {
    const t = tokens[pos];
    if (!t || (value !== undefined && t.value !== value)) throw new Error(`expected ${value} at token ${pos} in: ${src}`);
    pos++;
    return t;
  };

  function primary() {
    const t = peek();
    if (!t) throw new Error(`unexpected end of expression: ${src}`);
    if (t.type === 'op' && t.value === '(') { take('('); const v = or(); take(')'); return v; }
    if (t.type === 'op' && t.value === '!') { take('!'); return !truthy(primary()); }
    if (t.type === 'str') { pos++; return t.value; }
    if (t.type === 'ident') {
      pos++;
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      if (peek() && peek().value === '(') {
        const fn = FUNCTIONS[t.value];
        if (!fn) throw new Error(`the test evaluator does not implement ${t.value}() (in: ${src})`);
        take('(');
        const args = [];
        while (peek() && peek().value !== ')') {
          args.push(or());
          if (peek() && peek().value === ',') take(',');
        }
        take(')');
        return fn(...args);
      }
      return lookup(t.value, ctx, src);
    }
    throw new Error(`unexpected token ${JSON.stringify(t.value)} in: ${src}`);
  }
  function equality() {
    let left = primary();
    while (peek() && (peek().value === '==' || peek().value === '!=')) {
      const op = take().value;
      const right = primary();
      left = op === '==' ? loosely(left, right) : !loosely(left, right);
    }
    return left;
  }
  function and() {
    let left = equality();
    while (peek() && peek().value === '&&') { take(); const right = equality(); left = truthy(left) ? right : left; }
    return left;
  }
  function or() {
    let left = and();
    while (peek() && peek().value === '||') { take(); const right = and(); left = truthy(left) ? left : right; }
    return left;
  }

  const value = or();
  if (pos !== tokens.length) throw new Error(`trailing tokens in expression: ${src}`);
  return value;
}

const ROOTS = new Set(['github', 'inputs', 'steps', 'secrets', 'job', 'jobs', 'needs']);

function lookup(path, ctx, src) {
  const [root, ...rest] = path.split('.');
  if (!ROOTS.has(root)) throw new Error(`unknown context root ${root} in: ${src}`);
  let value = ctx[root];
  for (const key of rest) {
    if (value === null || value === undefined) return null;
    value = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : null;
  }
  return value ?? null;
}

/** An `if:` value as written in YAML, with the optional `${{ }}` and quotes removed. */
function conditionSource(raw) {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  const wrapped = s.match(/^\$\{\{([\s\S]*)\}\}$/);
  return (wrapped ? wrapped[1] : s).trim();
}

/** A scalar with `${{ }}` templates in it, as the runner substitutes it. */
function interpolate(raw, ctx) {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr) => {
    const v = evaluate(expr, ctx);
    return v === null || v === undefined ? '' : String(v);
  });
}

// ---------------------------------------------------------------------------
// Step metadata.
// ---------------------------------------------------------------------------

const indentOf = (line) => line.match(/^(\s*)/)[1].length;

function stepKey(step, key) {
  const lines = step.body.split('\n').filter((l) => l.trim() !== '');
  const keyIndent = Math.min(...lines.map(indentOf));
  const line = lines.find((l) => indentOf(l) === keyIndent && new RegExp(`^\\s*${key}:(\\s|$)`).test(l));
  return line ? line.replace(new RegExp(`^\\s*${key}:\\s*`), '') : null;
}

function hasRun(step) {
  try { runBodyOf(step); return true; } catch { return false; }
}

/** The `outputs:` mapping of the `publish` job, raw. */
function jobOutputs(text) {
  const job = text.indexOf('\njobs:\n  publish:\n');
  if (job === -1) throw new Error('could not find jobs: > publish:');
  const m = text.slice(job).match(/^ {4}outputs:\n((?: {6}.*\n)+)/m);
  if (!m) throw new Error('could not find the publish job outputs: mapping');
  return Object.fromEntries(m[1].trimEnd().split('\n').map((l) => {
    const kv = l.trim().match(/^([\w-]+):\s*(.*)$/);
    return [kv[1], kv[2]];
  }));
}

function dedent(body) {
  const lines = body.split('\n');
  const widths = lines.filter((l) => l.trim() !== '').map((l) => l.match(/^(\s*)/)[1].length);
  const strip = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => l.slice(strip)).join('\n');
}

// ---------------------------------------------------------------------------
// The workspace and its stubs.
// ---------------------------------------------------------------------------

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

// `pnpm version <x> --no-git-tag-version` really rewrites package.json, which
// is what `Get package version` later reads. Everything else is logged only.
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

// The consumer under test: @stonyx/cron, whose one mapped dependent is
// abofs/stonyx-orm. Both of its Stonyx ranges match the registry below, so a
// cascade into it changes nothing unless a scenario moves a dist-tag.
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

// Steps without an `id:` that are executed anyway, because they rewrite
// package.json and a later executed step reads it.
const EXECUTED_BY_NAME = /^(Bump version|Update all Stonyx dependencies to latest$)/;

/**
 * Walk the `publish` job of `workflowText` under one scenario. See the header
 * for what is executed and what is only recorded.
 */
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
      const rawIf = stepKey(step, 'if');
      const runs = rawIf === null ? true : truthy(evaluate(conditionSource(rawIf), ctx));
      if (!runs) continue;
      ran.push(step.name);

      const id = stepKey(step, 'id');
      const execute = hasRun(step) && (id !== null || EXECUTED_BY_NAME.test(step.name));
      const outputs = {};
      if (execute) {
        executed.push(step.name);
        const env = Object.fromEntries(Object.entries(envOf(step)).map(([k, v]) => [k, interpolate(v, ctx)]));
        const outFile = join(workspace, 'github-output');
        writeFileSync(outFile, '');
        const script = join(workspace, 'step.sh');
        writeFileSync(script, dedent(runBodyOf(step)) + '\n');
        // GitHub's default `run:` shell for a step with no `shell:` key.
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

// ---------------------------------------------------------------------------
// The consumer's `cascade` job: the real dispatch script, stub github client.
// ---------------------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const nodeRequire = createRequire(import.meta.url);
const DEP_MAP_URL = new URL('../dependency-map.json', import.meta.url);

async function runDispatch(cascadeText, { packageName, publishedVersion }) {
  const script = dedent(stepScriptBody(cascadeText, DISPATCH_STEP));
  const dispatched = [];
  const logged = [];
  const github = { rest: { repos: { createDispatchEvent: async (args) => { dispatched.push(args); return { status: 204 }; } } } };
  const scriptRequire = (id) => {
    const mod = nodeRequire(id);
    if (id !== 'fs' && id !== 'node:fs') return mod;
    return { ...mod, readFileSync: (p, ...rest) => mod.readFileSync(p === 'dependency-map.json' ? DEP_MAP_URL : p, ...rest) };
  };
  const consoleStub = { log: (...a) => logged.push(a.join(' ')), error: (...a) => logged.push(a.join(' ')) };

  const previous = { PACKAGE_NAME: process.env.PACKAGE_NAME, PUBLISHED_VERSION: process.env.PUBLISHED_VERSION };
  const apply = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  apply('PACKAGE_NAME', packageName);
  apply('PUBLISHED_VERSION', publishedVersion);
  let error = null;
  try {
    await new AsyncFunction('require', 'github', 'context', 'core', 'console', script)(scriptRequire, github, {}, {}, consoleStub);
  } catch (e) {
    error = e;
  } finally {
    apply('PACKAGE_NAME', previous.PACKAGE_NAME);
    apply('PUBLISHED_VERSION', previous.PUBLISHED_VERSION);
  }
  return { error, dispatched, logged, repos: dispatched.map((d) => `${d.owner}/${d.repo}`) };
}

/** The whole consumer `publish.yml`: the publish job, then `cascade: needs: publish`. */
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

/** The fields "behaves exactly as today" is measured on. */
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

// ---------------------------------------------------------------------------

describe('#60 harness controls -- the simulation can see the defect it is used to rule out', () => {
  // Without these, every "dispatches nothing" assertion below could pass on a
  // harness that never reaches createDispatchEvent at all.
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

  test('the evaluator refuses an expression it does not implement rather than guessing', () => {
    assert.throws(() => evaluate("startsWith(github.ref, 'refs/')", { github: {} }), /does not implement startsWith/);
    assert.throws(() => evaluate('github.ref > 1', { github: {} }), /does not understand/);
    assert.throws(() => evaluate('vars.X', {}), /unknown context root/);
  });
});

describe('#60 AC1 -- an alpha (pull_request) publish dispatches to no dependent', () => {
  test.todo('the alpha still publishes and comments as before');
  test.todo('cascade.yml dispatches nothing and does not fail');
});

describe('#60 AC2 -- a push to dev (beta) dispatches exactly as before', () => {
  test('steps, pnpm calls, job outputs and dispatches are identical to main@7fb718b', async () => {
    const before = await simulateRun(OLD, 'devPush');
    const after = await simulateRun(NEW, 'devPush');
    assert.equal(after.failure, null, after.failure && after.failure.stderr);
    assert.deepEqual(behaviour(after, OLD_STEP_NAMES), behaviour(before));
    assert.deepEqual(after.dispatch.repos, ['abofs/stonyx-orm']);
    assert.match(after.outputs['published-version'], /^0\.2\.1-beta\.\d+$/);
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

describe('#60 AC4 -- a cascade that changes no Stonyx range releases nothing and ends green', () => {
  test.todo('no bump, publish, commit, tag, release or dispatch step runs');
  test.todo('the release gate fails loudly when the update step reported nothing');
});

describe('#60 AC5 -- cascade.yml input validation is not weakened', () => {
  test.todo('the no-cascade signal is distinct from an invalid version');
  test.todo('an invalid package name is still refused alongside the no-cascade signal');
});

