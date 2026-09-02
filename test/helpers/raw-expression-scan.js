// The repo-wide `${{ }}` guarantee, and the ONLY thing in this suite that is a
// guarantee rather than a diagnostic.
//
// The guarantee, stated once:
//
//   Every `${{ }}` occurrence in EVERY FILE under `.github/workflows/` --
//   enumerated by directory listing with NO extension filter, found by a raw
//   byte scan with no YAML understanding whatsoever -- must appear in an
//   allowlist keyed by (file, exact source line, expression) with a stated
//   reason.
//
// WHY IT IS SHAPED THIS WAY, since the shape is the whole point.
//
// Three review rounds on abofs/stonyx-workflows#37 found nine distinct ways to
// hide a `${{ }}` from the previous design, each one after the previous fix
// shipped: a duplicate step name, `run: >`, `${{ format('{0}', ...) }}`, a dead
// allowlist entry, an `eval "..."` relocation, an unnamed step, a `run:` key
// nested in an earlier block scalar, a quoted `"run":` key, multi-line flow and
// plain scalars, a single-line flow mapping under `with:`, a `.yaml` file
// extension, an explicit `? run` key, an escaped `"ru\x6e":` key, and a
// next-line alias. Every one of them is the same failure: THE READER DISAGREED
// WITH THE FILE AND THE GUARD AGREED WITH THE READER.
//
// A tenth is not worth waiting for, so the guarantee owes nothing to any
// reader. There is nothing here to disagree with a file about: the scan finds
// three bytes and reports where they were. No unnamed step, nested scalar, flow
// mapping, quoted key, escaped key, alias or file extension can hide an
// occurrence from it, because none of those things is consulted.
//
// It also inverts the failure mode. Under the old design an unanticipated shape
// failed OPEN -- silently unswept, suite green. Here it fails CLOSED: the
// occurrence is counted, no entry matches it, the suite reds. The allowlist
// becomes the review artifact it should always have been -- adding an
// expression to a workflow requires adding an entry that says why it is safe.
//
// INDEPENDENCE, MECHANICALLY. `test/raw-sweep-test.js` asserts, by reading this
// file's own source, that it imports nothing from `workflow-yaml.js` or
// `interpolation-sweep.js` and that it contains NO REGULAR EXPRESSION LITERAL
// AT ALL. That second pin is the one that matters: PR #38's previous
// "independent" population pin was independent in prose and shared the literal
// `/^\s*steps:\s*$/` with the extractor it audited, so it was blind in exactly
// the same place (#37, Phase 3 §5). A file with no regexes cannot share one.
// The only thing this module has in common with the extractor is the directory
// path it reads, which is data rather than parsing logic.
//
// This module is deliberately dull. `indexOf`, `slice`, `split` and `trim`. If
// it ever needs to become clever, that is the signal that a guarantee is
// drifting back onto a reader.

import { readdirSync, readFileSync } from 'node:fs';

const WORKFLOWS_DIR = new URL('../../.github/workflows/', import.meta.url);

const OPENER = '${{';
const CLOSER = '}}';

/**
 * Every file in `dir`, sorted. NO EXTENSION FILTER, on purpose.
 *
 * GitHub Actions accepts both `.yml` and `.yaml`, and both of this suite's
 * previous enumerations filtered to `.yml`. A complete, valid
 * `.github/workflows/evil.yaml` carrying `run: echo "${{ inputs.package-name }}"`
 * was measured at 206 pass / 0 fail -- an entire workflow file, with a
 * `workflow_call` input reaching a shell body, invisible to every check in the
 * repo (#37, Phase 3 §4).
 *
 * Filtering by extension is also what made the pin that existed for this
 * unable to fire: it deep-equalled the ALREADY-FILTERED list, so the thing it
 * was guarding against was removed before the assertion saw it. Anything in
 * this directory is swept; a file that is not a workflow reds and gets a
 * recorded decision rather than a silent exemption.
 */
export function workflowFileNames(dir = WORKFLOWS_DIR) {
  return readdirSync(dir).sort();
}

/** The raw bytes of one file in `.github/workflows/`, read as UTF-8. */
export function readWorkflowFile(name, dir = WORKFLOWS_DIR) {
  return readFileSync(new URL(name, dir), 'utf8');
}

/**
 * Every `${{` occurrence in `text`, as
 * `{ lineNumber, line, expression }`.
 *
 * `line` is the source line with leading and trailing whitespace removed --
 * re-indenting a block is not a change to what the line does, but every other
 * byte of it is part of the key.
 *
 * `expression` is `null` when the opener does not close on its own line. That
 * is not a skip: a null expression can never match an allowlist entry, so the
 * occurrence is reported. An expression spanning a line break is a shape this
 * scanner does not model, and the fail-closed answer to a shape it does not
 * model is to red rather than to guess.
 *
 * Exactly one record per opener, always. The count of records IS the count of
 * `${{` occurrences in the file; nothing can drop out between the two.
 */
export function rawExpressions(text) {
  const found = [];

  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    let at = raw.indexOf(OPENER);

    while (at !== -1) {
      const close = raw.indexOf(CLOSER, at + OPENER.length);
      found.push({
        lineNumber: i + 1,
        line,
        expression: close === -1 ? null : raw.slice(at, close + CLOSER.length),
      });
      at = raw.indexOf(OPENER, close === -1 ? at + OPENER.length : close + CLOSER.length);
    }
  });

  return found;
}

/**
 * The dotted references inside an expression, e.g. `inputs.pnpm-version`,
 * `secrets.CASCADE_PAT`, `steps.package-version.outputs.version`.
 *
 * Used only to hold the allowlist to account: an entry's `why` has to name at
 * least one of its own expression's references, so "safe" cannot be
 * bulk-pasted across forty-two entries. Written without a regex like everything
 * else here.
 */
export function referencesIn(expression) {
  const WORD = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.';
  const refs = [];
  let token = '';

  for (const ch of `${expression} `) {
    if (WORD.includes(ch)) { token += ch; continue; }
    if (token.includes('.') && !token.startsWith('.') && !token.endsWith('.')) refs.push(token);
    token = '';
  }

  return refs;
}

/**
 * Problems with an allowlist entry's own shape, independent of any file.
 *
 * A malformed entry is a silent exemption: an entry with no `line` would exempt
 * its expression everywhere, and an entry whose `why` says nothing is an
 * approval nobody made.
 */
export function entryShapeProblems(file, entry) {
  const problems = [];
  const where = `${file} allowlist entry for ${entry.expression ?? '(no expression)'}`;

  if (typeof entry.line !== 'string' || entry.line === '') {
    problems.push(`${where} has no line:. An entry without a line exempts its expression anywhere in the file.`);
  }
  if (typeof entry.expression !== 'string' || !entry.expression.startsWith(OPENER)) {
    problems.push(`${where} has no expression: beginning with the opener it exempts.`);
  }
  if (!Number.isInteger(entry.occurrences) || entry.occurrences < 1) {
    problems.push(`${where} must pin a positive integer occurrences:, so a second copy on the line is not free.`);
  }
  if (typeof entry.line === 'string' && typeof entry.expression === 'string' && !entry.line.includes(entry.expression)) {
    problems.push(`${where} pins a line that does not contain the expression it exempts.`);
  }
  if (typeof entry.why !== 'string' || entry.why.length < 60) {
    problems.push(`${where} needs a why: that states what the expression is and why it is safe here.`);
  }
  if (typeof entry.why === 'string' && typeof entry.expression === 'string') {
    const refs = referencesIn(entry.expression);
    if (refs.length > 0 && !refs.some((ref) => entry.why.includes(ref))) {
      problems.push(
        `${where} has a why: that names none of the expression's own references (${refs.join(', ')}). `
        + 'A reason that could be pasted onto any entry is not a reason -- say what THIS expression is.',
      );
    }
  }

  return problems;
}

/**
 * Every problem the guarantee can report for one file.
 *
 * Three ways to red, and they are the whole contract:
 *
 *   1. an occurrence with no matching entry           -- an unapproved expression
 *   2. an occurrence count the entry does not pin     -- a second copy on the line
 *   3. an entry matching no occurrence                -- a dead exemption, which is
 *      what kept `security-audit.yml`'s sink allowlisted after the fix relocated
 *      it into a comment and into an `eval "..."` wrapper (#37, bypass 4, NEW-5)
 *
 * An opener that does not close on its own line reds under (1) with its own
 * message, because `expression` is `null` and no entry can pin `null`.
 */
export function rawSweepProblems(file, text, allowlist) {
  const entries = allowlist[file] ?? [];
  const problems = [];
  const tally = new Map();

  for (const entry of entries) problems.push(...entryShapeProblems(file, entry));

  for (const { lineNumber, line, expression } of rawExpressions(text)) {
    if (expression === null) {
      problems.push(
        `${file}:${lineNumber} opens a ${OPENER} that does not close on the same line, on ${JSON.stringify(line)}. `
        + 'This scanner does not model an expression spanning a line break, and the fail-closed answer to a shape '
        + 'it does not model is to report it -- extend the scanner, or put the expression on one line.',
      );
      continue;
    }
    const key = JSON.stringify([line, expression]);
    const seen = tally.get(key) ?? { line, expression, count: 0, at: [] };
    seen.count += 1;
    seen.at.push(lineNumber);
    tally.set(key, seen);
  }

  for (const { line, expression, count, at } of tally.values()) {
    const entry = entries.find((e) => e.line === line && e.expression === expression);
    if (!entry) {
      problems.push(
        `${file} carries ${expression} on line(s) ${at.join(', ')}, on the source line ${JSON.stringify(line)}. `
        + 'No allowlist entry pins that expression to that line. Every GitHub Actions expression in this '
        + 'directory needs an entry stating what it is and why it is safe -- adding one is the review.',
      );
      continue;
    }
    if (count !== entry.occurrences) {
      problems.push(
        `${file} carries ${expression} ${count} time(s) on ${JSON.stringify(line)} (line(s) ${at.join(', ')}); `
        + `its allowlist entry pins ${entry.occurrences}. Recorded reason was: ${entry.why}`,
      );
    }
  }

  for (const entry of entries) {
    if (tally.has(JSON.stringify([entry.line, entry.expression]))) continue;
    problems.push(
      `${file} no longer carries ${entry.expression} on the source line ${JSON.stringify(entry.line)}. `
      + 'That allowlist entry is dead -- the expression it exempted is gone or has moved, so delete or re-pin '
      + `it rather than letting it exempt something else. Recorded reason was: ${entry.why}`,
    );
  }

  return problems;
}
