
const STRUCTURAL_STEPS = /^( *)steps:\s*$/;
const ANY_STEPS = /^\s*(?:-\s+)?["']?steps["']?\s*:/;
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: +(.*))?$/;
const BLOCK = new Set(['|', '|-']);
const FLOW_WORDS = /^\[[\w.*/-]+(?:, [\w.*/-]+)*\]$/;
const STEP_KEYS = ['name', 'id', 'if', 'uses', 'run', 'shell', 'with', 'env', 'working-directory',
  'continue-on-error', 'timeout-minutes'];
const NON_STRING_IF = new RegExp('^(?:null|~|true|false|yes|no|on|off|[-+]?\\.inf|\\.nan|0x[0-9a-f_]+|0o[0-7_]+|0b[01_]+'
  + '|[-+]?(?:[0-9][0-9_:]*(?:\\.[0-9_]*)?|\\.[0-9_]+)(?:e[-+]?[0-9]+)?)$', 'i');

const spaces = (line) => line.match(/^ */)[0].length;

function scalarShape(v) {
  if (v.startsWith('"')) {
    return /^"(?:[^"\\]|\\.)*"$/.test(v)
      ? { shape: 'double' }
      : { why: 'a double-quoted value must close on its own line, with nothing after the closing quote' };
  }
  if (v.startsWith("'")) {
    return /^'(?:[^']|'')*'$/.test(v)
      ? { shape: 'single' }
      : { why: 'a single-quoted value must close on its own line, with nothing after the closing quote' };
  }
  if (/^[[\]{},#&*!|>%@`]/.test(v) || /^[-?:](\s|$)/.test(v)) {
    return { why: 'a plain value may not start with a YAML indicator (flow, comment, anchor, alias, tag, block scalar or reserved character)' };
  }
  if (/\s#/.test(v)) return { why: 'a " #" starts a YAML comment, so the value is not the whole line' };
  if (/:(\s|$)/.test(v)) return { why: 'a ": " inside a plain value is not a plain scalar' };
  return { shape: 'plain' };
}

export function stepShapes(text, file = '<workflow>') {
  const lines = text.split('\n');
  const steps = [];
  const found = [];
  const fileLevel = (i, rule) => found.push({ step: null, line: i, key: null, rule });

  lines.forEach((line, i) => {
    const bad = line.match(/[\x00-\x1F\x7F\u0085\u2028\u2029\uFEFF]|[^\S ]/);
    if (bad) {
      fileLevel(i, `character U+${bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} is a control `
        + 'character or whitespace other than a space; YAML may read it as a line break (CR, NEL, LS, PS) or '
        + 'refuse it as indentation, and this check splits on LF and counts spaces only');
    }
    if (ANY_STEPS.test(line) && !STRUCTURAL_STEPS.test(line)) {
      fileLevel(i, 'a steps: key in a form this check does not read (quoted, commented, on a list item, or with an inline value)');
    }
  });
  if (found.length > 0) return { steps, violations: found.map((v) => format(file, v)) };

  let fileBody = null;
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const ind = spaces(line);
    if (fileBody !== null) {
      if (ind > fileBody) return;
      fileBody = null;
    }
    const content = line.slice(ind);
    if (content.startsWith('#')) return;
    const dashes = content.match(/^(?:-(?: +|$))*/)[0];
    const node = content.slice(dashes.length);
    if (/^(?:run|script): +\|-?$/.test(node)) { fileBody = ind + dashes.length; return; }
    if (/^\?(\s|$)/.test(node)) { fileLevel(i, 'an explicit "? key" is refused'); return; }
    if (/^["']/.test(node)) {
      if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(\s|$)/.test(node)) fileLevel(i, 'a quoted key is refused');
      else if (!scalarShape(node).shape) fileLevel(i, scalarShape(node).why);
      return;
    }
    if (/^[{[]/.test(node)) { fileLevel(i, 'a flow collection ({ or [) is refused'); return; }
    if (/^[!&*]/.test(node)) { fileLevel(i, 'a tag, anchor or alias on a key or list item is refused'); return; }
    const kv = node.match(/^[^\s:#][^:]*?: +(\S.*)$/);
    if (!kv) return;
    const value = kv[1].trimEnd();
    if (/^[{[]/.test(value) && !FLOW_WORDS.test(value)) {
      fileLevel(i, 'a flow collection ({ or [) is refused; only a one-line [word, word] list is read');
    } else if (/^[!&*]/.test(value)) {
      fileLevel(i, 'a tag, anchor or alias on a value is refused');
    } else if (/^["']/.test(value) && !scalarShape(value).shape) {
      fileLevel(i, scalarShape(value).why);
    }
  });

  lines.forEach((line, s) => {
    const opener = line.match(STRUCTURAL_STEPS);
    if (!opener) return;
    const stepsIndent = opener[1].length;
    let listIndent = null;
    let step = null;
    let mapping = null;
    let bodyIndent = null;

    const refuse = (i, key, rule) => found.push({ step, line: i, key, rule });

    const closeMapping = () => { mapping = null; };

    const ownKey = (i, content) => {
      closeMapping();
      const m = content.match(KEY_LINE);
      if (!m) {
        refuse(i, null, `${JSON.stringify(content)} is not a "key: value" line this check reads; a quoted, complex `
          + 'or flow key, or a stray line, is refused');
        return;
      }
      const [, key] = m;
      const value = (m[2] ?? '').trimEnd();
      if (!STEP_KEYS.includes(key) && STEP_KEYS.includes(key.toLowerCase())) {
        refuse(i, key, `a case variant of ${key.toLowerCase()}: is refused; keys are matched exactly`);
      }
      if (step.keys.has(key)) refuse(i, key, 'the key appears twice in this step; YAML readers disagree on which one wins');
      step.keys.add(key);
      if (key === 'name') step.name = value;

      if (value === '') {
        if (key === 'env' || key === 'with') { mapping = { key, childCol: null, keys: new Set() }; return; }
        refuse(i, key, 'no inline value; only env: and with: may open a mapping, and a value on the next lines is not read');
        return;
      }
      if (key === 'if' && /^[|>]/.test(value)) {
        refuse(i, key, 'if: must be one line: a block scalar is refused');
        return;
      }
      if (BLOCK.has(value)) {
        if (key === 'run') { bodyIndent = step.keyCol; return; }
        refuse(i, key, `a ${value} block is allowed on run: and with: script: only`);
        return;
      }
      const shape = scalarShape(value);
      if (!shape.shape) { refuse(i, key, shape.why); return; }
      if (key === 'if' && shape.shape === 'single') refuse(i, key, 'if: must be plain or double-quoted; single-quoted is refused');
      if (key === 'if' && value.includes('\\')) refuse(i, key, 'if: may not carry a backslash');
      if (key === 'if' && shape.shape === 'plain' && NON_STRING_IF.test(value)) {
        refuse(i, key, 'if: resolves to a YAML null, boolean or number, not an expression string');
      }
    };

    const childKey = (i, content) => {
      const m = content.match(KEY_LINE);
      const where = `${mapping.key}.`;
      if (!m) {
        refuse(i, mapping.key, `${JSON.stringify(content)} is not a "key: value" line under ${mapping.key}:`);
        return;
      }
      const [, key] = m;
      const value = (m[2] ?? '').trimEnd();
      if (mapping.keys.has(key)) refuse(i, where + key, `the key appears twice under ${mapping.key}:`);
      mapping.keys.add(key);
      if (value === '') { refuse(i, where + key, 'no inline value; a nested mapping or a next-line value is not read'); return; }
      if (BLOCK.has(value)) {
        if (mapping.key === 'with' && key === 'script') { bodyIndent = mapping.childCol; return; }
        refuse(i, where + key, `a ${value} block is allowed on run: and with: script: only`);
        return;
      }
      const shape = scalarShape(value);
      if (!shape.shape) refuse(i, where + key, shape.why);
    };

    for (let i = s + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const ind = spaces(line);
      if (bodyIndent !== null) {
        if (ind > bodyIndent) continue;
        bodyIndent = null;
      }
      if (line.trimStart().startsWith('#')) continue;
      if (ind === stepsIndent && /^ *-( |$)/.test(line)) {
        refuse(i, null, 'a "- " list item at the steps: column (a compact sequence) is refused; indent the steps');
        break;
      }
      if (ind <= stepsIndent) break;

      const item = line.match(/^( *)-( +)(\S.*)$/);
      if (listIndent === null) {
        if (!item) { refuse(i, null, 'the first line under steps: is not a "- key: value" list item'); break; }
        listIndent = item[1].length;
      }
      if (item && item[1].length === listIndent) {
        step = { line: i, name: null, keyCol: listIndent + 1 + item[2].length, keys: new Set() };
        steps.push(step);
        ownKey(i, item[3]);
        continue;
      }
      if (step && ind === step.keyCol) { ownKey(i, line.slice(ind)); continue; }
      if (step && mapping && ind > step.keyCol) {
        if (mapping.childCol === null) mapping.childCol = ind;
        if (ind === mapping.childCol) { childKey(i, line.slice(ind)); continue; }
      }
      refuse(i, null, step
        ? `a line at column ${ind} is not one of the step's own keys (column ${step.keyCol})${mapping ? ` or a key under ${mapping.key}:` : ''}`
          + (ind > step.keyCol ? '; a continuation of the previous value is refused' : '')
        : 'a line under steps: that is not a list item');
    }
  });

  return {
    steps: steps.map((st) => ({ line: st.line + 1, name: st.name })),
    violations: found.map((v) => format(file, v)),
  };
}

function format(file, { step, line, key, rule }) {
  const where = step === null
    ? `${file}:${line + 1}`
    : `${file}:${line + 1}: step at line ${step.line + 1} (name: ${step.name === null ? 'none' : step.name})`;
  return `${where}${key === null ? '' : `: key ${key}`}: ${rule}`;
}
