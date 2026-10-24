import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, globSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFences, extractImports, formatReport, matchExports } from '../scripts/check-doc-imports.mjs';
import { readWorkflow } from './helpers/workflow-yaml.js';

// Committed red/green controls for scripts/check-doc-imports.mjs
// (abofs/stonyx#122, part 1: the checker, merged unwired).
//
// Every red case asserts the exact `file:line: CODE` it must print, not just a
// non-zero exit: a crash (syntax error, missing typescript) also exits non-zero
// and would otherwise pass every red case at once.

const SCRIPT = fileURLToPath(new URL('../scripts/check-doc-imports.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/doc-imports/', import.meta.url));

// The fixtures are copied to a temp dir before use. Module resolution walks up
// through every ancestor's node_modules, and a developer checkout can sit under
// a directory holding real @stonyx/* packages, which would resolve imports the
// fixtures mean to leave unresolved. Under the OS temp dir there is none.
let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 's95-doc-imports-'));
  cpSync(FIXTURES, root, { recursive: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

function run(repo, ...args) {
  return runCli(SCRIPT, join(root, repo), ...args);
}

function runCli(script, repoPath, ...args) {
  const r = spawnSync(process.execPath, [script, '--repo', repoPath, ...args], { encoding: 'utf8' });
  const summary = r.stdout.match(/^check-doc-imports: files=(\d+) checked=(\d+) failed=(\d+) skipped-anonymous-default=(\d+) members-unchecked=(\d+) typescript=(\S+)$/m);
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    lines: r.stdout.trim().split('\n'),
    summary: summary && {
      files: +summary[1], checked: +summary[2], failed: +summary[3], skipped: +summary[4], unchecked: +summary[5],
    },
  };
}

function assertRed(result, file, line, code) {
  assert.equal(result.status, 1, `expected exit 1\n${result.stdout}${result.stderr}`);
  assert.ok(result.summary, `summary line missing (crash?)\n${result.stdout}${result.stderr}`);
  assert.equal(result.summary.failed, 1, result.stdout);
  const prefix = `${file}:${line}: ${code} `;
  assert.ok(result.lines.some((l) => l.startsWith(prefix)), `expected a line starting ${JSON.stringify(prefix)}\n${result.stdout}`);
}

function assertGreen(result, checked) {
  assert.equal(result.status, 0, `expected exit 0\n${result.stdout}${result.stderr}`);
  assert.ok(result.summary, result.stdout + result.stderr);
  assert.equal(result.summary.failed, 0, result.stdout);
  assert.equal(result.summary.checked, checked, result.stdout);
}

describe('extraction', () => {
  test('backtick and tilde fences, indented fences, unclosed fence runs to EOF, CRLF', () => {
    const md = 'a\r\n```js\r\nx\r\n```\r\n~~~ts\r\ny\r\n~~~\r\n  ```\r\n  z\r\n  ```\r\n````md\r\n```js\r\nnot a fence\r\n```\r\n````\r\n```js\r\ntail';
    assert.deepEqual(extractFences(md).map((f) => [f.lang, f.startLine, f.text]), [
      ['js', 3, 'x'],
      ['ts', 6, 'y'],
      ['', 9, '  z'],
      ['md', 12, '```js\nnot a fence\n```'],
      ['js', 17, 'tail'],
    ]);
  });

  test('extracts all four spec shapes, import/export/side-effect, with doc line numbers', () => {
    const md = [
      '# t', '', '```js',
      "import Stonyx from 'stonyx';",
      "import config from 'stonyx/config';",
      "import Orm from '@stonyx/orm';",
      "export { default as Command } from '@stonyx/discord/command'; import '@stonyx/dashboard/styles/x.css';",
      'import {',
      '  a,',
      "} from \"@stonyx/utils/object\";",
      "import fs from 'node:fs';",
      "import notUs from 'stonyx-utils';",
      '```',
    ].join('\n');
    const { statements, unextracted } = extractImports(md);
    assert.deepEqual(unextracted, []);
    assert.deepEqual(statements.map((s) => [s.line, s.spec]), [
      [4, 'stonyx'], [5, 'stonyx/config'], [6, '@stonyx/orm'],
      [7, '@stonyx/discord/command'], [7, '@stonyx/dashboard/styles/x.css'], [8, '@stonyx/utils/object'],
    ]);
  });

  test('a statement cannot start at an unrelated export and run into the next import', () => {
    const md = "```js\nexport default class X {\n}\nimport Orm from '@stonyx/orm';\n```";
    const { statements } = extractImports(md);
    assert.deepEqual(statements.map((s) => s.text), ["import Orm from '@stonyx/orm'"]);
  });

  test('non-JS fences are not extracted but are seen by the guard; prose and dynamic import are out of scope', () => {
    const md = "`import A from '@stonyx/orm'`\n\n```sh\nimport A from '@stonyx/orm'\n```\n\n```js\nawait import('@stonyx/orm');\n```";
    const { statements, unextracted } = extractImports(md);
    assert.deepEqual(statements, []);
    assert.deepEqual(unextracted, [{ line: 4, spec: '@stonyx/orm', lang: 'sh' }]);
  });

  test('a // comment inside a multi-line import does not stop extraction', () => {
    const md = "```js\nimport {\n  Command, // the base class\n  type Ctx, /* ctx */\n} from '@stonyx/discord/command';\n```";
    const { statements, unextracted } = extractImports(md);
    assert.deepEqual(statements.map((s) => [s.line, s.spec]), [[2, '@stonyx/discord/command']]);
    assert.deepEqual(unextracted, []);
  });

  test('commented-out imports are neither checked nor failed; live code beside them is', () => {
    const md = "```js\n// import A from '@stonyx/a';\n/* import B from '@stonyx/b';\n   import C from '@stonyx/c'; */\nconst u = 'http://x'; import D from '@stonyx/d'; // import E from '@stonyx/e'\n```";
    const { statements, unextracted } = extractImports(md);
    assert.deepEqual(statements.map((s) => [s.line, s.spec]), [[5, '@stonyx/d']]);
    assert.deepEqual(unextracted, []);
  });

  test('specs outside the package-name grammar are extracted (so TS reports them), not ignored', () => {
    const md = "```js\nimport A from '@stonyx/Orm';\nimport B from '@stonyx/orm/';\nimport C from 'stonyx/';\nimport D from 'stonyx-utils';\nimport E from '@stonyxx/orm';\n```";
    const { statements, unextracted } = extractImports(md);
    assert.deepEqual(statements.map((s) => s.spec), ['@stonyx/Orm', '@stonyx/orm/', 'stonyx/']);
    assert.deepEqual(unextracted, []);
  });

  test('exports matching follows Node: exact key first, then longest wildcard prefix', () => {
    const exp = { '.': './a.js', './x/*': './x/*.js', './x/deep/*': './d/*.js', './x/exact': './e.js' };
    assert.equal(matchExports(exp, './x/exact').key, './x/exact');
    assert.equal(matchExports(exp, './x/deep/y').key, './x/deep/*');
    assert.equal(matchExports(exp, './x/deep/y').star, 'y');
    assert.equal(matchExports(exp, './nope'), null);
    assert.equal(matchExports('./main.js', '.').key, '.');
  });
});

describe('red fixtures (each must name file:line and the code)', () => {
  test('missing named member: TS2614, with the subpath suggestion and without TS\'s wrong one', () => {
    const r = run('discord', '--file', 'cases/red-missing-member.md');
    assertRed(r, 'cases/red-missing-member.md', 4, 'TS2614');
    assert.match(r.stdout, /Use: import Command from '@stonyx\/discord\/command'/);
    assert.doesNotMatch(r.stdout, /Did you mean/);
  });

  test('unexported subpath (file ships, exports key missing): TS2307', () => {
    assertRed(run('discord', '--file', 'cases/red-unexported-subpath.md'), 'cases/red-unexported-subpath.md', 4, 'TS2307');
  });

  test('side-effect import of an unexported subpath: TS2307 (noUncheckedSideEffectImports)', () => {
    assertRed(run('discord', '--file', 'cases/red-side-effect.md'), 'cases/red-side-effect.md', 4, 'TS2307');
  });

  test('default-name mismatch: TS\'s own suggested fix binds Discord as Command', () => {
    const r = run('discord', '--file', 'cases/red-default-name.md');
    assertRed(r, 'cases/red-default-name.md', 4, 'DEFAULT-NAME');
    assert.match(r.stdout, /declared 'Discord', the doc binds it as 'Command'/);
  });

  test('default re-exported under the wrong name', () => {
    assertRed(run('discord', '--file', 'cases/red-default-reexport-name.md'), 'cases/red-default-reexport-name.md', 4, 'DEFAULT-NAME');
  });

  test('type imported as a value: TS1484 (verbatimModuleSyntax)', () => {
    assertRed(run('discord', '--file', 'cases/red-type-as-value.md'), 'cases/red-type-as-value.md', 4, 'TS1484');
  });

  test('a fenced stonyx import that extracts to 0 fails, with checked=0', () => {
    const r = run('discord', '--file', 'cases/red-unextracted.md');
    assertRed(r, 'cases/red-unextracted.md', 4, 'UNEXTRACTED');
    assert.equal(r.summary.checked, 0);
  });

  test('one extracted import does not hide a second, unextracted one in the same file', () => {
    const r = run('discord', '--file', 'cases/red-unextracted-partial.md');
    assertRed(r, 'cases/red-unextracted-partial.md', 5, 'UNEXTRACTED');
    assert.equal(r.summary.checked, 1);
  });

  test('a stonyx import in a fence not tagged as JS/TS fails', () => {
    const r = run('discord', '--file', 'cases/red-untagged-language.md');
    assertRed(r, 'cases/red-untagged-language.md', 4, 'UNEXTRACTED');
    assert.match(r.stdout, /inside a `text` fence/);
  });

  test('wildcard export to a missing file', () => {
    assertRed(run('discord', '--file', 'cases/red-wildcard-no-file.md'), 'cases/red-wildcard-no-file.md', 4, 'WILDCARD-NO-FILE');
  });

  test('wildcard export whose .d.ts exists but whose runtime file does not', () => {
    assertRed(run('discord', '--file', 'cases/red-wildcard-types-only.md'), 'cases/red-wildcard-types-only.md', 4, 'WILDCARD-NO-FILE');
  });

  test('untyped package (dashboard shape): wildcard to a missing file', () => {
    assertRed(run('dashboard', '--file', 'cases/red-wildcard-no-file.md'), 'cases/red-wildcard-no-file.md', 4, 'WILDCARD-NO-FILE');
  });

  test('untyped package: subpath not in exports', () => {
    assertRed(run('dashboard', '--file', 'cases/red-not-exported.md'), 'cases/red-not-exported.md', 4, 'NOT-EXPORTED');
  });

  test('self-reference fails closed when the package is not built', () => {
    assertRed(run('unbuilt', '--file', 'cases/red-not-built.md'), 'cases/red-not-built.md', 4, 'TS2307');
  });

  test('a module resolved from --resolve-from: failure names its resolved version', () => {
    const r = run('core', '--file', 'cases/red-registry-member.md', '--resolve-from', join(root, 'registry'));
    assertRed(r, 'cases/red-registry-member.md', 4, 'TS2614');
    assert.match(r.stdout, /\[@stonyx\/cron@9\.9\.9-fixture\]/);
  });

  test('without --resolve-from, a module core does not depend on is unresolved', () => {
    const r = run('core', '--file', 'cases/green-registry.md');
    assertRed(r, 'cases/green-registry.md', 6, 'TS2307');
  });
});

describe('green fixtures', () => {
  test('correct subpath, default, type-only, multi-line, re-export, wildcard and side-effect imports', () => {
    assertGreen(run('discord', '--file', 'cases/green-subpath.md'), 9);
  });

  test('anonymous default is skipped and counted, not failed', () => {
    const r = run('discord', '--file', 'cases/green-anonymous-default.md');
    assertGreen(r, 1);
    assert.equal(r.summary.skipped, 1);
    assert.ok(r.lines.includes("skip cases/green-anonymous-default.md:4: anonymous default of '@stonyx/discord/config' bound as 'config' (name rule not applicable)"), r.stdout);
  });

  test('a doc with no stonyx imports passes with checked=0', () => {
    assertGreen(run('discord', '--file', 'cases/green-no-stonyx.md'), 0);
  });

  test('default discovery is README.md plus docs/**/*.md, and not cases/', () => {
    const r = run('discord');
    assertGreen(r, 2);
    assert.equal(r.summary.files, 2);
  });

  test('core: self-reference for stonyx/* plus --resolve-from for modules', () => {
    const r = run('core', '--file', 'cases/green-registry.md', '--resolve-from', join(root, 'registry'));
    assertGreen(r, 3);
    assert.equal(r.summary.skipped, 1);
  });

  test('untyped package: existing extensionless wildcard target passes, members counted as unchecked', () => {
    const r = run('dashboard', '--file', 'cases/green-wildcard.md');
    assertGreen(r, 2);
    assert.equal(r.summary.unchecked, 2);
  });

  test('probes are virtual: nothing is written into the checked repo', () => {
    run('discord');
    assert.deepEqual(globSync('**/__stonyx_doc_import_*', { cwd: root }), []);
  });
});

describe('cli and output', () => {
  test('unknown argument exits 2', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown argument: --nope/);
  });

  // The entry guard once compared resolve(argv[1]) with import.meta.url, which
  // Node gives as the realpath: invoked through any symlink (macOS /tmp, a
  // symlinked checkout) the script printed nothing and exited 0.
  test('invoked through a symlinked directory or file, the CLI still checks', () => {
    symlinkSync(dirname(SCRIPT), join(root, 'scripts-link'), 'dir');
    symlinkSync(SCRIPT, join(root, 'script-link.mjs'), 'file');
    for (const script of [join(root, 'scripts-link', 'check-doc-imports.mjs'), join(root, 'script-link.mjs')]) {
      const r = runCli(script, join(root, 'discord'), '--file', 'cases/red-missing-member.md');
      assertRed(r, 'cases/red-missing-member.md', 4, 'TS2614');
    }
  });

  test('a symlinked --repo with a --file given by its realpath reports the file repo-relative', () => {
    symlinkSync(join(root, 'discord'), join(root, 'discord-link'), 'dir');
    const file = join(realpathSync(root), 'discord', 'cases', 'red-missing-member.md');
    assertRed(runCli(SCRIPT, join(root, 'discord-link'), '--file', file), 'cases/red-missing-member.md', 4, 'TS2614');
  });

  test('a --repo that does not exist exits 2, not a vacuous 0', () => {
    const r = run('no-such-repo');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(r.summary, null, r.stdout);
    assert.match(r.stderr, /ENOENT/);
  });

  test('doc-derived text cannot start an output line (workflow commands are line-anchored)', () => {
    const out = formatReport({
      failures: [{ file: 'docs/a\n::error::x.md', line: 1, code: 'TS2307', message: 'm ::add-mask::y' }],
      skippedAnonymousDefault: [], membersUnchecked: [], files: ['x'], checked: 1, typescript: '0',
    });
    assert.equal(out.split('\n').length, 2);
    assert.ok(out.split('\n').every((l) => !l.startsWith('::')));
  });
});

describe('unwired (part 1 of 2)', () => {
  // Part 2 wires the step into ci.yml after the docs it fails on are fixed,
  // and replaces this with the step assertion (#122 validation 3).
  for (const file of ['ci.yml', 'npm-publish.yml', 'cascade.yml', 'security-audit.yml']) {
    test(`${file} does not run check-doc-imports yet`, () => {
      assert.ok(!readWorkflow(file).includes('check-doc-imports'), file);
    });
  }

  test('the fixture tree holds no stray node_modules beyond the committed registry', () => {
    const dirs = globSync('**/node_modules', { cwd: FIXTURES });
    assert.deepEqual(dirs, ['registry/node_modules']);
    assert.ok(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').includes('!test/fixtures/doc-imports/registry/node_modules/'));
  });
});
