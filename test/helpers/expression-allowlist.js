// The named exceptions for the repo-wide `${{ }}` guarantee in
// `raw-expression-scan.js`. Data only -- no logic lives here.
//
// Every `${{ }}` occurrence in every file under `.github/workflows/` needs an
// entry, keyed on the four-part `(file, context, line, expression)` -- there is
// deliberately no count written down here. The totals were snapshotted in this
// comment and asserted as the literals `42` and `36`; both are now DERIVED and
// cross-checked three ways in `test/raw-sweep-test.js`, because a number
// pinned in a test is a thing a contributor learns to bump when the guard reds
// (#37, Phase 2 W-1, Phase 5 N-N2).
// That is not a burden being tolerated, it is the design: an expression with no
// entry reds, so adding one to a workflow forces a reviewer to write down what
// it is and why it is safe. The allowlist IS the review artifact.
//
// Each entry pins five things:
//
//   line         the EXACT source line, trimmed, that carries the expression.
//                Pinning the step alone let an exemption follow its expression
//                into an `eval "..."` wrapper, or into a `#` comment left
//                behind by the very fix that closed the sink -- both measured
//                green (abofs/stonyx-workflows#37, bypass 4 and NEW-5).
//   context      the CHAIN of keys the line is written under, innermost last --
//                `jobs > dispatch > steps > with`, `on > workflow_call >
//                outputs > package-name`, `concurrency` -- derived from raw
//                text by `structuralContexts`. Copy it out of the failure
//                message; the red prints it verbatim. A link rendered
//                `<key> (scalar)` marks a position that cannot legitimately
//                open a mapping, so nothing under one can ever match an entry.
//                It has TWO causes, and the difference matters when you are
//                staring at an unexpected red: either the key already carries
//                a value, which in YAML cannot also carry children; or the
//                line BEGAN inside an open quoted scalar or flow collection
//                and is therefore data, whatever it spells. The second is the
//                one that surprises people. If you have just written a
//                legitimate multi-line double-quoted or single-quoted value in
//                a workflow, every line after the opener is inside it, and an
//                expression on one of those lines will red as an entry
//                mismatch rather than saying "you are inside a scalar" --
//                there is deliberately no allowlist for that, because the
//                shape has never yet occurred in these five files. Rewrite it
//                as a block scalar (`|` or `>`), which is idiomatic here and
//                which the walk correctly ignores.
//                The trimmed line carries no context of its own, so an entry
//                keyed on it alone approves the characters rather than the
//                position: relocating `version: ${{ inputs.pnpm-version }}`
//                byte-for-byte out of `pnpm/action-setup`'s `with:` and into a
//                `run:` body left the guarantee reporting nothing, at 256 pass
//                / 0 fail, with a `workflow_call` input reaching bash (#37,
//                Phase 3 §4; Phase 1 F5, independently, with
//                `secrets.CASCADE_PAT`).
//                It was the NEAREST key until round 5. That was forgeable from
//                inside the sink -- a `with:` line written into a `run:` body
//                made the payload supply its own context, 282 pass / 0 fail
//                with the org PAT in a shell body (#37, Phase 1 F7, Phase 3
//                §4). A chain closes every scalar style whose content must be
//                more indented than its own key line -- literal block `|`,
//                folded block `>`, plain multi-line -- which is THREE of the
//                five, measured against Psych 5.3.1 / libyaml 0.2.5. This note
//                said "four of the five", and named the remainder as "a
//                multi-line FLOW scalar"; both were wrong, and wrong in the
//                direction that makes a fail-open gap read smaller than it was
//                (#37/PR #38, Phase 5 round 5 N5-1). The two styles the chain
//                alone cannot close are the QUOTED ones, and the flow
//                collections alongside them.
//                Those are closed too, as of round 6, by a different mechanism
//                in the same file: `walk` carries quote and flow-depth state
//                ACROSS the line break, so a line that began inside an open
//                scalar is data and cannot open a mapping. Before it, a forged
//                `with:` DEDENTED to the enclosing key's own content indent
//                derived a chain byte-identical to the line it replaced --
//                294 pass / 0 fail with the org PAT in a live shell command
//                line, in all three styles, reaching 34 of the 36 entries in
//                this file by a mechanical transform. Re-measured on this
//                tree, each of the three is 299 pass / 6 fail.
//                So: ALL FIVE scalar styles and both flow collections are
//                closed against context forgery, and eight spellings of it are
//                committed as cases in `test/raw-sweep-test.js`. What is still
//                open is not a YAML shape at all -- the key does not model WHO
//                RECEIVES the input, so an entry re-added byte-identically
//                under a different `uses:` still matches. README.md's *Honest
//                gaps* carries that one; no parser closes it either.
//   expression   the expression itself, so a line rewritten around a different
//                expression is not covered by the old entry.
//   occurrences  how many times it appears on that line across the file, so a
//                second copy is not free.
//   why          what the expression is, and why it is safe HERE. `why` is held
//                to a FLOOR mechanically -- `entryShapeProblems` refuses one
//                shorter than 60 characters, or one naming none of its own
//                expression's references -- and that floor stops bulk paste,
//                not bad reasoning. Well-formed noise passes it (measured: all
//                36 reasons replaced, 256 pass / 0 fail, #37 Phase 4 NEW-4).
//                What holds a `why` to account is the reviewer reading it in
//                the diff; the floor only guarantees there is something to
//                read.
//
// WHAT THE KEY STILL DOES NOT ENCODE. It pins WHICH LINE, not WHAT CONSUMES
// the line's value. Swapping `uses: actions/checkout@v4` for a third-party
// action in `cascade.yml` leaves `token: ${{ secrets.CASCADE_PAT }}` and its
// context byte-identical, hands the org secret to that action, and is green --
// measured at 256 pass / 0 fail (#37, Phase 4 NEW-5/N17). Roughly twenty of the
// reasons below are justified by DESTINATION, and no check re-derives a
// destination. Reviewing a `uses:` change is a human obligation here.
//
// The convention every `why` is measured against is #32's one sentence: no
// consumer-controlled string ever becomes program text or a shell-string
// fragment. An expression is safe when it is not consumer-controlled, when it
// resolves to a fixed literal, or when its destination is an action input or a
// step `env:` value rather than a `run:`/`script:` body. Exactly one entry
// below does not meet that bar, and it says so.
//
// NOT SAFE BY VIRTUE OF BEING HERE. A `#` comment inside a `run:` body is a
// LIVE SINK, not documentation: the runner substitutes `${{ }}` into the script
// TEXTUALLY before bash parses it, and a `workflow_call` input can contain a
// newline. Measured under `bash --noprofile --norc -e`: exit 0, canary written.
// So an entry may not be justified on the grounds that its expression sits in a
// comment.

export const EXPRESSION_ALLOWLIST = {
  'cascade.yml': [
    {
      line: 'token: ${{ secrets.CASCADE_PAT }}',
      context: 'jobs > dispatch > steps > with',
      expression: '${{ secrets.CASCADE_PAT }}',
      occurrences: 1,
      why: 'secrets.CASCADE_PAT is an org-level secret, not a consumer-controlled string, and its destination '
        + 'is the `token:` input of actions/checkout. An action input is consumed as a value by the action, '
        + 'never as shell or JS source.',
    },
    {
      line: 'PACKAGE_NAME: ${{ inputs.package-name }}',
      context: 'jobs > dispatch > steps > env',
      expression: '${{ inputs.package-name }}',
      occurrences: 1,
      why: 'inputs.package-name IS consumer-controlled -- it originates in a consumer package.json. It is safe '
        + 'here because its destination is a step `env:` value, which is exactly the remediation #32 applied: '
        + 'the github-script body below reads process.env.PACKAGE_NAME and carries no expression at all.',
    },
    {
      line: 'PUBLISHED_VERSION: ${{ inputs.published-version }}',
      context: 'jobs > dispatch > steps > env',
      expression: '${{ inputs.published-version }}',
      occurrences: 1,
      why: 'inputs.published-version is consumer-controlled and reaches a step `env:` value, not program text. '
        + 'Same #32 remediation as PACKAGE_NAME on the line above: the dispatch script reads it from '
        + 'process.env and validates it before use.',
    },
    {
      line: 'github-token: ${{ secrets.CASCADE_PAT }}',
      context: 'jobs > dispatch > steps > with',
      expression: '${{ secrets.CASCADE_PAT }}',
      occurrences: 1,
      why: 'The same org secret one line down, as the `github-token:` input of actions/github-script. '
        + 'secrets.CASCADE_PAT is not consumer-controlled, and an action input is not program text -- this is '
        + 'the credential the script step runs with, supplied the only way GitHub Actions supplies it.',
    },
  ],

  'ci.yml': [
    {
      line: 'version: ${{ inputs.pnpm-version }}',
      context: 'jobs > test > steps > with',
      expression: '${{ inputs.pnpm-version }}',
      occurrences: 1,
      why: 'inputs.pnpm-version is a workflow_call input reaching the `version:` input of pnpm/action-setup. '
        + 'An action input, not program text: the action receives it as a value and this workflow builds no '
        + 'shell string from it.',
    },
    {
      line: 'node-version: ${{ inputs.node-version }}',
      context: 'jobs > test > steps > with',
      expression: '${{ inputs.node-version }}',
      occurrences: 1,
      why: 'inputs.node-version is a workflow_call input reaching the `node-version:` input of '
        + 'actions/setup-node. An action input, not program text; nothing in this file interpolates it into a '
        + 'run: body.',
    },
  ],

  'npm-publish.yml': [
    {
      line: 'value: ${{ jobs.publish.outputs.published-version }}',
      context: 'on > workflow_call > outputs > published-version',
      expression: '${{ jobs.publish.outputs.published-version }}',
      occurrences: 1,
      why: 'jobs.publish.outputs.published-version is this workflow plumbing its own job output out through a '
        + 'workflow_call `outputs:` declaration. The value never enters a run: or script: body here; what the '
        + 'CALLER does with it is the caller workflow\'s own sweep to answer for.',
    },
    {
      line: 'value: ${{ jobs.publish.outputs.package-name }}',
      context: 'on > workflow_call > outputs > package-name',
      expression: '${{ jobs.publish.outputs.package-name }}',
      occurrences: 1,
      why: 'jobs.publish.outputs.package-name, same workflow_call `outputs:` plumbing one declaration down. '
        + 'A declared output value, not program text.',
    },
    {
      line: 'value: ${{ jobs.publish.outputs.version-channel }}',
      context: 'on > workflow_call > outputs > version-channel',
      expression: '${{ jobs.publish.outputs.version-channel }}',
      occurrences: 1,
      why: 'jobs.publish.outputs.version-channel, the third of three workflow_call `outputs:` declarations. '
        + 'A declared output value, not program text.',
    },
    {
      line: 'published-version: ${{ steps.package-version.outputs.version }}',
      context: 'jobs > publish > outputs',
      expression: '${{ steps.package-version.outputs.version }}',
      occurrences: 1,
      why: 'steps.package-version.outputs.version lifted from a step output to a job output. The producing '
        + 'step validates it as a semver string before writing $GITHUB_OUTPUT, and a job `outputs:` mapping is '
        + 'not program text.',
    },
    {
      line: 'package-name: ${{ steps.package-name.outputs.name }}',
      context: 'jobs > publish > outputs',
      expression: '${{ steps.package-name.outputs.name }}',
      occurrences: 1,
      why: 'steps.package-name.outputs.name lifted from a step output to a job output. The producing step '
        + 'enforces the npm name grammar before writing it, and a job `outputs:` mapping is not program text.',
    },
    {
      line: 'version-channel: ${{ steps.version-type.outputs.type }}',
      context: 'jobs > publish > outputs',
      expression: '${{ steps.version-type.outputs.type }}',
      occurrences: 1,
      why: 'steps.version-type.outputs.type lifted to a job output. The producing step writes one of a fixed '
        + 'set of channel keywords, and a job `outputs:` mapping is not program text.',
    },
    {
      line: "ref: ${{ github.event_name == 'pull_request' && github.head_ref || github.ref }}",
      context: 'jobs > publish > steps > with',
      expression: "${{ github.event_name == 'pull_request' && github.head_ref || github.ref }}",
      occurrences: 1,
      why: 'A branch selector built from github.event_name, github.head_ref and github.ref -- all runner '
        + 'context, none of them a workflow_call input. Its destination is the `ref:` input of '
        + 'actions/checkout, which is an action input rather than shell source.',
    },
    {
      line: "token: ${{ (inputs.cascade-source != '' && secrets.CASCADE_PAT) || github.token }}",
      context: 'jobs > publish > steps > with',
      expression: "${{ (inputs.cascade-source != '' && secrets.CASCADE_PAT) || github.token }}",
      occurrences: 1,
      why: 'inputs.cascade-source is consumer-controlled but is used only as a boolean test; the two values '
        + 'that can be SELECTED are secrets.CASCADE_PAT and github.token, neither of which a consumer can '
        + 'write. The result is the `token:` input of actions/checkout, not program text.',
    },
    {
      line: 'version: ${{ inputs.pnpm-version }}',
      context: 'jobs > publish > steps > with',
      expression: '${{ inputs.pnpm-version }}',
      occurrences: 1,
      why: 'inputs.pnpm-version reaching pnpm/action-setup\'s `version:` input in the publish job. An action '
        + 'input; this file never builds a shell string from it.',
    },
    {
      line: 'node-version: ${{ inputs.node-version }}',
      context: 'jobs > publish > steps > with',
      expression: '${{ inputs.node-version }}',
      occurrences: 1,
      why: 'inputs.node-version reaching actions/setup-node\'s `node-version:` input in the publish job. An '
        + 'action input; this file never builds a shell string from it.',
    },
    {
      line: "run: pnpm install ${{ inputs.cascade-source != '' && '--no-frozen-lockfile' || '--frozen-lockfile' }}",
      context: 'jobs > publish > steps',
      expression: "${{ inputs.cascade-source != '' && '--no-frozen-lockfile' || '--frozen-lockfile' }}",
      occurrences: 1,
      why: 'THE ONE EXPRESSION IN A run: BODY THAT IS NOT A SINK. inputs.cascade-source is consumer-controlled '
        + 'and this IS shell source, but the expression cannot evaluate to consumer text: both arms are fixed '
        + 'string literals (--no-frozen-lockfile, --frozen-lockfile) and the input is only the boolean that '
        + 'picks between them. Changing either arm to anything that is not a literal breaks this reasoning.',
    },
    {
      line: 'CASCADE_SOURCE: ${{ inputs.cascade-source }}',
      context: 'jobs > publish > steps > env',
      expression: '${{ inputs.cascade-source }}',
      occurrences: 1,
      why: 'inputs.cascade-source is consumer-controlled and reaches a step `env:` value. That is #32\'s '
        + 'remediation for this step: the run: body below reads "$CASCADE_SOURCE" as a quoted variable '
        + 'expansion and never splices the input into shell source.',
    },
    {
      line: 'CUSTOM_VERSION: ${{ inputs.custom-version }}',
      context: 'jobs > publish > steps > env',
      expression: '${{ inputs.custom-version }}',
      occurrences: 2,
      why: 'inputs.custom-version is a consumer dispatch input, passed through a step `env:` value in the two '
        + 'steps that need it (version-type determination, and the custom bump). Both read it from '
        + 'process.env and prove it is a version before use; neither interpolates it into program text.',
    },
    {
      line: 'VERSION_TYPE: ${{ inputs.version-type }}',
      context: 'jobs > publish > steps > env',
      expression: '${{ inputs.version-type }}',
      occurrences: 1,
      why: 'inputs.version-type is consumer-controlled and reaches a step `env:` value, per #32. The run: body '
        + 'compares "$VERSION_TYPE" against a fixed keyword set rather than executing it.',
    },
    {
      line: 'EVENT_NAME: ${{ github.event_name }}',
      context: 'jobs > publish > steps > env',
      expression: '${{ github.event_name }}',
      occurrences: 1,
      why: 'github.event_name is runner context with a small fixed vocabulary, not consumer input, and it '
        + 'reaches a step `env:` value rather than shell source. Passed through env for consistency with the '
        + 'consumer-controlled values beside it.',
    },
    {
      line: 'GIT_REF: ${{ github.ref }}',
      context: 'jobs > publish > steps > env',
      expression: '${{ github.ref }}',
      occurrences: 1,
      why: 'github.ref is runner context, not a workflow_call input, and reaches a step `env:` value. A ref '
        + 'name can contain shell-active bytes, which is exactly why it is passed through env and read as '
        + '"$GIT_REF" rather than interpolated into the run: body.',
    },
    {
      line: 'WORKFLOW_SHA: ${{ job.workflow_sha }}',
      context: 'jobs > publish > steps > env',
      expression: '${{ job.workflow_sha }}',
      occurrences: 1,
      why: 'job.workflow_sha is runner context -- the commit of the reusable workflow itself -- and reaches a '
        + 'step `env:` value. The run: body refuses to continue when "$WORKFLOW_SHA" is empty rather than '
        + 'falling back to a moving ref.',
    },
    {
      line: 'ref: ${{ steps.workflows-ref.outputs.sha }}',
      context: 'jobs > publish > steps > with',
      expression: '${{ steps.workflows-ref.outputs.sha }}',
      occurrences: 1,
      why: 'steps.workflows-ref.outputs.sha is the pinned stonyx-workflows commit produced by the step above, '
        + 'reaching the `ref:` input of actions/checkout. An action input, and the value is a SHA this '
        + 'workflow derived, not consumer text.',
    },
    {
      line: 'PKG_NAME: ${{ steps.package-name.outputs.name }}',
      context: 'jobs > publish > steps > env',
      expression: '${{ steps.package-name.outputs.name }}',
      occurrences: 2,
      why: 'steps.package-name.outputs.name is consumer-derived, and it reaches a step `env:` value in the '
        + 'alpha and beta version steps. Both node -e programs read process.env.PKG_NAME and pass it to '
        + 'execFileSync as an argv element -- never spliced into the program text, never into a command line.',
    },
    {
      line: 'VERSION_TYPE: ${{ steps.version-type.outputs.type }}',
      context: 'jobs > publish > steps > env',
      expression: '${{ steps.version-type.outputs.type }}',
      occurrences: 1,
      why: 'steps.version-type.outputs.type is one of a fixed keyword set produced by an earlier step in this '
        + 'workflow, reaching a step `env:` value. The run: body passes "$VERSION_TYPE" to pnpm version as a '
        + 'quoted argument.',
    },
    {
      line: 'BRANCH: ${{ github.ref_name }}',
      context: 'jobs > publish > steps > env',
      expression: '${{ github.ref_name }}',
      occurrences: 1,
      why: 'github.ref_name reaches a step `env:` value. A branch name may contain a double quote, so '
        + 'interpolating it into this step\'s shell source was a push-access injection in every consumer repo '
        + '(#32); passing it through env and reading "$BRANCH" is that fix.',
    },
    {
      line: 'PUBLISHED_VERSION: ${{ steps.package-version.outputs.version }}',
      context: 'jobs > publish > steps > env',
      expression: '${{ steps.package-version.outputs.version }}',
      occurrences: 3,
      why: 'steps.package-version.outputs.version reaching a step `env:` value in the three steps that commit, '
        + 'tag and comment. The producing step validates it as semver before writing $GITHUB_OUTPUT, and each '
        + 'consumer reads "$PUBLISHED_VERSION" or process.env rather than interpolating it.',
    },
    {
      line: 'tag_name: v${{ steps.package-version.outputs.version }}',
      context: 'jobs > publish > steps > with',
      expression: '${{ steps.package-version.outputs.version }}',
      occurrences: 2,
      why: 'steps.package-version.outputs.version forming the `tag_name:` input of softprops/action-gh-release '
        + 'in the beta and stable release steps. An action input rather than program text, and the value is a '
        + 'semver string this workflow validated.',
    },
    {
      line: 'name: v${{ steps.package-version.outputs.version }}',
      context: 'jobs > publish > steps > with',
      expression: '${{ steps.package-version.outputs.version }}',
      occurrences: 2,
      why: 'The same validated steps.package-version.outputs.version forming the `name:` input of '
        + 'softprops/action-gh-release in the beta and stable release steps. An action input, not program text.',
    },
    {
      line: 'PACKAGE_NAME: ${{ steps.package-name.outputs.name }}',
      context: 'jobs > publish > steps > env',
      expression: '${{ steps.package-name.outputs.name }}',
      occurrences: 1,
      why: 'steps.package-name.outputs.name reaching a step `env:` value on the PR-comment step. The '
        + 'github-script body reads process.env.PACKAGE_NAME and carries no expression of its own -- which is '
        + 'the property `scriptSweepProblems` exists to keep true.',
    },
  ],

  'security-audit.yml': [
    {
      line: 'version: ${{ inputs.pnpm-version }}',
      context: 'jobs > audit > steps > with',
      expression: '${{ inputs.pnpm-version }}',
      occurrences: 1,
      why: 'inputs.pnpm-version reaching pnpm/action-setup\'s `version:` input in the audit job. An action '
        + 'input, not program text, and unrelated to the open sink recorded below.',
    },
    {
      line: 'node-version: ${{ inputs.node-version }}',
      context: 'jobs > audit > steps > with',
      expression: '${{ inputs.node-version }}',
      occurrences: 1,
      why: 'inputs.node-version reaching actions/setup-node\'s `node-version:` input in the audit job. An '
        + 'action input, not program text, and unrelated to the open sink recorded below.',
    },
    {
      line: 'run: pnpm audit --audit-level ${{ inputs.audit-level }}',
      context: 'jobs > audit > steps',
      expression: '${{ inputs.audit-level }}',
      occurrences: 1,
      why: 'KNOWN OPEN SINK, tracked as abofs/stonyx-workflows#34. inputs.audit-level is a workflow_call input '
        + 'interpolated straight into a shell run: body -- the same defect class this suite closes, in a third '
        + 'file outside #32\'s two-file scope. Reported and tracked, NOT FIXED HERE. When #34 lands, delete '
        + 'this entry; the entry going dead is how the suite proves the sink is really gone.',
    },
  ],

  'self-ci.yml': [
    {
      line: 'group: self-ci-${{ github.event_name }}-${{ github.head_ref || github.ref }}',
      context: 'concurrency',
      expression: '${{ github.event_name }}',
      occurrences: 1,
      why: 'github.event_name is runner context with a small fixed vocabulary, forming half of a `concurrency:` '
        + 'group key. A concurrency group is an identifier GitHub compares for equality; it is never executed '
        + 'and there is no shell or JS body in this file that reads it.',
    },
    {
      line: 'group: self-ci-${{ github.event_name }}-${{ github.head_ref || github.ref }}',
      context: 'concurrency',
      expression: '${{ github.head_ref || github.ref }}',
      occurrences: 1,
      why: 'github.head_ref falling back to github.ref, forming the other half of the same `concurrency:` '
        + 'group key. Runner context rather than consumer input, and a group key is compared for equality, '
        + 'never executed.',
    },
  ],
};

// The named exceptions for the ESCAPE half of the guarantee -- the check that a
// line carries no backslash that could CONSTRUCT an opener the byte scan cannot
// see (`escapeProblems`).
//
// EMPTY TODAY, AND THAT IS THE MEASURED STATE, NOT AN OVERSIGHT: none of the
// five shipped workflows carries a `\x`, `\u`, `\U` or an end-of-line
// backslash. It exists because the check DELIBERATELY OVER-REPORTS and this
// repo's rule is that the way past a check is an entry, never a widened
// pattern. Only a double-quoted scalar processes escapes -- measured against
// libyaml: in a single-quoted, plain, literal-block or folded-block scalar
// `\x24` stays four literal characters -- but deciding which style a line is in
// requires parsing, and all three plausible narrowings were measured turning a
// real constructed opener from 277 pass / 5 fail into 282 / 0 (#37, Phase 4
// NEW-4). So the check fires on every line of every file, and the pressure that
// creates has somewhere to go that is not `CONSTRUCTING_ESCAPES` (#37, Phase 3
// §5c).
//
// Each entry pins three things:
//
//   line     the EXACT source line, trimmed, that carries the backslash.
//   escape   `x`, `u`, `U`, or `(end of line)` for a trailing backslash.
//   why      which scalar style the line is in, and why the escape cannot
//            build an opener there. Held to the same 60-character floor as an
//            expression entry's reason.
//
// A dead entry reds, exactly as a dead expression entry does: an exemption
// whose line is gone must not survive as a standing permission.
export const ESCAPE_ALLOWLIST = {};
