import { describe, test } from 'node:test';

// Committed red/green controls for scripts/check-doc-imports.mjs
// (abofs/stonyx#122, part 1: the checker, merged unwired).

describe('extraction', () => {
  test.todo('extracts import/export ... from of stonyx, stonyx/<sub>, @stonyx/<pkg>, @stonyx/<pkg>/<sub> in JS/TS fences');
  test.todo('ignores non-JS fences and prose');
});

describe('red fixtures', () => {
  test.todo('missing named member');
  test.todo('unexported subpath');
  test.todo('default-name mismatch');
  test.todo('type imported as value');
  test.todo('fenced stonyx import that extracts to 0');
  test.todo('wildcard export pointing at no file');
});

describe('green fixtures', () => {
  test.todo('correct subpath imports');
  test.todo('anonymous default is skipped and counted');
  test.todo('doc with no stonyx imports passes with checked=0');
});
