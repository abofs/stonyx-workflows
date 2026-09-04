// Does an `actions/checkout` step leave its credential in `.git/config`?
//
// THIS FILE CARRIES A GUARANTEE, so it is a RAW-TEXT reader: it parses no YAML,
// imports nothing at all, and refuses loudly on any shape it does not
// understand. That is the discipline `raw-expression-scan.js` follows and the
// opposite of `workflow-yaml.js`, which says of itself "DIAGNOSTICS ONLY. NO
// GUARANTEE IN THIS SUITE DEPENDS ON THIS FILE" -- nine bypasses on
// abofs/stonyx-workflows#37 are why. So nothing here imports it.
//
// It is NOT written the way `raw-expression-scan.js` is written, and an earlier
// revision of this header claimed it was. That file's own header says
// "Understands no YAML: `indexOf`, `slice`, `split`, `trim`, and not one
// regex." This one uses seven anchored regexes and walks indentation to bound a
// step. It is a reader -- a fail-closed one that throws where the diagnostics
// reader guesses, but a reader.
//
// The property being guarded (abofs/stonyx-workflows#35):
//
//   `actions/checkout@v4` defaults `persist-credentials: true`, which writes an
//   `http.<host>/.extraheader` Authorization entry into `.git/config`. In
//   cascade mode `npm-publish.yml` checks out with the org-wide `CASCADE_PAT`
//   and then runs the CONSUMER's own code in the same job -- four kinds of step
//   at ten call sites: `pnpm install` (lifecycle scripts, 1), `pnpm test` (1),
//   `pnpm version` (pre/version/post, 5) and `pnpm publish`
//   (prepublishOnly/prepack/prepare, 3). Any of them can read `.git/config`.
//   This is not hypothetical: 21 published `@stonyx/cron` versions shipped
//   `package/.git/config` carrying a live credential to the public npm
//   registry.
//
// Every judgement below is fail-closed. An unreadable step throws; an
// unrecognised token spelling counts as PRIVILEGED; an unrecognised
// `persist-credentials` value counts as NOT DISABLED. Over-reporting reds a
// suite and gets a decision written down. Under-reporting is the defect.

const indentOf = (line) => line.match(/^([ \t]*)/)[1].length;

/**
 * THE AUTHORITATIVE POPULATION: how many `actions/checkout` steps a workflow
 * declares, counted off the raw text by a mechanism this file's reader does not
 * use anywhere.
 *
 * Deriving the expected count from the reader is what makes a reader that
 * misses a step agree with its own omission -- the exact shape of #37's bypass
 * 6a, where an unnamed step was appended to the previous step's body and the
 * suite stayed green at 185/0. The tests assert this number and the reader's
 * agree, so a checkout the reader cannot see reds on the count even when it
 * defeats the reader.
 *
 * Which means the count must not share the reader's IDEA OF A CHECKOUT either,
 * not merely its code. An earlier revision counted with a copy of
 * `USES_CHECKOUT` -- byte-identical apart from the `g`/`m` flags -- so the
 * control could not see any shape the reader missed, because it WAS the
 * reader's selector. Measured: a flow-mapping step,
 * `- { uses: actions/checkout@v4, with: { token: "${{ secrets.CASCADE_PAT }}" } }`,
 * is valid GitHub Actions, persists an org PAT, and left both at 1 and the
 * whole file green at 31/31.
 *
 * So this counts plain occurrences of the action name instead, with WHOLE
 * COMMENT LINES dropped first. The strip is load-bearing, not cosmetic: this
 * repo's own comments name `actions/checkout` three times in `npm-publish.yml`
 * and once each in `ci.yml`, `security-audit.yml` and `self-ci.yml`, so an
 * unstripped substring count reads 1/2/5/2/2 rather than 1/1/2/1/1.
 *
 * It over-reports rather than under-reports -- a trailing `# ... actions/checkout`
 * comment or the string in a `run:` body inflates it, reds the count, and gets
 * a decision written down. That is this file's direction of failure everywhere.
 */
export function rawCheckoutCount(text) {
  const withoutCommentLines = text.split('\n').filter((line) => !/^[ \t]*#/.test(line)).join('\n');
  return (withoutCommentLines.match(/actions\/checkout/g) ?? []).length;
}

const USES_CHECKOUT = /^[ \t]*(?:-[ \t]+)?['"]?uses['"]?[ \t]*:[ \t]*['"]?actions\/checkout(?=[@'"\s]|$)/;
const LIST_ITEM = /^([ \t]*)-(?:[ \t]+\S.*|[ \t]*)$/;

// The ONLY token spellings that resolve to the ambient, repo-scoped, job-lived
// `GITHUB_TOKEN`. A whitelist over the mechanism, not a blocklist of bad
// spellings: anything else -- a secret, a composed expression, a bare string,
// an expression this file has never seen -- is PRIVILEGED and must not be left
// on disk. `npm-publish.yml`'s real value is
// `${{ (inputs.cascade-source != '' && secrets.CASCADE_PAT) || github.token }}`,
// which CONTAINS `github.token`, so a substring test here would have exempted
// precisely the step this issue is about.
const AMBIENT_TOKENS = new Set([
  '${{ github.token }}',
  '${{ secrets.GITHUB_TOKEN }}',
]);

// `persist-credentials` is disabled only by these. YAML 1.1 also reads `False`,
// `no`, `off` and `n` as false, and GitHub's parser does not agree with YAML
// 1.1 on all of them; rather than encode a guess about which, anything outside
// this set reds and gets a recorded decision.
const DISABLED = new Set(['false', "'false'", '"false"']);

const unquote = (v) => (/^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v);

/**
 * The raw lines of the step list-item that contains line `usesIdx`.
 *
 * Walks BACK to the nearest `- ` list item whose own indent is shallower than
 * the `uses:` key, then forward to the first non-blank line at or below that
 * item's indent. Throws rather than guessing: a step whose bounds cannot be
 * established would otherwise be read with a truncated body, and a truncated
 * body is how a `token:` goes unseen.
 */
function stepBlockAt(lines, usesIdx, file) {
  const keyIndent = indentOf(lines[usesIdx]);
  let start = -1;

  if (LIST_ITEM.test(lines[usesIdx])) {
    start = usesIdx;
  } else {
    for (let j = usesIdx - 1; j >= 0; j--) {
      if (lines[j].trim() === '') continue;
      const itemIndent = LIST_ITEM.test(lines[j]) ? indentOf(lines[j]) : null;
      if (itemIndent !== null && itemIndent < keyIndent) { start = j; break; }
      if (indentOf(lines[j]) < keyIndent) break; // left the step without finding its list item
    }
  }

  if (start === -1) {
    throw new Error(
      `${file}: the actions/checkout at line ${usesIdx + 1} is not inside a step list item this reader can `
      + 'bound. Refusing to read a truncated step body -- extend the reader instead of deleting the case '
      + 'that failed (abofs/stonyx-workflows#35).',
    );
  }

  const itemIndent = indentOf(lines[start]);
  const block = [{ idx: start, text: lines[start] }];
  for (let j = start + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') { block.push({ idx: j, text: lines[j] }); continue; }
    if (indentOf(lines[j]) <= itemIndent) break;
    block.push({ idx: j, text: lines[j] });
  }
  return block;
}

/**
 * The single value of `key:` within a step block, `null` when the key is
 * absent, and a THROW when it appears more than once.
 *
 * Deliberately scans the whole step block rather than only the `with:` mapping.
 * That is over-broad -- a `token:` line inside a block scalar in the same step
 * would be read as a real key -- and it is over-broad on purpose: a checkout
 * step that embeds YAML text reds here and gets a decision written down, rather
 * than teaching this reader to look past a `with:` it did not expect.
 */
function soleValue(block, key, file) {
  const probe = new RegExp(`^[ \\t]*(?:-[ \\t]+)?['"]?${key}['"]?[ \\t]*:(?:[ \\t]|$)`);
  const hits = block.filter(({ text }) => probe.test(text));
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    throw new Error(
      `${file}: a checkout step declares ${key}: ${hits.length} times (lines `
      + `${hits.map((h) => h.idx + 1).join(', ')}). A duplicate key is ambiguous and resolving it to the `
      + 'first match is how a real value goes unread (abofs/stonyx-workflows#35).',
    );
  }
  const value = hits[0].text.replace(new RegExp(`^[ \\t]*(?:-[ \\t]+)?['"]?${key}['"]?[ \\t]*:[ \\t]*`), '').trimEnd();
  const withoutComment = value.replace(/\s+#.*$/, '');
  return { value: withoutComment, line: hits[0].idx + 1 };
}

/**
 * Every `actions/checkout` step in `text`, as
 * `{ line, token, persistCredentials, privileged, credentialPersisted }`.
 */
export function checkoutSteps(text, file = '(workflow)') {
  const lines = text.split('\n');
  const steps = [];

  for (let i = 0; i < lines.length; i++) {
    if (!USES_CHECKOUT.test(lines[i])) continue;
    const block = stepBlockAt(lines, i, file);

    const token = soleValue(block, 'token', file);
    const persist = soleValue(block, 'persist-credentials', file);
    const name = soleValue(block, 'name', file);

    // No `token:` means the ambient GITHUB_TOKEN, which is what
    // actions/checkout defaults to.
    const privileged = token !== null && !AMBIENT_TOKENS.has(token.value);
    const disabled = persist !== null && DISABLED.has(persist.value);

    steps.push({
      file,
      line: i + 1,
      name: name === null ? null : unquote(name.value),
      token: token === null ? null : token.value,
      persistCredentials: persist === null ? null : persist.value,
      privileged,
      credentialPersisted: !disabled,
    });
  }

  return steps;
}

/**
 * THE GUARD. Every checkout that is handed a credential other than the ambient
 * `github.token` and does not set `persist-credentials: false`.
 *
 * An empty array is the only passing answer.
 */
export function persistedCredentialViolations(text, file = '(workflow)') {
  return checkoutSteps(text, file).filter((s) => s.privileged && s.credentialPersisted);
}

/**
 * The stricter property this repo actually holds: NO checkout here persists,
 * privileged or not. Nothing in these workflows reads ambient git credentials
 * -- the two steps that push supply their token explicitly -- so a persisted
 * `github.token` would be a live credential sitting next to consumer code for
 * no benefit at all.
 */
export function anyPersistingCheckouts(text, file = '(workflow)') {
  return checkoutSteps(text, file).filter((s) => s.credentialPersisted);
}

export function describeViolation(v) {
  return `${v.file}:${v.line} (${v.name ?? 'unnamed step'}) token=${v.token} `
    + `persist-credentials=${v.persistCredentials ?? '<absent, defaults to true>'}`;
}
