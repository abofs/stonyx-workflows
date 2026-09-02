// The `${{ }}` DIAGNOSTIC sweep. NOT the repo-wide guarantee -- that lives in
// `test/helpers/raw-expression-scan.js` and owes nothing to any YAML reader.
//
// WHAT MOVED, AND WHY IT MATTERS WHEN READING THIS FILE.
//
// This sweep is founded on `workflow-yaml.js`: it asks the reader for the steps
// of a file and for each step's `run:`/`script:` body, and reports the
// expressions it finds inside them. Three review rounds on
// abofs/stonyx-workflows#37 found nine ways to make that reader disagree with
// the file -- an unnamed step, a `run:` key nested in an earlier block scalar,
// a quoted `"run":` key, four multi-line flow/plain scalar shapes, a
// single-line flow mapping under `with:`, a `.yaml` file extension, an explicit
// `? run` key, an escaped key, a next-line alias -- each one found after the
// previous fix shipped, each one leaving the suite green. Layered population
// pins were the answer three times and a tenth shape was found each time.
//
// So the guarantee moved off this file entirely. Every `${{ }}` occurrence in
// every file under `.github/workflows/`, found by a raw byte scan with no YAML
// understanding, must now be pinned to its exact source line in
// `test/helpers/expression-allowlist.js`. That closes the whole family by
// construction: none of the shapes above can hide three bytes from a byte scan.
//
// WHAT THIS FILE IS FOR NOW. Naming things. A raw scan can say "cascade.yml
// line 33 carries `${{ inputs.package-name }}` and nothing approves it"; it
// cannot say "in step `Dispatch to downstream dependents`, in the
// `actions/github-script` body that holds the org-level CASCADE_PAT". That
// second sentence is what makes a red actionable, and it needs a reader.
//
// THE RELATIONSHIP, STATED SO NOBODY HAS TO INFER IT: if this file is wrong,
// a message gets less helpful. NOTHING GOES UNSWEPT. Every check below may be
// read as a diagnostic; none of them is the last line of defence, and none of
// them should be argued about as though it were.
//
// The one pin here that is NOT purely diagnostic is the `run:`/`script:`
// key-line count in `stepPopulationProblems`. It does not guard the `${{ }}`
// guarantee -- the raw scan does that -- it guards the EXECUTED `run:`-body
// tests from vacuity: a body the reader never returns is a body those tests
// silently stop executing. It is kept for that, and labelled as that.
//
// Everything here is a function of `(file, text)` rather than a loop welded to
// the files on disk, so `test/sweep-bypass-test.js` can run it against
// deliberately broken workflow text. A check whose value is that it can go red
// has to be shown going red.

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

// `run:`/`script:` key lines in the raw text that are NOT step bodies.
//
// `scalarKeyLineCount` is deliberately over-broad -- it counts a `run:` line
// wherever one appears -- so it also counts a `defaults:` mapping:
//
//     defaults:
//       run:
//         shell: bash
//
// which is a job-level default, not a body. That shape is not hypothetical, it
// is the exact remediation `test/injection-test.js` recommends for the
// `bash -e` vs `bash -eo pipefail` gap, and a contributor who took the suite's
// own advice met a red whose two suggested remedies both said "extend the
// reader" and neither applied (#37, Phase 3 N7). With no escape hatch, the
// cheapest way out was to narrow the pin -- teaching a guard to look away,
// arriving by the front door.
//
// So there is a third remedy, and it is a recorded decision rather than a
// silent narrowing: declare the line here with a reason. Each declaration is
// re-derived from the file every run, so one that matches nothing reds as dead
// exactly like an allowlist entry does. Empty today; the calibration in
// `test/sweep-bypass-test.js` exercises it in both directions.
export const NON_BODY_KEY_LINES = {};

/**
 * Problems with the `run:`/`script:` BODY POPULATION the diagnostics below
 * quantify over.
 *
 * NOT the `${{ }}` guarantee. That is `rawSweepProblems`, which counts nothing
 * off this reader. This pin has one job: keep the EXECUTED `run:`-body tests
 * honest. Those tests extract a real step body and run it under bash, so a body
 * the reader never returns is a test that silently stops executing the thing it
 * names -- and every per-step check here is universally quantified, so it
 * passes trivially over a body that is not there.
 *
 * The count comes off the raw text and the reader has to match it. Over-broad
 * on purpose: it counts a `run:` line inside a block scalar too, so a workflow
 * embedding a YAML snippet reds rather than the pin quietly learning to skip
 * one. `NON_BODY_KEY_LINES` above is where a line that is genuinely not a body
 * gets recorded.
 *
 * The step-item half of this pin is GONE. Phase 3 measured it as effectively
 * dead: replacing `stepListItemCount` with a call to the very extractor it
 * audited left 206/0 green, deleting it outright left 206/0 green, and its
 * independence was false by construction -- the literal `/^\s*steps:\s*$/` sat
 * in both the pin and the reader, so a shape defeating one defeated the other
 * identically. Under the raw scan it is also redundant: a step the reader
 * cannot see can no longer hide an expression, because the guarantee never asks
 * the reader what the steps are. An unfalsifiable guard is the defect #37 exists
 * to close, so it was deleted rather than commented.
 */
export function stepPopulationProblems(file, text, nonBody = NON_BODY_KEY_LINES) {
  const problems = [];
  const steps = parseSteps(text);
  const lines = text.split('\n');

  for (const [key, read] of [['run', runBodyOf], ['script', scriptBodyOf]]) {
    let declared = 0;

    for (const entry of (nonBody[file] ?? []).filter((e) => e.key === key)) {
      const actual = lines.filter((l) => l.trim() === entry.line).length;
      if (actual !== entry.count) {
        problems.push(
          `${file} declares ${entry.count} non-body \`${key}:\` key line(s) reading ${JSON.stringify(entry.line)} `
          + `but the raw text holds ${actual}. A declaration that matches nothing is a standing exemption nobody `
          + `re-derives -- delete or re-pin it. Recorded reason was: ${entry.why}`,
        );
        continue;
      }
      declared += actual;
    }

    const keyLines = scalarKeyLineCount(text, key) - declared;
    // Counts successful reads only, on purpose: an unreadable body is a
    // population gap here AND is reported by name in the sweeps below.
    const bodies = steps.filter((step) => {
      try { read(step); return true; } catch { return false; }
    }).length;

    if (keyLines !== bodies) {
      problems.push(
        `${file} holds ${keyLines} \`${key}:\` key line(s) in its raw text but the sweep read ${bodies} `
        + `${key}: body(ies). A ${key}: body outside the sweep is a body the executed tests are not really `
        + `running -- extend the reader, move the snippet that is not really a key, or if the line is not a step `
        + `body at all (a \`defaults:\` mapping is the usual case) declare it in NON_BODY_KEY_LINES with a reason. `
        + 'Do not delete this case.',
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
