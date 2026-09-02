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
  return steps.map(({ name, lines: body }) => ({ name, body: body.join('\n') }));
}

/**
 * The body of a named step's `run:` block, with the block scalar indentation
 * left intact. Throws if the step is missing or has no `run:`.
 */
export function stepRunBody(text, stepName) {
  const step = parseSteps(text).find((s) => s.name === stepName);
  if (!step) throw new Error(`no step named ${JSON.stringify(stepName)}`);

  const lines = step.body.split('\n');
  const runIdx = lines.findIndex((l) => /^\s*run:(\s|$)/.test(l));
  if (runIdx === -1) throw new Error(`step ${JSON.stringify(stepName)} has no run: key`);

  const inline = lines[runIdx].match(/^\s*run: (?!\|)(.+)$/);
  if (inline) return inline[1];

  const runIndent = indentOf(lines[runIdx]);
  const out = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { out.push(lines[i]); continue; }
    if (indentOf(lines[i]) <= runIndent) break;
    out.push(lines[i]);
  }
  if (out.join('').trim() === '') throw new Error(`step ${JSON.stringify(stepName)} has an empty run: block`);
  return out.join('\n');
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
  const step = parseSteps(text).find((s) => s.name === stepName);
  if (!step) throw new Error(`no step named ${JSON.stringify(stepName)}`);

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
 * missing or carries no script.
 */
export function stepScriptBody(text, stepName) {
  const step = parseSteps(text).find((s) => s.name === stepName);
  if (!step) throw new Error(`no step named ${JSON.stringify(stepName)}`);

  const lines = step.body.split('\n');
  const scriptIdx = lines.findIndex((l) => /^\s*script:\s*\|?\s*$/.test(l));
  if (scriptIdx === -1) throw new Error(`step ${JSON.stringify(stepName)} has no script: block`);

  const scriptIndent = indentOf(lines[scriptIdx]);
  const out = [];
  for (let i = scriptIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { out.push(lines[i]); continue; }
    if (indentOf(lines[i]) <= scriptIndent) break;
    out.push(lines[i]);
  }
  if (out.join('').trim() === '') throw new Error(`step ${JSON.stringify(stepName)} has an empty script: block`);
  return out.join('\n');
}
