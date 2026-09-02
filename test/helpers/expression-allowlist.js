// The named exceptions for the repo-wide `${{ }}` guarantee in
// `raw-expression-scan.js`. Data only -- no logic lives here.
//
// Every `${{ }}` occurrence in every file under `.github/workflows/` needs an
// entry, and there are 42 occurrences across 36 (line, expression) pairs today.
// That is not a burden being tolerated, it is the design: an expression with no
// entry reds, so adding one to a workflow forces a reviewer to write down what
// it is and why it is safe. The allowlist IS the review artifact.
//
// Each entry pins four things:
//
//   line         the EXACT source line, trimmed, that carries the expression.
//                Pinning the step alone let an exemption follow its expression
//                into an `eval "..."` wrapper, or into a `#` comment left
//                behind by the very fix that closed the sink -- both measured
//                green (abofs/stonyx-workflows#37, bypass 4 and NEW-5).
//   expression   the expression itself, so a line rewritten around a different
//                expression is not covered by the old entry.
//   occurrences  how many times it appears on that line across the file, so a
//                second copy is not free.
//   why          what the expression is, and why it is safe HERE. Held to
//                account mechanically: `entryShapeProblems` refuses a `why`
//                shorter than 60 characters or one that names none of its own
//                expression's references, so a generic reason cannot be pasted
//                across the file.
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
      expression: '${{ secrets.CASCADE_PAT }}',
      occurrences: 1,
      why: 'secrets.CASCADE_PAT is an org-level secret, not a consumer-controlled string, and its destination '
        + 'is the `token:` input of actions/checkout. An action input is consumed as a value by the action, '
        + 'never as shell or JS source.',
    },
    {
      line: 'PACKAGE_NAME: ${{ inputs.package-name }}',
      expression: '${{ inputs.package-name }}',
      occurrences: 1,
      why: 'inputs.package-name IS consumer-controlled -- it originates in a consumer package.json. It is safe '
        + 'here because its destination is a step `env:` value, which is exactly the remediation #32 applied: '
        + 'the github-script body below reads process.env.PACKAGE_NAME and carries no expression at all.',
    },
    {
      line: 'PUBLISHED_VERSION: ${{ inputs.published-version }}',
      expression: '${{ inputs.published-version }}',
      occurrences: 1,
      why: 'inputs.published-version is consumer-controlled and reaches a step `env:` value, not program text. '
        + 'Same #32 remediation as PACKAGE_NAME on the line above: the dispatch script reads it from '
        + 'process.env and validates it before use.',
    },
    {
      line: 'github-token: ${{ secrets.CASCADE_PAT }}',
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
      expression: '${{ inputs.pnpm-version }}',
      occurrences: 1,
      why: 'inputs.pnpm-version is a workflow_call input reaching the `version:` input of pnpm/action-setup. '
        + 'An action input, not program text: the action receives it as a value and this workflow builds no '
        + 'shell string from it.',
    },
    {
      line: 'node-version: ${{ inputs.node-version }}',
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
      expression: '${{ jobs.publish.outputs.published-version }}',
      occurrences: 1,
      why: 'jobs.publish.outputs.published-version is this workflow plumbing its own job output out through a '
        + 'workflow_call `outputs:` declaration. The value never enters a run: or script: body here; what the '
        + 'CALLER does with it is the caller workflow\'s own sweep to answer for.',
    },
    {
      line: 'value: ${{ jobs.publish.outputs.package-name }}',
      expression: '${{ jobs.publish.outputs.package-name }}',
      occurrences: 1,
      why: 'jobs.publish.outputs.package-name, same workflow_call `outputs:` plumbing one declaration down. '
        + 'A declared output value, not program text.',
    },
    {
      line: 'value: ${{ jobs.publish.outputs.version-channel }}',
      expression: '${{ jobs.publish.outputs.version-channel }}',
      occurrences: 1,
      why: 'jobs.publish.outputs.version-channel, the third of three workflow_call `outputs:` declarations. '
        + 'A declared output value, not program text.',
    },
    {
      line: 'published-version: ${{ steps.package-version.outputs.version }}',
      expression: '${{ steps.package-version.outputs.version }}',
      occurrences: 1,
      why: 'steps.package-version.outputs.version lifted from a step output to a job output. The producing '
        + 'step validates it as a semver string before writing $GITHUB_OUTPUT, and a job `outputs:` mapping is '
        + 'not program text.',
    },
    {
      line: 'package-name: ${{ steps.package-name.outputs.name }}',
      expression: '${{ steps.package-name.outputs.name }}',
      occurrences: 1,
      why: 'steps.package-name.outputs.name lifted from a step output to a job output. The producing step '
        + 'enforces the npm name grammar before writing it, and a job `outputs:` mapping is not program text.',
    },
    {
      line: 'version-channel: ${{ steps.version-type.outputs.type }}',
      expression: '${{ steps.version-type.outputs.type }}',
      occurrences: 1,
      why: 'steps.version-type.outputs.type lifted to a job output. The producing step writes one of a fixed '
        + 'set of channel keywords, and a job `outputs:` mapping is not program text.',
    },
    {
      line: "ref: ${{ github.event_name == 'pull_request' && github.head_ref || github.ref }}",
      expression: "${{ github.event_name == 'pull_request' && github.head_ref || github.ref }}",
      occurrences: 1,
      why: 'A branch selector built from github.event_name, github.head_ref and github.ref -- all runner '
        + 'context, none of them a workflow_call input. Its destination is the `ref:` input of '
        + 'actions/checkout, which is an action input rather than shell source.',
    },
    {
      line: "token: ${{ (inputs.cascade-source != '' && secrets.CASCADE_PAT) || github.token }}",
      expression: "${{ (inputs.cascade-source != '' && secrets.CASCADE_PAT) || github.token }}",
      occurrences: 1,
      why: 'inputs.cascade-source is consumer-controlled but is used only as a boolean test; the two values '
        + 'that can be SELECTED are secrets.CASCADE_PAT and github.token, neither of which a consumer can '
        + 'write. The result is the `token:` input of actions/checkout, not program text.',
    },
    {
      line: 'version: ${{ inputs.pnpm-version }}',
      expression: '${{ inputs.pnpm-version }}',
      occurrences: 1,
      why: 'inputs.pnpm-version reaching pnpm/action-setup\'s `version:` input in the publish job. An action '
        + 'input; this file never builds a shell string from it.',
    },
    {
      line: 'node-version: ${{ inputs.node-version }}',
      expression: '${{ inputs.node-version }}',
      occurrences: 1,
      why: 'inputs.node-version reaching actions/setup-node\'s `node-version:` input in the publish job. An '
        + 'action input; this file never builds a shell string from it.',
    },
    {
      line: "run: pnpm install ${{ inputs.cascade-source != '' && '--no-frozen-lockfile' || '--frozen-lockfile' }}",
      expression: "${{ inputs.cascade-source != '' && '--no-frozen-lockfile' || '--frozen-lockfile' }}",
      occurrences: 1,
      why: 'THE ONE EXPRESSION IN A run: BODY THAT IS NOT A SINK. inputs.cascade-source is consumer-controlled '
        + 'and this IS shell source, but the expression cannot evaluate to consumer text: both arms are fixed '
        + 'string literals (--no-frozen-lockfile, --frozen-lockfile) and the input is only the boolean that '
        + 'picks between them. Changing either arm to anything that is not a literal breaks this reasoning.',
    },
    {
      line: 'CASCADE_SOURCE: ${{ inputs.cascade-source }}',
      expression: '${{ inputs.cascade-source }}',
      occurrences: 1,
      why: 'inputs.cascade-source is consumer-controlled and reaches a step `env:` value. That is #32\'s '
        + 'remediation for this step: the run: body below reads "$CASCADE_SOURCE" as a quoted variable '
        + 'expansion and never splices the input into shell source.',
    },
    {
      line: 'CUSTOM_VERSION: ${{ inputs.custom-version }}',
      expression: '${{ inputs.custom-version }}',
      occurrences: 2,
      why: 'inputs.custom-version is a consumer dispatch input, passed through a step `env:` value in the two '
        + 'steps that need it (version-type determination, and the custom bump). Both read it from '
        + 'process.env and prove it is a version before use; neither interpolates it into program text.',
    },
    {
      line: 'VERSION_TYPE: ${{ inputs.version-type }}',
      expression: '${{ inputs.version-type }}',
      occurrences: 1,
      why: 'inputs.version-type is consumer-controlled and reaches a step `env:` value, per #32. The run: body '
        + 'compares "$VERSION_TYPE" against a fixed keyword set rather than executing it.',
    },
    {
      line: 'EVENT_NAME: ${{ github.event_name }}',
      expression: '${{ github.event_name }}',
      occurrences: 1,
      why: 'github.event_name is runner context with a small fixed vocabulary, not consumer input, and it '
        + 'reaches a step `env:` value rather than shell source. Passed through env for consistency with the '
        + 'consumer-controlled values beside it.',
    },
    {
      line: 'GIT_REF: ${{ github.ref }}',
      expression: '${{ github.ref }}',
      occurrences: 1,
      why: 'github.ref is runner context, not a workflow_call input, and reaches a step `env:` value. A ref '
        + 'name can contain shell-active bytes, which is exactly why it is passed through env and read as '
        + '"$GIT_REF" rather than interpolated into the run: body.',
    },
    {
      line: 'WORKFLOW_SHA: ${{ job.workflow_sha }}',
      expression: '${{ job.workflow_sha }}',
      occurrences: 1,
      why: 'job.workflow_sha is runner context -- the commit of the reusable workflow itself -- and reaches a '
        + 'step `env:` value. The run: body refuses to continue when "$WORKFLOW_SHA" is empty rather than '
        + 'falling back to a moving ref.',
    },
    {
      line: 'ref: ${{ steps.workflows-ref.outputs.sha }}',
      expression: '${{ steps.workflows-ref.outputs.sha }}',
      occurrences: 1,
      why: 'steps.workflows-ref.outputs.sha is the pinned stonyx-workflows commit produced by the step above, '
        + 'reaching the `ref:` input of actions/checkout. An action input, and the value is a SHA this '
        + 'workflow derived, not consumer text.',
    },
    {
      line: 'PKG_NAME: ${{ steps.package-name.outputs.name }}',
      expression: '${{ steps.package-name.outputs.name }}',
      occurrences: 2,
      why: 'steps.package-name.outputs.name is consumer-derived, and it reaches a step `env:` value in the '
        + 'alpha and beta version steps. Both node -e programs read process.env.PKG_NAME and pass it to '
        + 'execFileSync as an argv element -- never spliced into the program text, never into a command line.',
    },
    {
      line: 'VERSION_TYPE: ${{ steps.version-type.outputs.type }}',
      expression: '${{ steps.version-type.outputs.type }}',
      occurrences: 1,
      why: 'steps.version-type.outputs.type is one of a fixed keyword set produced by an earlier step in this '
        + 'workflow, reaching a step `env:` value. The run: body passes "$VERSION_TYPE" to pnpm version as a '
        + 'quoted argument.',
    },
    {
      line: 'BRANCH: ${{ github.ref_name }}',
      expression: '${{ github.ref_name }}',
      occurrences: 1,
      why: 'github.ref_name reaches a step `env:` value. A branch name may contain a double quote, so '
        + 'interpolating it into this step\'s shell source was a push-access injection in every consumer repo '
        + '(#32); passing it through env and reading "$BRANCH" is that fix.',
    },
    {
      line: 'PUBLISHED_VERSION: ${{ steps.package-version.outputs.version }}',
      expression: '${{ steps.package-version.outputs.version }}',
      occurrences: 3,
      why: 'steps.package-version.outputs.version reaching a step `env:` value in the three steps that commit, '
        + 'tag and comment. The producing step validates it as semver before writing $GITHUB_OUTPUT, and each '
        + 'consumer reads "$PUBLISHED_VERSION" or process.env rather than interpolating it.',
    },
    {
      line: 'tag_name: v${{ steps.package-version.outputs.version }}',
      expression: '${{ steps.package-version.outputs.version }}',
      occurrences: 2,
      why: 'steps.package-version.outputs.version forming the `tag_name:` input of softprops/action-gh-release '
        + 'in the beta and stable release steps. An action input rather than program text, and the value is a '
        + 'semver string this workflow validated.',
    },
    {
      line: 'name: v${{ steps.package-version.outputs.version }}',
      expression: '${{ steps.package-version.outputs.version }}',
      occurrences: 2,
      why: 'The same validated steps.package-version.outputs.version forming the `name:` input of '
        + 'softprops/action-gh-release in the beta and stable release steps. An action input, not program text.',
    },
    {
      line: 'PACKAGE_NAME: ${{ steps.package-name.outputs.name }}',
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
      expression: '${{ inputs.pnpm-version }}',
      occurrences: 1,
      why: 'inputs.pnpm-version reaching pnpm/action-setup\'s `version:` input in the audit job. An action '
        + 'input, not program text, and unrelated to the open sink recorded below.',
    },
    {
      line: 'node-version: ${{ inputs.node-version }}',
      expression: '${{ inputs.node-version }}',
      occurrences: 1,
      why: 'inputs.node-version reaching actions/setup-node\'s `node-version:` input in the audit job. An '
        + 'action input, not program text, and unrelated to the open sink recorded below.',
    },
    {
      line: 'run: pnpm audit --audit-level ${{ inputs.audit-level }}',
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
      expression: '${{ github.event_name }}',
      occurrences: 1,
      why: 'github.event_name is runner context with a small fixed vocabulary, forming half of a `concurrency:` '
        + 'group key. A concurrency group is an identifier GitHub compares for equality; it is never executed '
        + 'and there is no shell or JS body in this file that reads it.',
    },
    {
      line: 'group: self-ci-${{ github.event_name }}-${{ github.head_ref || github.ref }}',
      expression: '${{ github.head_ref || github.ref }}',
      occurrences: 1,
      why: 'github.head_ref falling back to github.ref, forming the other half of the same `concurrency:` '
        + 'group key. Runner context rather than consumer input, and a group key is compared for equality, '
        + 'never executed.',
    },
  ],
};
