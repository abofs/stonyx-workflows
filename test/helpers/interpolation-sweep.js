// The repo-wide `${{ }}` sweep, extracted from `test/injection-test.js`.
//
// It lives in its own module for one reason: the sweep is a check whose entire
// value is that it can go red, and PR #33 shipped it in a shape where five
// separate mutations left it green at 161 pass / 0 fail
// (abofs/stonyx-workflows#37). Proving it can fail means running it against
// DELIBERATELY BROKEN workflow text, which is only possible if the sweep is a
// function of `(file, text)` rather than a loop welded to the files on disk.
//
// So every function here returns an array of problem strings.
// `test/injection-test.js` asserts that array is empty for the real workflows;
// `test/sweep-bypass-test.js` asserts it is non-empty for each of the five
// mutations that used to pass. The same code produces both.
//
// The unifying principle, stated once: every one of the five bypasses was the
// extractor disagreeing with the file and nothing noticing. PR #33's correction
// C4 solved that for `node -e` by pinning the population from OUTSIDE the
// extractor. This generalises it -- for every run/script body, the count of
// `${{` openers in the raw text must equal the number of expressions the
// matcher resolved -- so an evasion shape nobody anticipated reds on the COUNT
// even when it defeats the matcher.

import {
  duplicateStepNames,
  expressionOpenerCount,
  expressionsByLine,
  expressionsIn,
  parseSteps,
  runBodyOf,
  scriptBodyOf,
} from './workflow-yaml.js';

// Named exceptions only. Each entry pins a step, the EXACT SOURCE LINE it
// exempts, the expression, and an occurrence count.
//
// The line is the part that is new, and it is what closes bypass 4 and NEW-5.
// Pinning `{step, expression, occurrences}` alone tolerated the expression
// moving anywhere inside the same step at the same count: into `eval "..."`
// (NEW-5), or into a `#` comment left behind by the very fix that closed the
// sink (bypass 4 / M4). Both kept a dead exemption alive with the suite green.
//
// NOT fixed by stripping comment lines before counting, which was the obvious
// proposal. The runner substitutes `${{ }}` into the run script TEXTUALLY,
// before bash parses it, and a `workflow_call` input can contain a newline --
// so an expression on a `#` line is a LIVE SINK, measured: with
// `inputs.audit-level = "moderate\ntouch /tmp/canary/PWNED\n#"`, the commented
// body executes the payload under `bash -e` and exits 0. Teaching the sweep to
// ignore comment lines would have taught it to ignore a real sink class, which
// is this issue's own defect one layer deeper.
export const ALLOWLIST = {
  'npm-publish.yml': [{
    step: 'Install dependencies',
    line: "pnpm install ${{ inputs.cascade-source != '' && '--no-frozen-lockfile' || '--frozen-lockfile' }}",
    expression: "${{ inputs.cascade-source != '' && '--no-frozen-lockfile' || '--frozen-lockfile' }}",
    occurrences: 1,
    why: 'Both arms are fixed literals selected by a boolean. No consumer string can reach the shell through it.',
  }],
  'security-audit.yml': [{
    step: 'Run security audit',
    line: 'pnpm audit --audit-level ${{ inputs.audit-level }}',
    expression: '${{ inputs.audit-level }}',
    occurrences: 1,
    why: 'KNOWN OPEN SINK, tracked as abofs/stonyx-workflows#34. A workflow_call input interpolated into a shell '
      + 'run: body -- the same defect class this suite closes, in a third file outside #32 two-file scope. '
      + 'Reported and tracked, not fixed here. When #34 lands, delete this entry.',
  }],
};

const label = (file, step) => `${file} step ${JSON.stringify(step.name)} (position ${step.index})`;

/**
 * Read a step's `run:`/`script:` body, distinguishing "this step has none" from
 * "the extractor could not read the one it has".
 *
 * The old sweep wrapped the read in a bare `catch { continue; }`, which treated
 * both alike: an extractor throw -- exactly what a `run: !!str ...` or an
 * unclosed block now raises -- silently removed that step from the sweep. A
 * guard that discards its own failure signal is the defect this suite exists
 * to catch, so only the missing-key case is a skip.
 */
function readBody(step, key, read, problems, file) {
  try {
    return read(step);
  } catch (err) {
    if (err.message.includes(`has no ${key}: key`)) return null;
    problems.push(`${label(file, step)}: the extractor could not read its ${key}: body -- ${err.message}`);
    return null;
  }
}

/** Problems with `${{ }}` expressions in the `run:` bodies of one workflow. */
export function runSweepProblems(file, text, allowlist = ALLOWLIST) {
  const problems = [];
  const entries = allowlist[file] ?? [];

  for (const step of parseSteps(text)) {
    const body = readBody(step, 'run', runBodyOf, problems, file);
    if (body === null) continue;

    // The shape-blind population pin. Openers are counted off the raw body by
    // code sharing nothing with the matcher, so a shape the matcher cannot
    // parse reds here rather than vanishing from the sweep.
    const openers = expressionOpenerCount(body);
    const matched = expressionsIn(body).length;
    if (openers !== matched) {
      problems.push(
        `${label(file, step)}: its run: body holds ${openers} \`\${{\` opener(s) but the matcher resolved `
        + `${matched} expression(s). An expression is in a shape the matcher does not parse, so it is outside `
        + 'this sweep entirely -- extend the matcher rather than deleting this case.',
      );
    }

    // Tally per (source line, expression) so an exemption is pinned to the
    // exact line it was recorded against, not to the step as a whole.
    const tally = new Map();
    for (const { line, expression } of expressionsByLine(body)) {
      const key = JSON.stringify([line, expression]);
      tally.set(key, { line, expression, count: (tally.get(key)?.count ?? 0) + 1 });
    }

    for (const { line, expression, count } of tally.values()) {
      const entry = entries.find((e) => e.step === step.name && e.line === line && e.expression === expression);
      if (!entry) {
        problems.push(
          `${label(file, step)} interpolates ${expression} into shell source on the line `
          + `${JSON.stringify(line)}. No allowlist entry pins that expression to that line.`,
        );
        continue;
      }
      if (count !== entry.occurrences) {
        problems.push(
          `${label(file, step)} interpolates ${expression} ${count} time(s) on the allowlisted line; `
          + `the allowlist exempts ${entry.occurrences}.`,
        );
      }
    }
  }

  return problems;
}

/** Problems with `${{ }}` expressions in the `github-script` bodies of one workflow. */
export function scriptSweepProblems(file, text) {
  const problems = [];

  for (const step of parseSteps(text)) {
    const script = readBody(step, 'script', scriptBodyOf, problems, file);
    if (script === null) continue;

    const openers = expressionOpenerCount(script);
    if (openers > 0) {
      const found = expressionsIn(script).map((e) => e.expression);
      problems.push(
        `${label(file, step)} interpolates ${openers} expression(s) into JS source`
        + `${found.length ? `: ${found.join(', ')}` : ' (the matcher could not resolve them, which is worse)'}`,
      );
    }
  }

  return problems;
}

/**
 * Duplicate step names in one workflow.
 *
 * A name is not an identity in GitHub Actions, and both sweeps used to
 * re-resolve bodies by name. They no longer do -- but a duplicated name still
 * makes every name-keyed assertion in this suite ambiguous, and it is the shape
 * an evasion takes, so it is reported in its own right.
 */
export function duplicateNameProblems(file, text) {
  return duplicateStepNames(text).map(({ name, count }) => (
    `${file} has ${count} steps named ${JSON.stringify(name)}. A step name is not unique in GitHub Actions, `
    + 'so a duplicate is how a step hides from a name-keyed check.'
  ));
}

/**
 * Allowlist entries whose sink is gone, moved, or no longer on the pinned line.
 *
 * A deleted entry and a never-consulted entry look identical, so the exemption
 * has to be re-derived from the file every run. The pinned LINE is what makes
 * this fire when the sink is fixed but the expression survives somewhere else
 * in the same step -- a comment quoting it (bypass 4), or an `eval "..."`
 * wrapper (NEW-5).
 */
export function deadAllowlistProblems(file, text, allowlist = ALLOWLIST) {
  const problems = [];

  for (const entry of allowlist[file] ?? []) {
    const { step: stepName, line, expression, occurrences, why } = entry;
    const steps = parseSteps(text).filter((s) => s.name === stepName);

    if (steps.length === 0) {
      problems.push(
        `${file} has no step named ${JSON.stringify(stepName)}; its allowlist entry for ${expression} is dead. `
        + `Delete or correct it. Recorded reason was: ${why}`,
      );
      continue;
    }

    let matchedLines = 0;
    let count = 0;
    for (const step of steps) {
      const body = readBody(step, 'run', runBodyOf, problems, file);
      if (body === null) continue;
      for (const raw of body.split('\n')) {
        if (raw.trim() !== line) continue;
        matchedLines += 1;
        count += expressionsIn(raw).filter((e) => e.expression === expression).length;
      }
    }

    if (matchedLines === 0) {
      problems.push(
        `${file} step ${JSON.stringify(stepName)} no longer carries the exempted source line `
        + `${JSON.stringify(line)}. The allowlist entry for ${expression} is dead -- the sink it named is gone `
        + 'or has moved, so delete or re-pin the entry rather than letting it exempt something else. '
        + `Recorded reason was: ${why}`,
      );
      continue;
    }

    if (count !== occurrences) {
      problems.push(
        `${file} step ${JSON.stringify(stepName)} interpolates ${expression} ${count} time(s) on the exempted `
        + `line across ${matchedLines} matching line(s); the entry pins ${occurrences}. Recorded reason was: ${why}`,
      );
    }
  }

  return problems;
}

/** Every problem the sweep can report for one workflow file. */
export function sweepProblems(file, text, allowlist = ALLOWLIST) {
  return [
    ...duplicateNameProblems(file, text),
    ...runSweepProblems(file, text, allowlist),
    ...scriptSweepProblems(file, text),
    ...deadAllowlistProblems(file, text, allowlist),
  ];
}
