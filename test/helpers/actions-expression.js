
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

const FUNCTIONS = {
  contains: [2, (haystack, needle) => {
    for (const v of [haystack, needle]) {
      if (typeof v === 'boolean' || (v !== null && typeof v === 'object')) {
        throw new Error(`the test evaluator does not implement contains() over ${JSON.stringify(v)}`);
      }
    }
    return String(haystack ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());
  }],
  always: [0, () => true],
  success: [0, () => true],
};

export const truthy = (v) => !(v === false || v === null || v === undefined || v === '' || v === 0);

const MAYBE_NUMERIC = (str) => str.trim() === '' || /^[0-9+\-.]/.test(str.trim());

function loosely(a, b, src) {
  const kind = (v) => (v === null || v === undefined ? 'null' : typeof v);
  const [ka, kb] = [kind(a), kind(b)];
  if (ka === kb && (ka === 'string' || ka === 'boolean' || ka === 'null')) {
    return ka === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  if ((ka === 'null' && kb === 'string') || (ka === 'string' && kb === 'null')) {
    const str = ka === 'string' ? a : b;
    if (str === '') return true;
    if (!MAYBE_NUMERIC(str)) return false;
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
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      const variant = Object.keys(value).find((k) => k.toLowerCase() === key.toLowerCase());
      if (variant !== undefined) {
        throw new Error(`the test evaluator does not resolve ${key} to ${variant} case-insensitively (in: ${src})`);
      }
      return null;
    }
    value = value[key];
  }
  return value ?? null;
}

export function conditionSource(raw) {
  if (raw.includes('\n')) throw new Error(`the test evaluator reads a one-line if: only: ${JSON.stringify(raw)}`);
  let s = raw.trim();
  if (s.startsWith("'")) throw new Error(`the test evaluator does not read a single-quoted if: ${raw}`);
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) throw new Error(`unclosed double-quoted if: ${raw}`);
    s = s.slice(1, -1);
    if (s.includes('\\')) throw new Error(`the test evaluator does not decode YAML double-quoted escapes: ${raw}`);
  }
  const wrapped = s.match(/^\$\{\{([\s\S]*)\}\}$/);
  return (wrapped ? wrapped[1] : s).trim();
}

export function interpolate(raw, ctx) {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr) => {
    const v = evaluate(expr, ctx);
    return v === null || v === undefined ? '' : String(v);
  });
}
