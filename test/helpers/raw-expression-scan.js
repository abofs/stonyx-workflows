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
// This module is short, its only imports are three `node:` builtins, and it
// exports nine functions. A reviewer reading it can see that it reaches no YAML
// reader; that reading is the assurance, and it is the only assurance offered.
// `test/raw-sweep-test.js`
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
// 2. It cannot see what CONSUMES an expression, and it cannot establish where
//    a line SITS. The key therefore carries the CHAIN of enclosing keys the
//    line is written under -- see `structuralContexts` -- so that an entry
//    written for a `with:` input stops matching once its byte-identical line
//    is moved into a `run:` body. Measured before that field existed:
//    relocating `version: ${{ inputs.pnpm-version }}` out of
//    `pnpm/action-setup`'s `with:` and into a `run:` body left the guarantee
//    reporting nothing at 256 pass / 0 fail, with a `workflow_call` input
//    reaching bash (#37, Phase 3 §4; Phase 1 F5 reproduced it independently
//    with `token: ${{ secrets.CASCADE_PAT }}`).
//
//    THE LIMIT, STATED IN THE DIRECTION IT ACTUALLY FAILS. Round 4's version
//    of this note said a line under a shell construct "gets a context that is
//    not a key name; that direction is fail-closed". That was measured FALSE:
//    it gets whatever key name the payload supplies, and a `with:` line
//    written inside a `run:` body was 282 pass / 0 fail with the org-level
//    `CASCADE_PAT` in a shell body (#37, Phase 1 F7, Phase 3 §4).
//
//    TWO MECHANISMS CLOSE IT, and they close different halves. The chain and
//    the `(scalar)` link close every scalar style whose content MUST be more
//    indented than its own key line -- literal block `|`, folded block `>`,
//    and plain multi-line, THREE of the five. Round 5 of PR #38 measured that
//    this note previously said FOUR, and that the remaining styles were "a
//    multi-line flow scalar": both wrong, and wrong in the direction that
//    understates a fail-open gap. The styles the chain alone cannot close are
//    the two QUOTED ones and the flow collections, because each is defined not
//    by indentation but by AN OPENER THAT HAS NOT CLOSED YET -- so a
//    continuation line may sit at exactly the indent a legitimate key would
//    occupy. Dedented to the enclosing key's own content indent, the forged
//    frame pops immediately and the derived chain came out BYTE-IDENTICAL to
//    the line it replaced: measured on the real files at 294 pass / 0 fail,
//    double-quoted AND single-quoted AND flow, with the org-level
//    `CASCADE_PAT` substituted into a live shell command line, and reaching 34
//    of the 36 allowlist entries by a mechanical transform (#37/PR #38,
//    Phase 3 round 5 §4, Phase 2 round 5 N-W1, Phase 5 round 5 N5-1).
//
//    That half is now closed by `walk`, whose quote and flow-depth state
//    PERSISTS ACROSS THE LINE BREAK, so a line that began inside an open
//    scalar may not open a mapping. It is not a parser and it needs no YAML
//    understanding -- the previous claim here, that closing this "needs a
//    parser", was false and is retracted. Re-measured on this tree, each of
//    the three dedented spellings on the real `ci.yml`: 313 pass / 6 fail,
//    from
//    294 / 0 green at `1a98115`. TEN spellings of the forgery are committed as
//    cases in `test/raw-sweep-test.js`.
//
//    AND THAT WAS STILL NOT ALL FIVE STYLES. This note said "all five scalar
//    styles and both flow collections are closed" while the marking was only
//    reachable for a payload INDENTED under its opener; a payload dedented back
//    out derived no `(scalar)` link at all, at nine of thirteen indent columns
//    against the real `npm-publish.yml`, and was 309 pass / 0 fail at `2c7d7bd`
//    with an ordinary-looking entry. Round 9 moved the marking onto the LINE's
//    own state, which no dedent can pop: thirteen of thirteen columns now
//    derive a link, and the same diff is 313 / 6 here.
//
//    AND THE REFUSAL IS IN `entryShapeProblems`, NOT ONLY IN THE CHAIN. Round
//    6 shipped the sentence "no entry can name such a context" in this header,
//    in `scalarHint`, in the allowlist header and in `README.md`, and enforced
//    it nowhere -- copy the `(scalar)` context the red prints into an
//    otherwise well-formed entry and the guarantee returned ZERO problems with
//    the org PAT live (PR #38, Phase 1 round 6 §1 and Phase 2 round 6 §4,
//    found independently). `entryShapeProblems` now refuses any entry whose
//    context names a `(scalar)` link, and `rawSweepProblems` calls it for
//    every entry, so the sentence is true where it is written. The price is
//    that an expression INSIDE a block-scalar `run: |` body is not pinnable
//    where it sits; the remedy is to bind it through a step `env:`, and
//    `README.md`'s contributor rules carry that, measured.
//
//    WHAT IS STILL NOT CLOSED, so this note does not repeat its own history:
//    the key is `(file, chain, line, expression)` and it DOES NOT MODEL THE
//    RECIPIENT. Re-adding an allowlisted line byte-identically under a
//    different `uses:` -- `actions/checkout` to `attacker/telemetry-action@v1`
//    -- keeps the chain identical and is green here, with the discriminator
//    installed and with a real parser alike, because parsing cannot fix a key
//    that asks the wrong question. That one is a human obligation on the diff,
//    where `uses:` is the loudest line a workflow change can carry. See
//    `structuralContexts` for the derivation and README.md for the disclosure.
//
// This module is deliberately dull. `indexOf`, `slice`, `split` and `trim`. If
// it ever needs to become clever, that is the signal that a guarantee is
// drifting back onto a reader.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// A context is the CHAIN of enclosing keys, and `(scalar)` marks a link that
// cannot legitimately open a mapping -- see `structuralContexts`.
const CHAIN_SEPARATOR = ' > ';
const SCALAR = '(scalar)';

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

/**
 * The raw bytes of one file in `.github/workflows/`, read as UTF-8.
 *
 * A PATH JOIN, NOT A URL RESOLUTION, and the difference is a hole. This used to
 * do `new URL(name, dir)`, and a file URL PERCENT-DECODES on read: the
 * enumerator listed the directory entry `%63i.yml` -- a perfectly valid
 * filename that GitHub Actions will execute -- and `readWorkflowFile` handed
 * back `ci.yml`'s bytes. The new file's content was never scanned and `ci.yml`'s
 * was scanned twice under two names, so the two halves of the guarantee
 * disagreed about what "a file" is (#37, Phase 3 §5b). It was fail-closed only
 * because a separate pin exact-matches the five names -- and that pin is
 * expected to be edited every time a workflow is legitimately added, which is
 * the wrong thing to be relying on.
 */
export function readWorkflowFile(name, dir = WORKFLOWS_DIR) {
  return readFileSync(join(fileURLToPath(dir), name), 'utf8');
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
 * What a raw line writes after its first colon, trimmed -- or the whole line
 * when it has no colon.
 *
 * A mapping key that already carries a value cannot also carry children: a node
 * has one value. So `with:` can open a mapping and `run: "true` cannot, and
 * `run: |` opens a SCALAR whose content is not a mapping either. This is the
 * one YAML fact the chain below relies on, and it is a fact about the data
 * model rather than about syntax.
 */
function valueOf(raw) {
  const body = raw.slice(contentIndent(raw));
  const colon = body.indexOf(':');
  return colon === -1 ? body.trim() : body.slice(colon + 1).trim();
}

/**
 * Whether a key's value OPENS A BLOCK SCALAR (`|`, `>`, and their chomping and
 * indentation variants), inside which no quote and no bracket is special.
 *
 * Measured, Psych / libyaml 5.3.1 / 0.2.5: `k: |` then `  "unclosed` then
 * `  still: body` loads as the string `"unclosed\nstill: body\n"` -- the
 * unbalanced `"` is ordinary content and does not open anything. So the walk
 * below has to be SUSPENDED in here, or one apostrophe of shell text would
 * poison every line after it.
 */
function blockScalarValue(value) {
  return value.startsWith('|') || value.startsWith('>');
}

/**
 * One continuous character walk whose quote and flow-collection state PERSISTS
 * ACROSS LINE BREAKS, because that is exactly what a multi-line quoted scalar
 * is: a quote state that survives a `\n`.
 *
 * WHY THIS EXISTS. `structuralContexts` used to discard all state at every
 * `\n` and then correctly prove that what remained -- indentation and the
 * first colon -- cannot tell a forged key from a real one. It cannot; the
 * discarded state can. A line that BEGAN inside an open quoted scalar or an
 * open flow collection is DATA, whatever it looks like, and data may not open
 * a mapping. That fact is about bytes on the PREVIOUS line, which is why no
 * function of one line in isolation could ever have closed this.
 *
 * THE RULES, DERIVED AGAINST libyaml RATHER THAN ASSUMED -- the same way the
 * escape alphabet was derived. Psych 5.3.1 / libyaml 0.2.5, probing whether an
 * open scalar still swallows a following dedented `with:` line:
 *
 *   double-quoted   `\` escapes the next character; ONLY a bare `"` closes.
 *                   `}`, `]`, `'`, `#` and `:` are ordinary content -- all
 *                   measured still-open.
 *   single-quoted   `''` is an escaped quote; ONLY a bare `'` closes. `\` is
 *                   NOT special: `k: 'a\'' b'` loads as `a\' b`, so a
 *                   backslash branch here would be wrong.
 *   flow            `{` `[` open, `}` `]` close. A flow collection left open
 *                   across a break is a `Psych::SyntaxError` -- it cannot
 *                   carry a payload, but it must still not go green, and
 *                   poisoning the link is how it fails closed.
 *   `#`             starts a comment only at line start or after a space
 *                   (`k: a#b` is the string `a#b`), and never inside a quote.
 *
 * MONOTONE FAIL-CLOSED, which is the property that makes it safe to add
 * without re-auditing every other pin. Dirty state can only ever mark a link
 * `(scalar)`, which can only ever make an occurrence lose its entry and that
 * entry go dead -- MORE problems. It cannot silence a problem that already
 * reds.
 *
 * ONE CHARACTER OF LOOKAHEAD, no regex, no dependency, no YAML understanding.
 */
function walk(line, state) {
  let i = 0;
  let { quote, depth } = state;

  while (i < line.length) {
    const ch = line[i];
    if (quote === '"') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') quote = null;
      i += 1; continue;
    }
    if (quote === "'") {
      if (ch === "'" && line[i + 1] === "'") { i += 2; continue; }
      if (ch === "'") quote = null;
      i += 1; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i += 1; continue; }
    if (ch === '{' || ch === '[') { depth += 1; i += 1; continue; }
    if (ch === '}' || ch === ']') { depth = depth > 0 ? depth - 1 : 0; i += 1; continue; }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ')) break;
    i += 1;
  }

  return { quote, depth };
}

/**
 * For every line of `text`, the CHAIN of enclosing keys it is written under --
 * `jobs > dispatch > steps > with` -- with any link that cannot legitimately
 * open a mapping rendered as `<key> (scalar)`.
 *
 * WHY A CHAIN, AND WHY THE `(scalar)` LINKS.
 *
 * Round 3 keyed the allowlist on the NEAREST enclosing key. Round 4 measured
 * that the payload supplies its own: a `with:` line written INSIDE a `run:`
 * block scalar makes every line indented under it read `with`, which is
 * exactly what an entry for an action input pins. `secrets.CASCADE_PAT`
 * relocated out of `actions/checkout`'s `with:` and into a shell body was
 * guarantee `[]`, 282 pass / 0 fail, on the real `cascade.yml` and on
 * `npm-publish.yml` (#37, Phase 1 F7 / §3, Phase 3 §4, independently). The
 * scanner derives context from the same untrusted bytes it polices.
 *
 * THE DOMAIN, ENUMERATED AGAINST libyaml RATHER THAN AGAINST THAT PAYLOAD. The
 * question is "which lines can legitimately establish context", and the answer
 * turns on one measurable property: can a scalar's CONTENT sit at an
 * indentation less than or equal to its own key line's content indent? Every
 * YAML scalar style and both flow collections were measured against Psych
 * 5.3.1 / libyaml 0.2.5, and re-derived against the same pair in round 6:
 *
 *   literal block `|`   NO   -- content at or left of the key is a sibling key
 *   folded block `>`    NO   -- same
 *   plain multi-line    NO   -- must be more indented than the key
 *   double-quoted       YES  -- a continuation may sit at ANY INDENT AT ALL,
 *                              including column 0 and including columns left
 *                              of its own key line
 *   single-quoted       YES  -- same
 *   flow mapping/seq    YES  -- same
 *
 * THE TWO QUOTED ROWS SAID "any indent GREATER THAN the enclosing block
 * mapping's" for three rounds, and that qualifier is not a rule libyaml
 * enforces. Re-derived rather than re-asserted (PR #38, Phase 3 round 8 §1a,
 * reproduced here): 63 documents, key at content indent m = 0..6 inside a
 * nested mapping, continuation at indent p = 0..8, `Psych.load` on each --
 * 63 / 63 keep the payload inside the scalar, INCLUDING every cell where p < m
 * and every cell where p = 0. `m=6, p=0` loads as
 * `{"a"=>{"b"=>{"c"=>{"k"=>"true PAYLOAD "}}}}`. There is no lower bound.
 *
 * THREE NO ROWS, THREE YES ROWS -- and the count is written out because this
 * note said "four" for a round, in the direction that understates the gap
 * (PR #38, Phase 5 round 5 N5-1). For the three NO rows the owning key line is
 * unavoidably an ancestor of the payload, so a chain closes them: FOR THOSE
 * THREE a payload can lengthen a chain and never shorten one. That is why this
 * is a chain and not a nearest key, and it is why the fix is not "reject
 * `with:` inside `run:`" -- it rejects every position a scalar whose content
 * must be deeper can reach.
 *
 * IT IS NOT TRUE OF THE THREE YES ROWS, AND THIS NOTE ASSERTED IT WITHOUT THE
 * QUALIFIER FOR THREE ROUNDS. A quoted continuation at or left of its own
 * opener SHORTENS the chain: the pop loop below drops the opener's frame -- the
 * one frame guaranteed `(scalar)` -- and every dirty frame above it. Measured
 * on this tree, one forged step appended to the real `npm-publish.yml` with the
 * payload swept across indents 0..12: all thirteen keep the expression live
 * inside the `run:` string, and nine of the thirteen used to derive a context
 * with no `(scalar)` link anywhere. That is why the marking below is taken from
 * the LINE's state and not from a frame -- see `structuralContexts`.
 *
 * The `(scalar)` marking closes the same rows one step earlier and more
 * cheaply: `run: "true` and `run: |` both already carry a value, so neither can
 * open a mapping, so nothing nested under either is a position an entry can
 * approve -- `entryShapeProblems` refuses an entry that names one. Both
 * measured payloads red on this alone.
 *
 * THE THREE YES ROWS, AND WHAT THE CHAIN ALONE COULD NOT DO ABOUT THEM. For
 * those three a continuation line may sit at exactly the indentation a
 * legitimate key would occupy, so a payload can reproduce a legitimate ladder
 * link for link. INDENTED under the opener the chain still lengthens and the
 * entry stops matching, which is what the four committed relocation cases
 * measure. DEDENTED to the enclosing key's own content indent it does not:
 *
 *     - name: Leak
 *       run: "true
 *       with:
 *         token: ${{ secrets.CASCADE_PAT }}
 *       "
 *
 * -- valid YAML, `run` resolving to the whole shell string, the forged frame
 * popping before the payload line is read, and the derived chain therefore
 * BYTE-IDENTICAL to the `actions/checkout` input it replaced. The entry
 * matched, the entry was not dead, and the guarantee returned `[]` at 294 pass
 * / 0 fail with an org-level PAT in a shell command line -- in all three
 * styles, not the one this note used to name, and against 34 of the 36
 * allowlist entries by a mechanical transform (PR #38 round 5: Phase 3 §4,
 * Phase 2 N-W1, Phase 5 N5-1).
 *
 * WHAT CLOSED IT, AND WHY IT IS NOT A PARSER. This note used to say "closing
 * it needs a parser, and the guarantee does not parse". That was correct about
 * the alphabet it named and wrong about which alphabet is available: the three
 * YES styles are not defined by indentation or by colons, each is defined by
 * AN OPENER THAT HAS NOT CLOSED YET, which is a fact about bytes on the
 * PREVIOUS line -- the one thing a per-line reading discards. `walk` puts it
 * back. A line that BEGAN inside an open quoted scalar or flow collection is
 * DATA and may not open a mapping, so every link it would have contributed is
 * marked `(scalar)` instead. That is one `while` loop and one character of
 * lookahead; it reaches no YAML reader and the "understands no YAML" property
 * is intact. The false impossibility claim is retracted rather than softened,
 * because a reader who believed it would not have looked for the cheap fix.
 *
 * Measured on this tree: the three dedented spellings on the real `ci.yml` go
 * from 294 / 0 GREEN at `1a98115` to 313 pass / 6 fail, all five real workflows still sweep
 * clean with no new allowlist entry, and ten spellings are committed as
 * cases -- including a decoy `}`, which is ordinary content inside a
 * double-quoted scalar and is the case that separates this from a plausible
 * implementation that resets quote state per line, and two that pin the
 * flow-depth half. Measured on this tree with those two rows deleted, both of
 * its widenings are 317 / 0 of 317 -- invisible to every other test -- and
 * 318 / 1 each with the rows present.
 *
 * AND ONE MORE THING THE FRAME MARKING COULD NOT SEE, closed in round 9: the
 * link above is contributed by the dirty line, and a contributed link is only
 * reachable from a line INDENTED under it. A payload written at or left of its
 * own opener popped the opener's frame before its own position was recorded.
 * The recorded context is now marked from `dirtyAtLineStart` directly, which
 * the pop loop cannot reach. Measured on this tree, payload indent swept 0..12
 * against the real `npm-publish.yml`: 13/13 live in the `run:` string, 13/13
 * now carry a `(scalar)` link (9 of 13 carried none), and the twelve-line diff
 * that was 309 pass / 0 fail at `2c7d7bd` is 313 / 6 here.
 *
 * STILL NOT CLOSED, AND NOT CLOSEABLE HERE. The key does not model WHO
 * RECEIVES the input. Re-adding an allowlisted line byte-identically under
 * `uses: attacker/telemetry-action@v1` leaves file, chain, line and expression
 * all unchanged, and is green with this discriminator and with a real parser
 * alike. That is a human obligation on the diff, and `README.md`'s *Honest
 * gaps* carries it.
 *
 * Derived from raw text -- indentation and the first colon -- never from the
 * extractor. It is not a YAML path and does not claim to be one.
 */
export function structuralContexts(text) {
  const contexts = [];
  const open = [];
  let state = { quote: null, depth: 0 };
  const chain = () => (open.length === 0 ? TOP_LEVEL : open.map((frame) => frame.link).join(CHAIN_SEPARATOR));

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') {
      contexts.push(chain());
      continue;
    }
    const indent = contentIndent(raw);
    while (open.length > 0 && open[open.length - 1].indent >= indent) open.pop();

    const key = keyOf(raw);
    const value = valueOf(raw);
    // Inside a block scalar no quote and no bracket is special, so the walk is
    // suspended there -- see `blockScalarValue`.
    const inBlock = open.some((frame) => frame.block);
    // Read BEFORE walking this line: the question is what state this line
    // BEGAN in, not what it ends in.
    const dirtyAtLineStart = state.quote !== null || state.depth > 0;

    // THE LINE'S OWN POSITION, MARKED FROM THE LINE'S OWN STATE -- not inferred
    // from a frame that a dedent can pop. `dirtyAtLineStart` is a fact about
    // the bytes before this line and nothing in the pop loop above can reach
    // it, so a payload written at or left of its opener carries the marking
    // just as one written under it does. See the round-8 note in the docstring.
    contexts.push(dirtyAtLineStart ? `${chain()} ${SCALAR}`.trim() : chain());

    if (!inBlock) state = walk(raw.slice(indent), state);

    // A key that already carries a value has no room for children, so it can
    // never be a legitimate ancestor. A line with no colon at all -- `*alias`,
    // `? run` -- opens no mapping either, and `valueOf` returns its whole body.
    // AND a line that began inside an open quoted scalar or flow collection is
    // DATA whatever it spells, so it may not open a mapping either -- that is
    // the one thing a per-line reading could not know.
    const link = (value === '' && !dirtyAtLineStart) ? key : `${key} ${SCALAR}`.trim();
    open.push({ indent, link, block: !inBlock && blockScalarValue(value) });
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
 * NO OTHER NORMALISATION, and that is a rule rather than an accident. A `line`
 * loosened to collapse internal double spaces WIDENS the exemption -- an entry
 * written for `a:  ${{ x }}` would then also exempt `a: ${{ x }}` -- and the
 * repo's rule is that the way past a check is an entry, never a widened
 * pattern. `trimStart` instead of `trim` narrows it and stops the field being
 * what the failure message tells a contributor to copy. Both were measured at
 * 293 pass / 0 fail before there was a case for them (#37, Phase 4 NEW-6
 * carry-over, Phase 5 N-N1); `raw-sweep-test.js` now pins both directions.
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
 * bulk-pasted across the whole allowlist. Written without a regex like everything
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
 *
 * THE `(scalar)` REFUSAL IS HERE, AND IT IS HERE BECAUSE THIS IS THE LAYER THAT
 * CLAIMS IT. Round 6 shipped "no entry can name such a context" in the
 * contributor-facing hint, in this module's header, in the allowlist header and
 * in `README.md`, and enforced it in none of them: `entryShapeProblems` had
 * seven refusals and not one looked at the link. Measured -- copy the `(scalar)`
 * context the red prints, exactly as the allowlist header instructs, into an
 * otherwise well-formed entry, and `rawSweepProblems` returned ZERO problems
 * with an org-level PAT live in a `curl` command line (PR #38, Phase 1 round 6
 * §1 and Phase 2 round 6 §4, found independently). The only thing refusing it
 * was a global assertion over the five shipped files in `raw-sweep-test.js`,
 * which no entry can clear -- so the contributor's edit and the attacker's edit
 * were the same edit. `rawSweepProblems` calls this function for every entry, so
 * the refusal now reds at the guarantee, where the sentence says it does.
 *
 * It is deliberately blanket rather than clever. Both causes of a `(scalar)`
 * link -- a key that already carries a value, and a line that began inside an
 * open scalar -- put the position outside the data model, and separating them
 * would need the parser this file does not have. The price is stated rather
 * than hidden: an expression INSIDE a block-scalar `run: |` body is not
 * pinnable where it sits, and the remedy is to bind it through a step `env:`.
 * `README.md`'s contributor rules carry that, measured.
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
  if (typeof entry.context === 'string' && entry.context.includes(SCALAR)) {
    problems.push(
      `${where} names a context containing a ${SCALAR} link, and no entry may name one. A key that already `
      + 'carries a value, or a line that began inside an open quoted scalar or flow collection, is DATA: it '
      + 'cannot open a mapping, so neither its own position nor any position under it is one an entry can '
      + 'approve. If a payload printed this '
      + 'context at you, it wrote its own position and the answer is not an exemption. If it is your own '
      + 'block-scalar body, the expression is not pinnable where it sits -- bind it through a step `env:` and '
      + 'reference the variable in the body instead.',
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
 * The one sentence a contributor needs when a `(scalar)` link is the reason
 * their entry did not match, and the reason it is a message rather than an
 * allowlist.
 *
 * A `(scalar)` link means the position cannot legitimately open a mapping, and
 * as of round 6 that has a second cause: the line BEGAN inside an open quoted
 * scalar or flow collection, so it is data whatever it spells. Without this
 * hint the red reads as an ordinary entry mismatch and sends the reader to copy
 * a context that `entryShapeProblems` refuses.
 *
 * Deliberately NOT an allowlist. The shape has never occurred in these five
 * files, so there is nothing to exempt; and an exemption here would be an
 * exemption for "trust this forged context", which is the whole thing being
 * refused.
 *
 * THE REMEDY THIS USED TO NAME WAS WRONG, and it was wrong in the direction
 * that does not converge. It said "rewrite it as a block scalar (`|` or `>`),
 * which this scanner reads correctly" -- but a line inside a `run: |` body
 * derives `run (scalar)`, so that advice moves the reader from one `(scalar)`
 * link to another and the entry is refused there too (PR #38, Phase 2 round 6
 * §4, measured). There is no spelling of an entry that pins an expression
 * under a `(scalar)` link. The remedy is a workflow edit, and it is the one
 * `npm-publish.yml` already uses for eleven of its twenty-five expressions,
 * against one that sits in a `run:` line: bind the value through a step `env:`
 * and reference the shell variable in the body.
 */
function scalarHint(context) {
  if (!context.includes(SCALAR)) return '';
  return ` A link reading "<key> ${SCALAR}" is a position that cannot open a mapping -- either the key already `
    + 'carries a value, or this line began inside an open quoted scalar or flow collection and is therefore data. '
    + 'No entry can name such a context -- entryShapeProblems refuses one that does -- so copying it out of this '
    + 'message will red rather than exempt. There is no entry that pins an expression here: bind the value '
    + 'through a step `env:` and reference the shell variable in the body instead.';
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
        + 'an entry stating what it is and why it is safe -- adding one is the review.'
        + scalarHint(context),
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
