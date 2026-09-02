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
 * The job a `steps:` list belongs to: the nearest enclosing mapping key.
 *
 * Used only to scope step-name uniqueness. Two different jobs may each have a
 * step called `Checkout repository` -- that is idiomatic GitHub Actions, and
 * keying uniqueness on the name alone would red the suite on a workflow nobody
 * wrote wrong (abofs/stonyx-workflows#37, Phase 1 W2).
 */
function jobFor(lines, stepsIdx) {
  const stepsIndent = indentOf(lines[stepsIdx]);
  for (let i = stepsIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line) >= stepsIndent) continue;
    return line.match(/^\s*([A-Za-z_][\w.-]*):\s*$/)?.[1] ?? null;
  }
  return null;
}

/**
 * Split every `steps:` list in a workflow into `{ job, name, index, body }`
 * entries. `body` is the raw text of every line belonging to that step, with
 * the list item's own first key re-indented to the step's key depth so that
 * `- run: echo hi` and `- name: X` + `run: echo hi` read identically.
 *
 * EVERY list item is a step. `name:` is OPTIONAL on a GitHub Actions step, and
 * omitting it on a `uses:` step is the commonest step form there is -- but this
 * reader used to recognise a step only at `^(\s*)- name: (.*)$` and append every
 * other list item's lines to the PREVIOUS step's body, where `stepScalar` took
 * the first `run:`/`script:` and never read the smuggled one. An unnamed step
 * carrying a `workflow_call` input into shell source, or into the
 * `actions/github-script` body that holds the org-level `CASCADE_PAT`, was
 * therefore invisible to both sweeps with the suite green at 185 pass / 0 fail
 * (abofs/stonyx-workflows#37, bypass 6a / M6a).
 *
 * A `name:` this cannot find is `null`, never a guess. Sweeps are positional so
 * a null name costs them nothing; only the name-taking helpers care, and they
 * already refuse to answer ambiguously.
 *
 * List items in shapes this reader does not understand -- flow mappings
 * (`- {name: X, run: '...'}`), aliases (`- *base`) and merge keys
 * (`- <<: *base`) -- THROW rather than being skipped. Skipping one would put a
 * real step outside every sweep, which is the whole defect above.
 */
export function parseSteps(text) {
  const lines = text.split('\n');
  const stepsIdxs = lines.map((l, i) => (/^\s*steps:\s*$/.test(l) ? i : -1)).filter((i) => i !== -1);
  if (stepsIdxs.length === 0) throw new Error('workflow has no steps: block');

  const steps = [];

  for (const stepsIdx of stepsIdxs) {
    const stepsIndent = indentOf(lines[stepsIdx]);
    const job = jobFor(lines, stepsIdx);
    let listIndent = null;
    let current = null;

    for (let i = stepsIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() !== '' && indentOf(line) <= stepsIndent) break;

      const item = line.trim() === '' ? null : line.match(/^(\s*)-(\s+\S.*|\s*)$/);
      if (item && (listIndent === null || item[1].length === listIndent)) {
        listIndent = item[1].length;
        const content = item[2].trim();
        if (content !== '' && !/^(['"]?)[A-Za-z_][\w.-]*\1\s*:(\s|$)/.test(content)) {
          throw new Error(
            `unrecognised step list item in the steps: block at line ${i + 1}: ${JSON.stringify(line.trim())}. `
            + 'This reader understands block-mapping steps only, so a flow mapping, an alias or a merge key '
            + 'cannot be resolved -- and skipping it would put a real step outside every sweep. Extend the '
            + 'reader instead of deleting the case that failed.',
          );
        }
        current = { job, lines: content === '' ? [] : [`${' '.repeat(listIndent + 2)}${content}`] };
        steps.push(current);
        continue;
      }
      if (current) current.lines.push(line);
    }
  }

  if (steps.length === 0) throw new Error('workflow steps: block contained no steps');

  return steps.map(({ job, lines: body }, index) => {
    const text = body.join('\n');
    const keyIndent = Math.min(...body.filter((l) => l.trim() !== '').map(indentOf));
    const name = body
      .find((l) => indentOf(l) === keyIndent && /^\s*name:(\s|$)/.test(l))
      ?.replace(/^\s*name:\s*/, '')
      .trim() ?? null;
    return { job, name, index, body: text };
  });
}

/**
 * How many `- ` list items the `steps:` blocks of `text` contain, counted
 * straight off the raw text.
 *
 * The AUTHORITATIVE population for `parseSteps`, and it deliberately shares no
 * code with it. This is the pin PR #33's correction C4 gave the `node -e` sweep
 * -- `candidateNodeEvalInvocations` counts candidates off the raw file so an
 * extractor that under-counts cannot agree with its own omission -- applied at
 * the level that actually failed: STEPS WITHIN A FILE. The `${{ }}` accounting
 * pin counts openers off the body the extractor returned, so it is silent when
 * the extractor never returns the body at all (abofs/stonyx-workflows#37,
 * bypass 6a).
 */
export function stepListItemCount(text) {
  const lines = text.split('\n');
  let count = 0;
  let stepsIndent = null;
  let listIndent = null;

  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    if (stepsIndent !== null && indent <= stepsIndent) { stepsIndent = null; listIndent = null; }
    if (/^\s*steps:\s*$/.test(line)) { stepsIndent = indent; listIndent = null; continue; }
    if (stepsIndent === null || !/^\s*-(\s|$)/.test(line)) continue;
    if (listIndent === null) listIndent = indent;
    if (indent === listIndent) count += 1;
  }

  return count;
}

/**
 * How many lines of `text` open a scalar `key:` mapping entry, counted straight
 * off the raw text -- the same authoritative-population trick one level down.
 *
 * Deliberately admits the `- run:` list-item form and a quoted key, because
 * both are shapes the extractor missed. Over-broad on purpose: it counts a
 * `run:` line inside a block scalar too, so a workflow that embeds a YAML
 * snippet reds here rather than silently teaching the pin to look away.
 */
export function scalarKeyLineCount(text, key) {
  return (text.match(new RegExp(`^[ \\t]*(?:-[ \\t]+)?['"]?${key}['"]?[ \\t]*:`, 'gm')) ?? []).length;
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
 * Step names that appear more than once WITHIN ONE JOB, with their count.
 *
 * Scoped per job on purpose. GitHub Actions permits two jobs to each have a
 * step called `Checkout repository` -- the single most idiomatic step name
 * there is -- and keying uniqueness on the bare name would red the suite on a
 * workflow nobody wrote wrong the day `npm-publish.yml` grows a second job
 * (abofs/stonyx-workflows#37, Phase 1 W2).
 *
 * Unnamed steps are not counted: `name:` is optional, several steps may omit
 * it, and an absent name hides nothing from a name-keyed check -- it is the
 * step POPULATION pin that covers those (`stepListItemCount`).
 */
export function duplicateStepNames(text) {
  const seen = new Map();
  for (const step of parseSteps(text)) {
    if (step.name === null) continue;
    const key = JSON.stringify([step.job, step.name]);
    seen.set(key, { job: step.job, name: step.name, count: (seen.get(key)?.count ?? 0) + 1 });
  }
  return [...seen.values()].filter(({ count }) => count > 1);
}

// A YAML block-scalar header: the style indicator, then an optional chomping
// indicator and an optional explicit indentation indicator, in either order.
//
// `stepRunBody`'s inline branch used the negative lookahead `(?!\|)`, which
// enumerated ONE of the two style indicators. `run: >` therefore matched the
// inline branch and the helper returned the literal string `">"` as the entire
// body -- every folded line, including any `${{ }}` in it, fell outside the
// sweep with the suite green (abofs/stonyx-workflows#37, bypass 2 / M2).
// The indentation indicator is a single digit `1`-`9`; `|0` and `|-23` are not
// valid YAML, and this regex is the one thing standing between the sweep and a
// repeat of bypass 2, so it says exactly what it means.
const BLOCK_SCALAR_HEADER = /^[|>](?:[-+][1-9]?|[1-9][-+]?)?$/;

/**
 * The indices of the lines in `lines` that are STRUCTURAL -- YAML the reader is
 * looking at, rather than text inside a block scalar's payload.
 *
 * `stepScalar` used to take the first line matching `^\s*<key>:(\s|$)` at ANY
 * indentation, so a `run:` line sitting inside an EARLIER block scalar in the
 * same step was returned as that step's run body and the real one was never
 * read. Measured green at 185 pass / 0 fail on the real `cascade.yml` with a
 * step-level `env:` value holding a YAML snippet -- a workflows repo writing a
 * consumer snippet into `$GITHUB_STEP_SUMMARY` is the natural instance, and
 * this repo's own README ships `run: pnpm test` snippets
 * (abofs/stonyx-workflows#37, bypass 6b / M6b).
 *
 * Scoping the search this way closes the `script:` twin of the same shape (an
 * `env:` snippet ahead of a `with: script:` block) and the heredoc case Phase 1
 * raised as N10, which an indentation anchor on `run:` alone would leave open.
 */
function structuralLineIdxs(lines) {
  const idxs = [];
  let scalarIndent = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    if (scalarIndent !== null) {
      if (indent > scalarIndent) continue;
      scalarIndent = null;
    }
    idxs.push(i);
    const value = line.match(/^\s*(?:['"]?[A-Za-z_][\w.-]*['"]?)\s*:\s*(.*?)\s*$/)?.[1];
    if (value !== undefined && BLOCK_SCALAR_HEADER.test(value)) scalarIndent = indent;
  }

  return idxs;
}

/**
 * A step that carries no `key:` at all, as distinct from one whose `key:` the
 * extractor could not read.
 *
 * A typed error because that distinction is the entire job of
 * `interpolation-sweep.js`'s `readBody`, and it used to make it by
 * substring-matching this module's prose (`err.message.includes(...)`). A
 * reworded message would have turned every unreadable body back into a silent
 * skip -- the bare `catch { continue; }` that `readBody` exists to forbid,
 * restored by a typo (abofs/stonyx-workflows#37, bypass 6c).
 */
export class MissingStepKeyError extends Error {
  constructor(step, key) {
    super(`step ${JSON.stringify(step.name)} has no ${key}: key`);
    this.name = 'MissingStepKeyError';
    this.code = MissingStepKeyError.CODE;
    this.key = key;
  }
}
MissingStepKeyError.CODE = 'MISSING_STEP_KEY';

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
 *
 * The key may be quoted: `"run": |` is valid YAML that GitHub Actions runs, and
 * an unquoted-only probe made `stepScalar` report "this step has no run:" for a
 * step that had one -- read as "nothing to sweep here" and green at 185/0
 * (abofs/stonyx-workflows#37, bypass 6c).
 */
const KEY_PROBE = (key) => new RegExp(`^\\s*(['"]?)${key}\\1\\s*:(\\s|$)`);

function stepScalar(step, key) {
  const lines = step.body.split('\n');
  const idx = structuralLineIdxs(lines).find((i) => KEY_PROBE(key).test(lines[i])) ?? -1;
  if (idx === -1) throw new MissingStepKeyError(step, key);

  const value = lines[idx].replace(new RegExp(`^\\s*(['"]?)${key}\\1\\s*:\\s*`), '').replace(/\s+$/, '');
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
  // Structural, for the same reason `stepScalar` is: an `env:` line inside an
  // earlier block scalar is payload text, not this step's env mapping.
  const envIdx = structuralLineIdxs(lines).find((i) => /^\s*env:\s*$/.test(lines[i])) ?? -1;
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
