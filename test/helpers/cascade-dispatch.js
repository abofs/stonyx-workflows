// The consumer's `cascade` job, executed offline: the real `cascade.yml`
// dispatch `script:` run the way `actions/github-script` runs it -- as the
// body of an async function with `require`, `github`, `context` and `core` in
// scope -- against a stub `github` client that records instead of
// dispatching. Zero dependencies, no network, nothing published.
//
// Shared by test/injection-test.js (#32 S5) and test/cascade-gating-test.js
// (#60), so a change to how github-script is emulated is made once.

import { createRequire } from 'node:module';

import { stepScriptBody } from './workflow-yaml.js';

export const DISPATCH_STEP = 'Dispatch to downstream dependents';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const nodeRequire = createRequire(import.meta.url);
const DEP_MAP_URL = new URL('../../dependency-map.json', import.meta.url);

/** Strip the YAML block-scalar indentation without assuming a fixed depth. */
export function dedent(body) {
  const lines = body.split('\n');
  const widths = lines.filter((l) => l.trim() !== '').map((l) => l.match(/^(\s*)/)[1].length);
  const strip = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => l.slice(strip)).join('\n');
}

/**
 * Run the real dispatch script of `cascadeText` with the given env.
 *
 * `require` is shimmed for one reason only: the script reads
 * `dependency-map.json` by a path relative to the runner's checkout root, and
 * this keeps the case independent of the test process's cwd. Everything else
 * is the real module. An `undefined` value leaves the variable unset.
 */
export async function runDispatch(cascadeText, { packageName, publishedVersion }) {
  const script = dedent(stepScriptBody(cascadeText, DISPATCH_STEP));
  const dispatched = [];
  const logged = [];

  const github = {
    rest: {
      repos: {
        createDispatchEvent: async (args) => { dispatched.push(args); return { status: 204 }; },
      },
    },
  };
  const scriptRequire = (id) => {
    const mod = nodeRequire(id);
    if (id !== 'fs' && id !== 'node:fs') return mod;
    return {
      ...mod,
      readFileSync: (path, ...rest) => mod.readFileSync(path === 'dependency-map.json' ? DEP_MAP_URL : path, ...rest),
    };
  };
  const consoleStub = { log: (...args) => logged.push(args.join(' ')), error: (...args) => logged.push(args.join(' ')) };

  const previous = { PACKAGE_NAME: process.env.PACKAGE_NAME, PUBLISHED_VERSION: process.env.PUBLISHED_VERSION };
  const apply = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  apply('PACKAGE_NAME', packageName);
  apply('PUBLISHED_VERSION', publishedVersion);

  let error = null;
  try {
    const fn = new AsyncFunction('require', 'github', 'context', 'core', 'console', script);
    await fn(scriptRequire, github, {}, {}, consoleStub);
  } catch (e) {
    error = e;
  } finally {
    apply('PACKAGE_NAME', previous.PACKAGE_NAME);
    apply('PUBLISHED_VERSION', previous.PUBLISHED_VERSION);
  }

  return { error, dispatched, logged, repos: dispatched.map((d) => `${d.owner}/${d.repo}`) };
}
