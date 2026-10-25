// An offline evaluator for the GitHub Actions expression subset this repo's
// workflows use in `if:` conditions and `${{ }}` templates: `==`, `!=`, `!`,
// `&&`, `||`, parentheses, string literals, `true`/`false`/`null`, context
// paths, `contains()`, `always()`, `success()`.
//
// GitHub Actions expressions have no offline engine, and a regex over `if:`
// text pins spellings, not behaviour. This evaluator THROWS on anything outside
// the subset rather than guessing. Adding a construct to a workflow `if:` that
// it does not know reds the suites that read it -- extend the evaluator (and
// its truth table in test/cascade-gating-test.js), do not delete the case.
//
// Used by test/cascade-gating-test.js (the job simulator, #60) and
// test/tarball-guard-test.js (the publish-implies-guard property, #60).

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= src.length) throw new Error(`unterminated string literal in expression: ${src}`);
        if (src[j] === "'") {
          if (src[j + 1] === "'") { value += "'"; j += 2; continue; }
          break;
        }
        value += src[j++];
      }
      tokens.push({ type: 'str', value });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '&&', '||'].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
    if ('()!,'.includes(c)) { tokens.push({ type: 'op', value: c }); i++; continue; }
    const ident = src.slice(i).match(/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*/);
    if (ident) { tokens.push({ type: 'ident', value: ident[0] }); i += ident[0].length; continue; }
    throw new Error(`the test evaluator does not understand ${JSON.stringify(src.slice(i))} in expression: ${src}`);
  }
  return tokens;
}

// name -> [arity, implementation]. Arity is exact: GitHub rejects a wrong
// argument count at parse time, and silently ignoring an extra argument would
// make `contains(a, 'b', 'zzz')` mean something the workflow does not.
const FUNCTIONS = {
  contains: [2, (haystack, needle) => {
    for (const v of [haystack, needle]) {
      if (typeof v === 'boolean' || (v !== null && typeof v === 'object')) {
        throw new Error(`the test evaluator does not implement contains() over ${JSON.stringify(v)}`);
      }
    }
    return String(haystack ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());
  }],
  // The simulation only ever continues past a step that succeeded, so the
  // status functions are constants here.
  always: [0, () => true],
  success: [0, () => true],
};

export const truthy = (v) => !(v === false || v === null || v === undefined || v === '' || v === 0);

// A JSON-number-shaped string: what GitHub would coerce to a real number.
const NUMERIC = /^\s*-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?\s*$|^\s*0x[0-9a-f]+\s*$/i;

/**
 * `==` as GitHub evaluates it, for the cases this evaluator commits to:
 * string/string (case-insensitive), boolean/boolean, null/null, and
 * null/string where the string is not numeric (null is 0, '' is 0, any other
 * non-numeric string is NaN). Every other mixed-type comparison goes through
 * GitHub's number coercion (`'' == false` is true there, `'true' == true` is
 * false), which this evaluator does not implement -- so it THROWS instead of
 * answering.
 */
function loosely(a, b, src) {
  const kind = (v) => (v === null || v === undefined ? 'null' : typeof v);
  const [ka, kb] = [kind(a), kind(b)];
  if (ka === kb && (ka === 'string' || ka === 'boolean' || ka === 'null')) {
    return ka === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  if ((ka === 'null' && kb === 'string') || (ka === 'string' && kb === 'null')) {
    const str = ka === 'string' ? a : b;
    if (str === '') return true;
    if (!NUMERIC.test(str)) return false;
  }
  throw new Error(
    `the test evaluator does not implement GitHub's number coercion for ${JSON.stringify(a)} == ${JSON.stringify(b)} `
    + `(in: ${src})`,
  );
}

export function evaluate(src, ctx) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (value) => {
    const t = tokens[pos];
    if (!t || (value !== undefined && t.value !== value)) throw new Error(`expected ${value} at token ${pos} in: ${src}`);
    pos++;
    return t;
  };

  function primary() {
    const t = peek();
    if (!t) throw new Error(`unexpected end of expression: ${src}`);
    if (t.type === 'op' && t.value === '(') { take('('); const v = or(); take(')'); return v; }
    if (t.type === 'op' && t.value === '!') { take('!'); return !truthy(primary()); }
    if (t.type === 'str') { pos++; return t.value; }
    if (t.type === 'ident') {
      pos++;
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      if (peek() && peek().value === '(') {
        if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, t.value)) {
          throw new Error(`the test evaluator does not implement ${t.value}() (in: ${src})`);
        }
        const [arity, fn] = FUNCTIONS[t.value];
        take('(');
        const args = [];
        if (!(peek() && peek().value === ')')) {
          args.push(or());
          while (peek() && peek().value === ',') { take(','); args.push(or()); }
        }
        take(')');
        if (args.length !== arity) {
          throw new Error(`${t.value}() takes ${arity} argument(s), got ${args.length} (in: ${src})`);
        }
        return fn(...args);
      }
      return lookup(t.value, ctx, src);
    }
    throw new Error(`unexpected token ${JSON.stringify(t.value)} in: ${src}`);
  }
  function equality() {
    let left = primary();
    while (peek() && (peek().value === '==' || peek().value === '!=')) {
      const op = take().value;
      const right = primary();
      left = op === '==' ? loosely(left, right, src) : !loosely(left, right, src);
    }
    return left;
  }
  function and() {
    let left = equality();
    while (peek() && peek().value === '&&') { take(); const right = equality(); left = truthy(left) ? right : left; }
    return left;
  }
  function or() {
    let left = and();
    while (peek() && peek().value === '||') { take(); const right = and(); left = truthy(left) ? left : right; }
    return left;
  }

  const value = or();
  if (pos !== tokens.length) throw new Error(`trailing tokens in expression: ${src}`);
  return value;
}

const ROOTS = new Set(['github', 'inputs', 'steps', 'secrets', 'job', 'jobs', 'needs']);

function lookup(path, ctx, src) {
  const [root, ...rest] = path.split('.');
  if (!ROOTS.has(root)) throw new Error(`unknown context root ${root} in: ${src}`);
  let value = ctx[root];
  for (const key of rest) {
    if (value === null || value === undefined) return null;
    value = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : null;
  }
  return value ?? null;
}

/** An `if:` value as written in YAML, with the optional `${{ }}` and quotes removed. */
export function conditionSource(raw) {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  const wrapped = s.match(/^\$\{\{([\s\S]*)\}\}$/);
  return (wrapped ? wrapped[1] : s).trim();
}

/** A scalar with `${{ }}` templates in it, as the runner substitutes it. */
export function interpolate(raw, ctx) {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr) => {
    const v = evaluate(expr, ctx);
    return v === null || v === undefined ? '' : String(v);
  });
}
