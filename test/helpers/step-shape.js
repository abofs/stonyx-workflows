// The shape allowlist for workflow steps (#61, round 4).
//
// The #39/#60 publish-implies-guard check and the #60 job simulator read `if:`,
// `id:`, `env:` and `run:` through `workflow-yaml.js`, a hand-written reader.
// Three review rounds each found one more YAML shape that reader read
// differently from GitHub -- a plain `if:` continued onto the next line, a
// `>-` block whose body is a quoted string, an unclosed quoted `name:` that
// swallows the `if:` line, a duplicate `if:` -- and in every case the check
// evaluated a condition GitHub never runs. Patching the reader one shape at a
// time does not end that, so this file removes the shapes instead: a workflow
// step may only be written in the few forms the live files already use, and
// anything else is a red that names the step, the key and the rule.
//
// Inside a step, every own key (`name`, `id`, `if`, `uses`, `run`, ...) and
// every key under `env:` and `with:` must be:
//   - a complete single-line scalar: plain, or single- or double-quoted and
//     closed on that line, with nothing after it -- or
//   - for `run:` (and `script:` under `with:`) only, a `|` or `|-` block.
// `env:` and `with:` may open a one-level mapping. `if:` must be a
// single-line plain or double-quoted value with no backslash. A key may appear
// once per step (and once per mapping). Any other line in a step is refused.
//
// THIS FILE SHARES NO CODE WITH `workflow-yaml.js` AND LOADS NOTHING. If it
// were fed by that reader, a shape the reader mis-tokenises would be
// mis-tokenised here too and pass both. It works on raw lines, by column, with
// its own few rules. It first refuses, anywhere in the file, every character
// that could make its line or column count differ from YAML's: YAML (libyaml,
// and the runner's parser) also breaks lines at CR, NEL, U+2028 and U+2029, a
// tab is never indentation, and this check counts spaces only. Any other
// whitespace and control character goes with them, so `\s` in the rules below
// means the space it looks like.

const STRUCTURAL_STEPS = /^( *)steps:\s*$/;
const ANY_STEPS = /^\s*(?:-\s+)?["']?steps["']?\s*:/;
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: +(.*))?$/;
const BLOCK = new Set(['|', '|-']);
const FLOW_WORDS = /^\[[\w.*/-]+(?:, [\w.*/-]+)*\]$/;

const spaces = (line) => line.match(/^ */)[0].length;

/**
 * The shape of a one-line value, or the reason it is not one this check reads.
 */
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

/**
 * Every step in `text`, and every way one of them breaks the allowlist.
 *
 * Returns `{ steps, violations }`: `steps` is `[{ line, name }]` in file order
 * (`name` raw, as written), so a caller can cross-check the population against
 * another reader; `violations` is an array of messages, empty when the file is
 * inside the allowlist.
 */
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

  // File-wide, outside `run:`/`script:` block bodies: the YAML forms that can
  // spell a `steps` key, or a whole job, on a line `ANY_STEPS` and
  // `STRUCTURAL_STEPS` never see -- `{runs-on: x, steps: [...]}`, `"ste\x70s":`,
  // `? steps`, `!!str steps:`, `&a steps:` -- and the unclosed quote that could
  // hide a `run: |` header from the body skip below. None of them is in a live
  // file; the one flow collection that is (`branches: [main]`) is admitted in
  // exactly that form.
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
    let mapping = null; // { key, childCol, keys }
    let bodyIndent = null; // inside a `|` block whose key sits at this column

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
