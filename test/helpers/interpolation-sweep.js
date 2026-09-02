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
// The unifying principle, stated once: every one of the bypasses was the
// extractor disagreeing with the file and nothing noticing. PR #33's correction
// C4 solved that for `node -e` by pinning the population from OUTSIDE the
// extractor, off the raw file text. This generalises it, and it has to be
// applied at EVERY level the extractor can disagree at, because a pin is blind
// to the level above the one it counts:
//
//   1. steps within a file    -- `stepPopulationProblems`, raw `- ` list items
//   2. run/script bodies      -- `stepPopulationProblems`, raw `run:`/`script:`
//                                key lines
//   3. expressions in a body  -- `runSweepProblems`/`scriptSweepProblems`, raw
//                                `${{` openers
//
// Level 3 alone was the first attempt at this repair, and it was not enough:
// it counts openers off the body THE EXTRACTOR RETURNED, so an extractor that
// never returns a body agrees with its own omission and the pin stays silent.
// An unnamed step (`- run: echo "${{ inputs.package-name }}"`) was measured
// green at 185 pass / 0 fail against the real `cascade.yml` on exactly that
// gap, while the identical step carrying `node -e` RED -- because that sweep's
// population is counted off the raw file. Same file, same step, opposite
// results, one level of difference (abofs/stonyx-workflows#37, bypass 6).

import {
  MissingStepKeyError,
  duplicateStepNames,
  expressionOpenerCount,
  expressionsByLine,
  expressionsIn,
  parseSteps,
  runBodyOf,
  scalarKeyLineCount,
  scriptBodyOf,
  stepListItemCount,
} from './workflow-yaml.js';

// Named exceptions only. Each entry pins a step, the EXACT SOURCE LINE it
// exempts, the expression, and an occurrence count.
//
// The count is pinned so that "this expression is tolerated in this file" does
// not silently tolerate a SECOND copy of it on the same line, or the same
// expression appearing in a step that has nothing to do with the recorded
// reason.
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

const label = (file, step) => (
  `${file} step ${step.name === null ? '(unnamed)' : JSON.stringify(step.name)} (position ${step.index})`
);

/**
 * Read a step's `run:`/`script:` body, distinguishing "this step has none" from
 * "the extractor could not read the one it has".
 *
 * The old sweep wrapped the read in a bare `catch { continue; }`, which treated
 * both alike: an extractor throw -- exactly what a `run: !!str ...` or an
 * unclosed block now raises -- silently removed that step from the sweep. A
 * guard that discards its own failure signal is the defect this suite exists
 * to catch, so only the missing-key case is a skip.
 *
 * The discrimination is on a TYPED error, not on `err.message.includes(...)`.
 * Deciding skip-vs-report by substring-matching another module's prose is the
 * same defect one layer in: rewording `stepScalar`'s message would have turned
 * every unreadable body back into a silent skip, and the kill mutation that
 * guards this branch deletes the branch rather than changing the string it
 * depended on, so nothing would have caught it (abofs/stonyx-workflows#37).
 */
function readBody(step, key, read, problems, file) {
  try {
    return read(step);
  } catch (err) {
    if (err.code === MissingStepKeyError.CODE && err.key === key) return null;
    problems.push(`${label(file, step)}: the extractor could not read its ${key}: body -- ${err.message}`);
    return null;
  }
}

/**
 * Problems with the POPULATION the sweep is about to inspect, counted off the
 * raw file text by code that shares nothing with the extractor.
 *
 * Every assertion the sweeps make is universally quantified over what the
 * extractor returned, so all of them pass trivially against a population of
 * zero. These two pins are what make "the sweep is green" mean "the sweep
 * looked at everything that is there" -- see the module header for why the
 * per-body `${{` pin cannot do that job.
 *
 * The step-item half is a REGRESSION backstop and is unreachable by any single
 * committed mutation today, deliberately: `parseSteps` now throws on a list
 * item it cannot resolve rather than skipping one, so there is no text where it
 * silently under-counts. It becomes reachable the moment that changes, which is
 * the thing being guarded. Measured: narrow `parseSteps` back to `- name:` AND
 * append an unnamed step to `cascade.yml`, and this is the branch that fires
 * (`every step and every run:/script: body in cascade.yml is inside the sweep`
 * reds). The key-line half reds today, on the 6b shape.
 */
export function stepPopulationProblems(file, text) {
  const problems = [];
  const steps = parseSteps(text);

  const items = stepListItemCount(text);
  if (items !== steps.length) {
    problems.push(
      `${file} has ${items} step list item(s) in its steps: block(s) but the reader resolved ${steps.length} `
      + 'step(s). A step the reader cannot see is not swept at all, so every per-step check below passes over '
      + 'it silently -- extend parseSteps rather than deleting this case.',
    );
  }

  for (const [key, read] of [['run', runBodyOf], ['script', scriptBodyOf]]) {
    const keyLines = scalarKeyLineCount(text, key);
    // Counts successful reads only, on purpose: an unreadable body is a
    // population gap here AND is reported by name in the sweeps below.
    const bodies = steps.filter((step) => {
      try { read(step); return true; } catch { return false; }
    }).length;

    if (keyLines !== bodies) {
      problems.push(
        `${file} holds ${keyLines} \`${key}:\` key line(s) in its raw text but the sweep read ${bodies} `
        + `${key}: body(ies). A ${key}: body outside the sweep is program text nobody is checking -- extend the `
        + 'reader, or move the snippet that is not really a key, rather than deleting this case.',
      );
    }
  }

  return problems;
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

/**
 * Problems with `${{ }}` expressions in the `github-script` bodies of one
 * workflow.
 *
 * No `allowlist` parameter, unlike its two siblings: JS source exempts nothing,
 * by design. This step class holds the org-level `CASCADE_PAT`, so there is no
 * expression here worth an exception.
 */
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
 *
 * Scoped per job, because two jobs sharing a step name is legal and idiomatic
 * and the reader -- not GitHub Actions -- is what a flat check would have been
 * constraining.
 */
export function duplicateNameProblems(file, text) {
  return duplicateStepNames(text).map(({ job, name, count }) => (
    `${file} job ${JSON.stringify(job)} has ${count} steps named ${JSON.stringify(name)}. A step name is not `
    + 'unique in GitHub Actions, so a duplicate is how a step hides from a name-keyed check. The ~18 name-taking '
    + 'reads in this suite need it to be unique within its job; rename the step.'
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
  const allSteps = parseSteps(text);

  for (const entry of allowlist[file] ?? []) {
    const { step: stepName, line, expression, occurrences, why } = entry;
    const steps = allSteps.filter((s) => s.name === stepName);

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
    ...stepPopulationProblems(file, text),
    ...duplicateNameProblems(file, text),
    ...runSweepProblems(file, text, allowlist),
    ...scriptSweepProblems(file, text),
    ...deadAllowlistProblems(file, text, allowlist),
  ];
}
