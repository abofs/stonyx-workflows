import { describe, test } from 'node:test';

// Bypasses of the interpolation sweep added by PR #33 (abofs/stonyx-workflows#37).
//
// Five mutations were measured GREEN at 161 pass / 0 fail against `main` @
// e07e185 -- a fully green suite that could not fail. Every one of them ships
// here as a committed case, so the bypass cannot come back.
//
// Scaffold first: one describe per AC, TODO stubs, no assertions yet.

describe('AC1 -- a duplicate step name cannot hide a step from either sweep (#37)', () => {
  test.todo('step names are unique within every workflow file');
  test.todo('M1: a duplicated step name hiding a run: sink reds the run sweep');
  test.todo('M1c: a duplicated step name hiding a script: sink reds the github-script sweep');
  test.todo('the name-taking helpers refuse an ambiguous name instead of returning the first match');
});

describe('AC2 -- folded block scalars are swept, unknown run: headers throw (#37)', () => {
  test.todo('M2: `run: >` carrying an expression reds the sweep');
  test.todo('stepRunBody returns the body for every block-scalar header (| |- |+ > >- >+ and indent digits)');
  test.todo('stepRunBody throws on a run: scalar header it does not understand');
});

describe('AC3 -- an expression containing } is matched, unmatched openers are impossible (#37)', () => {
  test.todo("M3: `${{ format('{0}', inputs.package-name) }}` reds the sweep");
  test.todo('the matcher extracts a brace-carrying expression whole');
  test.todo('the accounting pin reds when the matcher cannot resolve an opener');
});

describe('AC4 -- the allowlist entry dies with its sink (#37)', () => {
  test.todo('M4: #34 fix plus a run-body comment quoting the expression reds twice');
  test.todo('calibration: #34 fix without the comment still reds as a dead entry');
  test.todo('NEW-5: relocating the expression into eval "..." reds the sweep');
  test.todo('an expression on a #-comment line is a live sink, never exempt');
});

describe('AC5 -- the repaired sweep is green on the unmodified workflows (#37)', () => {
  test.todo('every workflow file in .github/workflows/ sweeps clean');
});
