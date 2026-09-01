/**
 * Version derivation for the Stonyx npm publish pipeline.
 *
 * Lifted verbatim from the `Calculate next alpha version` and
 * `Calculate next beta version` heredocs in
 * `.github/workflows/npm-publish.yml` (lines 182-204 and 213-235 as of
 * main@692d122). Those two blocks were the same nine lines with `alpha` and
 * `beta` swapped; `channel` is the only parameterisation introduced by the
 * lift.
 *
 * This is a LIFT AND SHIFT. The behaviour here -- including its known defects,
 * which are tracked as abofs/stonyx-workflows#23 and #24 -- is intentionally
 * identical to what the heredocs computed. `test/derive-version-test.js` pins
 * that output so #23 and #24 land as visible diffs.
 *
 * Registry I/O stays in the workflow and is passed in as arguments, so this
 * function is pure and testable offline: no network, no filesystem, no clock.
 */

/**
 * @param {object} options
 * @param {string} options.channel        Prerelease channel: 'alpha' or 'beta'.
 * @param {string} options.latestStable   The registry's `dist-tags.latest`, or
 *                                        the local package version when the
 *                                        registry lookup failed.
 * @param {string[]|string} options.allVersions  Every version published for the
 *                                        package. npm returns a bare string
 *                                        rather than an array when only one
 *                                        version exists, so a string is
 *                                        accepted and normalised.
 * @returns {string} The next version for `channel`, e.g. `0.1.1-beta.128`.
 */
export function deriveVersion({ channel, latestStable, allVersions }) {
  // Ensure allVersions is an array (npm returns string if only one version)
  if (!Array.isArray(allVersions)) allVersions = [allVersions];
  const [maj, min, pat] = latestStable.split('.').map(Number);
  const nextPatch = maj + '.' + min + '.' + (pat + 1);
  const prefix = nextPatch + '-' + channel + '.';
  const existing = allVersions
    .filter(v => v.startsWith(prefix))
    .map(v => parseInt(v.slice(prefix.length), 10))
    .filter(n => !isNaN(n));
  const next = existing.length ? Math.max(...existing) + 1 : 0;
  return nextPatch + '-' + channel + '.' + next;
}
