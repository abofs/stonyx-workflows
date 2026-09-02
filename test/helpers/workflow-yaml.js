// Minimal, purpose-built reader for the workflow YAML in this repo.
//
// This repo has no dependencies by design (abofs/stonyx-workflows#22), so there
// is no YAML library available. These helpers do not implement YAML; they
// extract the two specific shapes the tests assert on -- a step's `run:` block
// and a workflow's top-level trigger keys -- and throw loudly rather than
// returning something plausible when the shape is not what they expect.
//
// A silent wrong answer here would make the anti-drift assertions vacuous, so
// every lookup failure is an exception, never a default.

import { readFileSync } from 'node:fs';

const REPO_ROOT = new URL('../../', import.meta.url);

export function workflowPath(name) {
  return new URL(`.github/workflows/${name}`, REPO_ROOT);
}

export function readWorkflow(name) {
  return readFileSync(workflowPath(name), 'utf8');
}

const indentOf = (line) => line.match(/^(\s*)/)[1].length;

/**
 * Split a workflow's `steps:` list into `{ name, body }` entries. `body` is the
 * raw text of every line belonging to that step.
 */
export function parseSteps(text) {
  const lines = text.split('\n');
  const stepsIdx = lines.findIndex((l) => /^\s*steps:\s*$/.test(l));
  if (stepsIdx === -1) throw new Error('workflow has no steps: block');

  const steps = [];
  let listIndent = null;
  let current = null;

  for (let i = stepsIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)- name: (.*)$/);
    if (match && (listIndent === null || match[1].length === listIndent)) {
      listIndent = match[1].length;
      current = { name: match[2].trim(), lines: [] };
      steps.push(current);
      continue;
    }
    if (current) current.lines.push(lines[i]);
  }

  if (steps.length === 0) throw new Error('workflow steps: block contained no named steps');
  return steps.map(({ name, lines: body }, index) => ({ name, index, body: body.join('\n') }));
}

/**
 * Every step in `text` carrying `name`, in file order.
 *
 * GitHub Actions does not require step names to be unique -- only `id` must be
 * -- so a name is an ambiguous key, not an identity. `stepsNamed` exists so
 * that ambiguity is visible instead of being silently resolved to the first
 * match (abofs/stonyx-workflows#37).
 */
export function stepsNamed(text, stepName) {
  return parseSteps(text).filter((s) => s.name === stepName);
}

/**
 * The one step named `stepName`, or a throw.
 *
 * Throws when the name is missing AND when it is ambiguous. `.find()` returned
 * the first match for a duplicated name, so a second step sharing a name had
 * its body never read: both repo-wide sweeps iterated `parseSteps` positionally
 * and then re-resolved each body BY NAME through these helpers, which handed
 * back the first step's body twice. A `run:` or `script:` sink in the second
 * step was therefore invisible while the suite stayed green
 * (abofs/stonyx-workflows#37, bypass 1 / M1 / M1c).
 *
 * The name-taking entry points are kept because ~20 call sites read a specific
 * named step and are clearer for it; they are now unable to answer ambiguously.
 * Code that must not depend on names -- the sweeps -- takes the step object
 * from `parseSteps` and calls `runBodyOf`/`scriptBodyOf`/`envOf` directly.
 */
export function stepNamed(text, stepName) {
  const matches = stepsNamed(text, stepName);
  if (matches.length === 0) throw new Error(`no step named ${JSON.stringify(stepName)}`);
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} steps are named ${JSON.stringify(stepName)} (positions `
      + `${matches.map((s) => s.index).join(', ')}); a step name is not an identity in GitHub Actions, so `
      + 'resolve this step positionally from parseSteps() rather than by name',
    );
  }
  return matches[0];
}

/**
 * Step names that appear more than once in a workflow, with their count.
 */
export function duplicateStepNames(text) {
  const seen = new Map();
  for (const step of parseSteps(text)) seen.set(step.name, (seen.get(step.name) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([name, count]) => ({ name, count }));
}

// A YAML block-scalar header: the style indicator, then an optional chomping
// indicator and an optional explicit indentation indicator, in either order.
//
// `stepRunBody`'s inline branch used the negative lookahead `(?!\|)`, which
// enumerated ONE of the two style indicators. `run: >` therefore matched the
// inline branch and the helper returned the literal string `">"` as the entire
// body -- every folded line, including any `${{ }}` in it, fell outside the
// sweep with the suite green (abofs/stonyx-workflows#37, bypass 2 / M2).
const BLOCK_SCALAR_HEADER = /^[|>](?:[-+][0-9]*|[0-9]+[-+]?)?$/;

/** The lines belonging to a block scalar opened on `lines[headerIdx]`. */
function blockScalarBody(lines, headerIdx, describe) {
  const headerIndent = indentOf(lines[headerIdx]);
  const out = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { out.push(lines[i]); continue; }
    if (indentOf(lines[i]) <= headerIndent) break;
    out.push(lines[i]);
  }
  if (out.join('').trim() === '') throw new Error(`${describe} is empty`);
  return out.join('\n');
}

/**
 * The value of a scalar `key:` inside a step, whether written inline or as a
 * block scalar.
 *
 * A scalar header the helper does not understand THROWS rather than being
 * returned as if it were the body -- the promise this file's header makes and
 * the one `run: >` broke. YAML tags (`!!str`), anchors (`&x`) and aliases
 * (`*x`) all change what the value is, so none of them may be handed back
 * verbatim.
 */
function stepScalar(step, key) {
  const lines = step.body.split('\n');
  const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}:(\\s|$)`).test(l));
  if (idx === -1) throw new Error(`step ${JSON.stringify(step.name)} has no ${key}: key`);

  const value = lines[idx].replace(new RegExp(`^\\s*${key}:\\s*`), '').replace(/\s+$/, '');
  const where = `step ${JSON.stringify(step.name)} ${key}: block`;

  if (value === '' || BLOCK_SCALAR_HEADER.test(value)) return blockScalarBody(lines, idx, where);

  if (/^[|>&*!]/.test(value)) {
    throw new Error(
      `unrecognised ${key}: scalar header in step ${JSON.stringify(step.name)}: ${JSON.stringify(value)}. `
      + 'This helper does not understand it, and returning it as the body would put whatever it introduces '
      + 'outside every sweep -- extend the helper instead of deleting the case that failed.',
    );
  }

  return value;
}

/** The body of a step's `run:` block, taken from the step object, never by name. */
export function runBodyOf(step) {
  return stepScalar(step, 'run');
}

/** The body of a step's `with: script:` block, taken from the step object. */
export function scriptBodyOf(step) {
  return stepScalar(step, 'script');
}

/**
 * The body of a named step's `run:` block, with the block scalar indentation
 * left intact. Throws if the step is missing, ambiguous, or has no `run:`.
 */
export function stepRunBody(text, stepName) {
  return runBodyOf(stepNamed(text, stepName));
}

/**
 * The workflow's top-level trigger names. Handles both the flow-sequence form
 * (`on: [push, pull_request]`) and the block-mapping form.
 *
 * Note this reads the literal `on:` key rather than round-tripping through a
 * YAML 1.1 parser, which would resolve the key to the boolean `true`.
 */
export function onKeys(text) {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => /^on:/.test(l));
  if (idx === -1) throw new Error('workflow has no top-level on: key');

  const flow = lines[idx].match(/^on:\s*\[(.*)\]\s*$/);
  if (flow) {
    const keys = flow[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (keys.length === 0) throw new Error('workflow on: is an empty sequence');
    return keys;
  }

  if (lines[idx].trim() !== 'on:') throw new Error(`unrecognised on: form: ${lines[idx]}`);

  const keys = [];
  let childIndent = null;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) break;
    const match = line.match(/^(\s+)([A-Za-z_][\w-]*):/);
    if (!match) continue;
    if (childIndent === null) childIndent = match[1].length;
    if (match[1].length === childIndent) keys.push(match[2]);
  }

  if (keys.length === 0) throw new Error('workflow on: block listed no triggers');
  return keys;
}

/**
 * The `env:` mapping declared on a named step, as `{ KEY: 'raw value' }`.
 *
 * Raw means raw: a `${{ ... }}` expression is returned verbatim, because there
 * is no offline engine that could resolve it. Returns `{}` when the step
 * declares no `env:`; throws when the step does not exist, so a typo in a test
 * cannot masquerade as "this step has no env".
 *
 * Comment lines inside the block are skipped. Several `env:` mappings in
 * `npm-publish.yml` carry a comment explaining why the value is passed through
 * the environment at all (abofs/stonyx-workflows#32); without this skip the
 * helper threw on exactly the YAML the fix introduced, and the natural repair
 * would have been to delete the comment documenting the sink.
 */
export function stepEnv(text, stepName) {
  return envOf(stepNamed(text, stepName));
}

/** `stepEnv`, taken from the step object rather than resolved by name. */
export function envOf(step) {
  const stepName = step.name;
  const lines = step.body.split('\n');
  const envIdx = lines.findIndex((l) => /^\s*env:\s*$/.test(l));
  if (envIdx === -1) return {};

  const envIndent = indentOf(lines[envIdx]);
  const env = {};
  for (let i = envIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) <= envIndent) break;
    if (lines[i].trim().startsWith('#')) continue;
    const match = lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!match) throw new Error(`unrecognised env: entry in step ${JSON.stringify(stepName)}: ${lines[i]}`);
    env[match[1]] = match[2].trim();
  }
  return env;
}

/**
 * The body of a named step's `with: script:` block (the `actions/github-script`
 * shape), with the block scalar indentation left intact. Throws if the step is
 * missing, ambiguous, or carries no script.
 */
export function stepScriptBody(text, stepName) {
  return scriptBodyOf(stepNamed(text, stepName));
}

/**
 * Every `${{ ... }}` expression in `text`, as `{ expression, start }`.
 *
 * Brace-balanced and single-quote aware, because `${{ }}` holds the GitHub
 * Actions EXPRESSION grammar rather than anything YAML-shaped. The sweep used
 * `/\$\{\{[^}]*\}\}/`, which stops at the first `}` and so cannot see
 * `${{ format('{0}', inputs.package-name) }}` at all -- `format()` is the
 * most-used GHA function and its placeholders are `{0}`, `{1}`
 * (abofs/stonyx-workflows#37, bypass 3 / M3). A lazy `[\s\S]*?\}\}` would
 * fix that one spelling and still lose `${{ format('{0}}', x) }}`.
 *
 * Single-quoted GHA string literals are skipped whole (with `''` as the escape)
 * so a brace inside a literal cannot unbalance the scan.
 *
 * An opener this cannot resolve is DROPPED rather than thrown on, and that is
 * deliberate: `expressionOpenerCount` counts openers off the raw text with code
 * that shares nothing with this scanner, and the sweep asserts the two agree.
 * A shape nobody anticipated therefore reds on the COUNT even when it defeats
 * the matcher -- the same shape-blind population pin PR #33's correction C4
 * gave the `node -e` sweep, generalised.
 */
export function expressionsIn(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (!text.startsWith('${{', i)) continue;
    const end = expressionEnd(text, i);
    if (end === -1) continue;
    found.push({ expression: text.slice(i, end), start: i });
    i = end - 1;
  }
  return found;
}

function expressionEnd(text, start) {
  let depth = 0;
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\n') return -1; // no `${{ }}` in these workflows spans a line
    if (c === "'") {
      j += 1;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === "'") {
          if (text[j + 1] !== "'") break;
          j += 2;
          continue;
        }
        j += 1;
      }
      if (j >= text.length || text[j] !== "'") return -1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

/**
 * How many `${{` openers `text` contains, counted straight off the raw text.
 *
 * The AUTHORITATIVE population for every `${{ }}` sweep. It shares no code with
 * `expressionsIn` on purpose: deriving the expected count from the matcher is
 * what makes a matcher that under-counts agree with its own omission.
 */
export function expressionOpenerCount(text) {
  return (text.match(/\$\{\{/g) ?? []).length;
}

/**
 * Every expression in `body`, tagged with the exact source line carrying it.
 *
 * The line is what the allowlist pins against, so an exemption cannot follow
 * its expression to a different position in the same step
 * (abofs/stonyx-workflows#37, bypass 4 and NEW-5).
 */
export function expressionsByLine(body) {
  const out = [];
  body.split('\n').forEach((raw, i) => {
    for (const { expression } of expressionsIn(raw)) {
      out.push({ line: raw.trim(), lineNumber: i + 1, expression });
    }
  });
  return out;
}
