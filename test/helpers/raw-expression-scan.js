// The repo-wide `${{ }}` guarantee, and the ONLY thing in this suite that is a
// guarantee rather than a diagnostic.
//
// The guarantee, stated once:
//
//   Every `${{ }}` occurrence in EVERY FILE under `.github/workflows/` --
//   enumerated by directory listing with NO extension filter, found by a raw
//   byte scan with no YAML understanding whatsoever -- must appear in an
//   allowlist keyed by (file, structural context, exact source line,
//   expression) with a stated reason. And no line in the directory may carry a
//   backslash escape that could CONSTRUCT an opener the scan cannot see.
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
// INDEPENDENCE IS ASSURED BY REVIEW OF THIS FILE, NOT BY AUTOMATION.
//
// This module is short, imports one line, and exports eight functions. A
// reviewer reading it can see that it reaches no YAML reader; that reading is
// the assurance, and it is the only assurance offered. `test/raw-sweep-test.js`
// keeps ONE mechanical check beside it -- a whitelist over every occurrence of
// the token `import` -- whose job is to stop the change that would be easy to
// make without noticing, not to defeat an engineer who means it.
//
// Five layered pins used to make the stronger claim. They were removed in round
// 5 of PR #38 because they produced four defects of their own and no live sink:
// a regex-literal scan that never entered a template-literal `${...}` (41
// substitutions, 586 characters of executable code unscanned, so the
// extractor's own anchor ran inside this file at 282 pass / 0 fail); a
// `node:module` loader hook that invoked every export with `undefined` -- six
// of the eight threw on their first statement -- and then filtered
// `!spec.startsWith('file://')`, discarding exactly the dependency form it
// existed to record; and, defeating all five at once,
// `process.getBuiltinModule('node:module').createRequire(...)` of an aliasing
// proxy (#37, Phase 4 NEW-1/NEW-2, Phase 1 F1/F9, Phase 3 §5a). Ceremony
// exceeding substrate: each repair bought another evasion.
//
// The property still holds and is still worth stating: the only thing this
// module has in common with the extractor is the directory path it reads, which
// is data rather than parsing logic. What changed is the honesty of the claim
// about how that is known.
//
// TWO THINGS A BYTE SCAN CANNOT DO, AND WHAT IS DONE ABOUT THEM.
//
// 1. It cannot see an opener that is CONSTRUCTED rather than written. A YAML
//    double-quoted scalar is the one style that processes escapes, and it
//    resolves them BEFORE anything looks for `${{`. Five spellings --
//    `"\x24{{"`, `"\u0024{{"`, `"$\x7b{"`, and the two line-continuation
//    forms `"$\`+newline+`{{"` and `"${\`+newline+`{"` -- all parse to
//    `${{ ... }}` with ZERO literal `${{` in the bytes, verified against a real
//    YAML parser, and two of them were measured appended to the real `ci.yml`
//    at 256 pass / 0 fail (#37, Phase 3 §3).
//
//    `escapeProblems` REPORTS them rather than interpreting them. This block
//    does not decide whether GitHub evaluates such a spelling, and it does not
//    need to: EITHER it is a live bypass, OR the shape is silently unswept and
//    this scan emits no record at all -- and failing open is precisely the
//    property this redesign was bought to eliminate. An unmodelled shape must
//    red. So it reds.
//
// 2. It cannot see what CONSUMES an expression. The key therefore carries the
//    structural context the line sits under -- see `structuralContexts` -- so
//    that an entry written for a `with:` input stops matching the moment its
//    byte-identical line is moved into a `run:` body. Measured before that key
//    field existed: relocating `version: ${{ inputs.pnpm-version }}` out of
//    `pnpm/action-setup`'s `with:` and into a `run:` body left the guarantee
//    reporting nothing at 256 pass / 0 fail, with a `workflow_call` input
//    reaching bash (#37, Phase 3 §4; Phase 1 F5 reproduced it independently
//    with `token: ${{ secrets.CASCADE_PAT }}`).
//
// This module is deliberately dull. `indexOf`, `slice`, `split` and `trim`. If
// it ever needs to become clever, that is the signal that a guarantee is
// drifting back onto a reader.

import { readdirSync, readFileSync } from 'node:fs';

const WORKFLOWS_DIR = new URL('../../.github/workflows/', import.meta.url);

const OPENER = '${{';
const CLOSER = '}}';
const BACKSLASH = '\\';

// THE ESCAPE ALPHABET, enumerated against libyaml rather than recalled.
//
// Every escape a YAML double-quoted scalar accepts was fed to Psych (libyaml
// 5.3.1) one at a time as `k: "A\<e>B"`. The complete accepted set is
//
//   \<space> \" \/ \0 \L \N \P \\ \_ \a \b \e \f \n \r \t \v   (fixed character)
//   \x \u \U                                                   (names a code point)
//
// and an escape outside it is a `Psych::SyntaxError` -- it fails loud at parse,
// it does not silently construct. Not one fixed-character escape resolves to
// `$` (U+0024), `{` (U+007B) or `}` (U+007D), so no combination of them can
// build an opener; `\L`, `\N` and `\P` produce U+2028, U+0085 and U+2029, which
// are line breaks but not opener characters, and they land INSIDE the resolved
// scalar where they cannot re-trigger a continuation. So the constructing set
// is exactly three escapes, plus the line continuation below. That is a
// whitelist over the mechanism, not a blocklist of spellings.
const CONSTRUCTING_ESCAPES = 'xuU';

// THE LINE-BREAK ALPHABET, likewise enumerated against libyaml.
//
// A backslash at the end of a YAML line joins the next one. Round 4 tested
// "end of line" as `next === undefined || next === '\r'` -- that is, the end of
// a JavaScript `split('\n')` segment -- and libyaml's break alphabet has FIVE
// members, not two: LF, CR, NEL U+0085, LS U+2028 and PS U+2029. Measured, each
// of the five joins the next line: `k: "echo $\<BREAK>  {{ inputs.x }}"`
// resolves to `echo ${{ inputs.x }}` for every one of them, and a NEL
// continuation appended to each of the five real workflows was 282 pass / 0
// fail with ZERO literal openers added (#37, Phase 3 §3). The controls matter
// as much: `\` + SPACE and `\` + TAB do NOT continue, and `\` + VT, FF, NBSP,
// U+2000, U+3000, ZWSP or BOM is a parse error, so this list is the whole set
// rather than the part that was reported.
//
// LF is absent here because `escapeProblems` reads `text.split('\n')` segments,
// so a backslash before an LF is a backslash at the end of a segment, which is
// `next === undefined`. CRLF is covered by CR.
const LINE_BREAK_CHARS = '\r\u0085\u2028\u2029';

const END_OF_LINE = '(end of line)';
const TOP_LEVEL = '(top level)';

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
 * How deep a line's CONTENT sits, in characters.
 *
 * Leading spaces, plus the `- ` of any list markers, because `- name: X` and
 * the `run: y` under it are siblings in the same mapping and a reader-free key
 * has to treat them that way. No YAML is understood here: this counts two
 * characters.
 */
function contentIndent(raw) {
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === ' ') { i += 1; continue; }
    if (raw[i] === '-' && raw[i + 1] === ' ') { i += 2; continue; }
    break;
  }
  return i;
}

/** The mapping key a raw line opens, or `''` if it opens none. */
function keyOf(raw) {
  const body = raw.slice(contentIndent(raw));
  const colon = body.indexOf(':');
  return colon === -1 ? '' : body.slice(0, colon).trim();
}

/**
 * For every line of `text`, the key of the nearest enclosing line -- the last
 * preceding non-blank line whose content sits strictly further left.
 *
 * This is the context half of the allowlist key, and it exists because the
 * trimmed line alone carries none. The same 33 characters mean "an input to
 * `pnpm/action-setup`" under `with:` and "a line of bash" under `run:`; an
 * entry keyed on the characters alone approves both, so an exemption follows
 * its line into a sink (#37, Phase 3 §4 and Phase 1 F5, both measured green at
 * 256 pass / 0 fail before this field existed).
 *
 * Derived from raw text -- indentation and the first colon -- never from the
 * extractor. It is not a YAML path and does not claim to be one: it is the
 * answer to "what key is this line written underneath", which is the thing
 * that changes when a line moves between sinks.
 */
export function structuralContexts(text) {
  const contexts = [];
  const open = [];

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') {
      contexts.push(open.length === 0 ? TOP_LEVEL : open[open.length - 1].key);
      continue;
    }
    const indent = contentIndent(raw);
    while (open.length > 0 && open[open.length - 1].indent >= indent) open.pop();
    contexts.push(open.length === 0 ? TOP_LEVEL : open[open.length - 1].key);
    open.push({ indent, key: keyOf(raw) });
  }

  return contexts;
}

/**
 * Every `${{` occurrence in `text`, as
 * `{ lineNumber, context, line, expression }`.
 *
 * `line` is the source line with leading and trailing whitespace removed --
 * re-indenting a block is not a change to what the line does, but every other
 * byte of it is part of the key.
 *
 * `context` is the key the line sits under, from `structuralContexts`. Moving
 * a byte-identical line from `with:` to `run:` changes it, which is what stops
 * an exemption travelling with its text.
 *
 * `expression` is `null` when the opener does not close on its own line. That
 * is not a skip: a null expression can never match an allowlist entry, so the
 * occurrence is reported. An expression spanning a line break is a shape this
 * scanner does not model, and the fail-closed answer to a shape it does not
 * model is to red rather than to guess.
 *
 * Exactly one record per opener, always -- the loop advances by one opener, not
 * past one closer. It used to advance past the closer, so `a ${{ x ${{ y }}`
 * emitted ONE record for TWO openers: the first expression's span swallowed the
 * second opener, and the `scanned === split` cross-check that is supposed to
 * corroborate the count silently disagreed with itself (#37, Phase 1 F4 /
 * Phase 4 NEW-8). The count of records IS the count of `${{` occurrences in the
 * file; nothing can drop out between the two.
 */
export function rawExpressions(text) {
  const found = [];
  const contexts = structuralContexts(text);

  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    let at = raw.indexOf(OPENER);

    while (at !== -1) {
      const close = raw.indexOf(CLOSER, at + OPENER.length);
      found.push({
        lineNumber: i + 1,
        context: contexts[i],
        line,
        expression: close === -1 ? null : raw.slice(at, close + CLOSER.length),
      });
      at = raw.indexOf(OPENER, at + OPENER.length);
    }
  });

  return found;
}

/**
 * Problems with an escape-allowlist entry's own shape.
 *
 * `escapeProblems` is the one check in this module whose subject is not an
 * expression, so it needs its own entry shape. The refusals are the same in
 * spirit as `entryShapeProblems`: an entry with no `line` would exempt its
 * escape everywhere in the file, and an entry whose `why` says nothing is an
 * approval nobody made.
 */
export function escapeEntryShapeProblems(file, entry) {
  const problems = [];
  const where = `${file} escape-allowlist entry for ${entry.escape ?? '(no escape)'}`;

  if (typeof entry.line !== 'string' || entry.line === '') {
    problems.push(`${where} has no line:. An entry without a line exempts its escape anywhere in the file.`);
  }
  if (typeof entry.escape !== 'string' || entry.escape === '') {
    problems.push(
      `${where} has no escape:. Name the escape it exempts -- one of `
      + `${[...CONSTRUCTING_ESCAPES].join(', ')} or ${END_OF_LINE}.`,
    );
  }
  if (typeof entry.why !== 'string' || entry.why.length < 60) {
    problems.push(
      `${where} needs a why: that states which scalar style the line is in and why the escape cannot build `
      + `an ${OPENER} there.`,
    );
  }

  return problems;
}

/**
 * Every backslash in `text` that could construct a character, as a problem
 * string, unless an escape-allowlist entry pins that exact `(line, escape)`.
 *
 * REPORTS, never interprets. A YAML double-quoted scalar resolves `\x24` to `$`
 * and joins a trailing backslash to the next line before anything looks for an
 * expression, so `run: "echo \x24{{ inputs.x }}"` carries no literal opener on
 * disk and `run: "echo $\` + newline + `{{ inputs.x }}"` carries none either.
 * Both were measured appended to the real `ci.yml` at 256 pass / 0 fail.
 *
 * This function does not decide whether the runner evaluates such a spelling,
 * because the finding does not depend on the answer: if it does, that is a live
 * bypass; if it does not, the shape is silently unswept and this scan has
 * failed OPEN, which is the one property the raw scan was bought to eliminate.
 * Either way an unmodelled shape must red.
 *
 * THREE DOMAINS, EACH ENUMERATED AGAINST libyaml RATHER THAN AGAINST THE
 * REPORTED PAYLOADS -- see the two alphabet blocks above for the first two.
 *
 *   1. WHICH ESCAPES CAN CONSTRUCT.       `\x`, `\u`, `\U`, and nothing else.
 *   2. WHICH CHARACTERS END A YAML LINE.  LF, CR, U+0085, U+2028, U+2029.
 *   3. WHICH SCALAR STYLES PROCESS `\`.   Measured: ONLY double-quoted. In a
 *      single-quoted, plain, literal-block or folded-block scalar, `\x24` stays
 *      four literal characters and a trailing backslash is a trailing
 *      backslash.
 *
 * Domain 3 is the reason this function reports on EVERY LINE OF EVERY FILE with
 * no filter of any kind, and the reason it must keep doing so. Deciding which
 * style a line is in requires parsing, and each of the three plausible
 * narrowings was measured turning a REAL constructed opener from 277 pass / 5
 * fail into 282 / 0 (#37, Phase 4 NEW-4):
 *
 *   * stepping over backslash PAIRS, the natural "stop reporting `\\`" fix;
 *   * reading only lines that contain a `"`, the natural "only double-quoted
 *     scalars process escapes" fix -- but a multi-line double-quoted scalar
 *     carries its continuation lines with NO quote character on them, and that
 *     is where the escape sits (verified against Psych);
 *   * skipping `#`-comment lines -- but a `#` inside a `run:` body is script
 *     text, and the runner substitutes an expression into it before bash parses.
 *
 * So the check over-reports by design: it fires on a `\x` in a `run: |` body
 * where YAML processes no escapes at all. THE WAY PAST IT IS AN ENTRY, NEVER A
 * WIDENED PATTERN -- `ESCAPE_ALLOWLIST` in `expression-allowlist.js` pins a
 * `(line, escape)` pair with a stated reason, exactly as the expression
 * allowlist pins an occurrence, and a dead entry reds. Without that, the only
 * available remedy would be to shrink `CONSTRUCTING_ESCAPES` or the population,
 * which is the widening this repo's own rule forbids (#37, Phase 3 §5c).
 *
 * `indexOf`, and a look at the next character. Nothing more.
 */
export function escapeProblems(file, text, escapeAllowlist = {}) {
  const entries = escapeAllowlist[file] ?? [];
  const problems = [];
  const used = new Set();

  for (const entry of entries) problems.push(...escapeEntryShapeProblems(file, entry));

  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    let at = raw.indexOf(BACKSLASH);

    while (at !== -1) {
      const next = raw[at + 1];
      const continuation = next === undefined || LINE_BREAK_CHARS.includes(next);
      if (continuation || CONSTRUCTING_ESCAPES.includes(next)) {
        const escape = continuation ? END_OF_LINE : next;
        const entry = entries.find((e) => e.line === line && e.escape === escape);
        if (entry) {
          used.add(entry);
        } else {
          problems.push(
            `${file}:${i + 1} carries ${continuation ? 'a backslash at end of line' : `a \\${next} escape`} on `
            + `${JSON.stringify(line)}. In a YAML double-quoted scalar that resolves BEFORE anything looks `
            + `for ${OPENER}, so an opener can be CONSTRUCTED with no literal ${OPENER} in the bytes -- `
            + 'measured green on the real ci.yml. A line ends at LF, CR, U+0085, U+2028 or U+2029, all five '
            + 'verified against libyaml. This scanner reads bytes and will not guess which scalar style a line '
            + 'is in. Either the runner evaluates the constructed opener, in which case this is a live bypass, '
            + 'or it does not, in which case the shape is silently unswept and the guarantee has failed open -- '
            + 'and failing open is the property a raw byte scan exists to eliminate. Write the line without the '
            + `escape, or add an ESCAPE_ALLOWLIST entry pinning ${JSON.stringify(line)} and `
            + `${JSON.stringify(escape)} with a reason. Do not widen the escape set or the line population.`,
          );
        }
      }
      at = raw.indexOf(BACKSLASH, at + 1);
    }
  });

  for (const entry of entries) {
    if (used.has(entry)) continue;
    problems.push(
      `${file} no longer carries a \\${entry.escape} on the source line ${JSON.stringify(entry.line)}. That `
      + 'entry in the ESCAPE_ALLOWLIST in test/helpers/expression-allowlist.js is dead -- delete or re-pin it '
      + `rather than letting it exempt something else. Recorded reason was: ${entry.why}`,
    );
  }

  return problems;
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
  if (typeof entry.context !== 'string' || entry.context === '') {
    problems.push(
      `${where} has no context:. The context is the key the line sits under -- without it the entry approves `
      + 'the characters of a line rather than the position it occupies, so it follows its line into a sink.',
    );
  }
  if (typeof entry.expression !== 'string' || !entry.expression.startsWith(OPENER)) {
    problems.push(`${where} has no expression: beginning with the opener it exempts.`);
  }
  if (!Number.isInteger(entry.occurrences) || entry.occurrences < 1) {
    problems.push(`${where} must pin a positive integer occurrences:, so a second copy on the line is not free.`);
  }
  const bothStrings = typeof entry.line === 'string' && typeof entry.expression === 'string';
  if (bothStrings && !entry.line.includes(entry.expression)) {
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
 * Five ways to red, and they are the whole contract:
 *
 *   1. an occurrence with no matching entry           -- an unapproved expression
 *   2. an occurrence count the entry does not pin     -- a second copy on the line
 *   3. an entry matching no occurrence                -- a dead exemption, which is
 *      what kept `security-audit.yml`'s sink allowlisted after the fix relocated
 *      it into a comment and into an `eval "..."` wrapper (#37, bypass 4, NEW-5),
 *      and what now also catches an allowlisted line MOVED into a different
 *      structural context, since the context is part of the key
 *   4. an entry whose own shape is malformed          -- `entryShapeProblems`
 *   5. a backslash that could construct an opener     -- `escapeProblems`
 *
 * An opener that does not close on its own line reds under (1) with its own
 * message, because `expression` is `null` and no entry can pin `null`.
 */
export function rawSweepProblems(file, text, allowlist, escapeAllowlist = {}) {
  const entries = allowlist[file] ?? [];
  const problems = [];
  const tally = new Map();

  for (const entry of entries) problems.push(...entryShapeProblems(file, entry));
  problems.push(...escapeProblems(file, text, escapeAllowlist));

  for (const { lineNumber, context, line, expression } of rawExpressions(text)) {
    if (expression === null) {
      problems.push(
        `${file}:${lineNumber} opens a ${OPENER} that does not close on the same line, on ${JSON.stringify(line)}. `
        + 'This scanner does not model an expression spanning a line break, and the fail-closed answer to a shape '
        + 'it does not model is to report it -- extend the scanner, or put the expression on one line.',
      );
      continue;
    }
    const key = JSON.stringify([context, line, expression]);
    const seen = tally.get(key) ?? { context, line, expression, count: 0, at: [] };
    seen.count += 1;
    seen.at.push(lineNumber);
    tally.set(key, seen);
  }

  for (const { context, line, expression, count, at } of tally.values()) {
    const entry = entries.find((e) => e.context === context && e.line === line && e.expression === expression);
    if (!entry) {
      problems.push(
        `${file} carries ${expression} on line(s) ${at.join(', ')}, under ${JSON.stringify(context)}, on the `
        + `source line ${JSON.stringify(line)}. No allowlist entry in test/helpers/expression-allowlist.js pins `
        + 'that expression to that line in that context. Every GitHub Actions expression in this directory needs '
        + 'an entry stating what it is and why it is safe -- adding one is the review.',
      );
      continue;
    }
    if (count !== entry.occurrences) {
      problems.push(
        `${file} carries ${expression} ${count} time(s) on ${JSON.stringify(line)} under `
        + `${JSON.stringify(context)} (line(s) ${at.join(', ')}); its entry in `
        + `test/helpers/expression-allowlist.js pins ${entry.occurrences}. Recorded reason was: ${entry.why}`,
      );
    }
  }

  for (const entry of entries) {
    if (tally.has(JSON.stringify([entry.context, entry.line, entry.expression]))) continue;
    problems.push(
      `${file} no longer carries ${entry.expression} under ${JSON.stringify(entry.context)} on the source line `
      + `${JSON.stringify(entry.line)}. That entry in test/helpers/expression-allowlist.js is dead -- the `
      + 'expression it exempted is gone, or has moved to a different line or a different structural context, so '
      + `delete or re-pin it rather than letting it exempt something else. Recorded reason was: ${entry.why}`,
    );
  }

  return problems;
}
