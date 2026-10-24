#!/usr/bin/env node
/**
 * check-doc-imports: every stonyx import a consumer can copy out of a doc must
 * resolve against the package's real `exports` and name members that exist
 * (abofs/stonyx#122).
 *
 * Scope
 *   - Files: `README.md` and `docs/**\/*.md` of the repo (or `--file` paths).
 *   - Fences: ``` / ~~~ blocks tagged js, javascript, mjs, cjs, jsx, ts,
 *     typescript, mts, cts, tsx, gjs, gts, or untagged.
 *   - Statements: `import ... from`, `export ... from` and side-effect
 *     `import '...'` of `stonyx`, `stonyx/<subpath>`, `@stonyx/<pkg>` and
 *     `@stonyx/<pkg>/<subpath>`.
 *   - Out of scope: imports of anything but `stonyx` / `@stonyx/*` (e.g.
 *     discord.js), dynamic `import('...')`, `require(...)`, prose and inline
 *     code spans, indented (non-fenced) code blocks.
 *
 * Mechanism
 *   Each statement becomes a one-statement `.mts` probe placed (virtually) at
 *   the repo root and is type-checked with `module`/`moduleResolution` NodeNext
 *   and `verbatimModuleSyntax`. The repo's own package resolves by
 *   self-reference, so it must be BUILT first: with no `dist/` the probes go red
 *   with TS2307 (fail closed). Anything the repo cannot resolve is retried from
 *   each `--resolve-from <dir>` (a directory holding a `node_modules/`), which is
 *   how stonyx core's docs reach modules that are not its dependencies.
 *
 * On top of the TypeScript diagnostics:
 *   - DEFAULT-NAME: a default import's binding must equal the default export's
 *     declared name. Anonymous defaults (`_default` in a d.ts) are skipped and
 *     counted.
 *   - WILDCARD-NO-FILE: an import matched by a wildcard `exports` key must map
 *     to a file that exists (Node and TS do not check this for extensionless
 *     targets, so resolution alone is vacuous there).
 *   - Packages that ship no types at all (e.g. an Ember addon) are checked by
 *     `exports` match plus file existence only; their members are not checked
 *     and the count is printed as `members-unchecked`.
 *   - UNEXTRACTED: a `from '<stonyx spec>'` (or side-effect import) inside any
 *     fence that was not extracted as a statement fails, so the check cannot
 *     pass by not seeing an import.
 *
 * There is no opt-out marker (abofs/stonyx#122 AC5).
 *
 * Usage
 *   node check-doc-imports.mjs [--repo <dir>] [--file <path>]... [--resolve-from <dir>]...
 * Exit status: 0 clean, 1 failures, 2 usage or internal error.
 */

import { existsSync, globSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberately looser than the package-name grammar: `@stonyx/Orm` or
// `@stonyx/orm/` must be extracted so TypeScript reports them (TS2307), not
// ignored by both the extractors and the guard.
export const SPEC_RE = /^(?:stonyx|@stonyx)(?:\/[^'"\s]*)?$/;

const JS_LANGS = new Set([
  '', 'js', 'javascript', 'mjs', 'cjs', 'jsx', 'ts', 'typescript', 'mts', 'cts', 'tsx', 'gjs', 'gts',
]);

// The clause is matched by its grammar -- an optional `type`, then a default
// binding (optionally followed by named or namespace bindings), named bindings
// `{ ... }`, or `*` / `* as ns` -- rather than by a character class. A class
// of identifier/brace/space characters lets `export default class X {\n}\n`
// run on into the next `import ... from`, which is a real statement.
const ID = String.raw`[A-Za-z_$][\w$]*`;
const NAMED = String.raw`\{[\w$\s,]*\}`;
const NS = String.raw`\*(?:\s+as\s+${ID})?`;
const CLAUSE = String.raw`(?:type\s+)?(?:${ID}(?:\s*,\s*(?:${NAMED}|${NS}))?|${NAMED}|${NS})`;
const STATEMENT_RE = new RegExp(
  String.raw`(?:^|(?<=;))[ \t]*(?:import|export)(?:\s+|(?=[{*]))${CLAUSE}\s*\bfrom\s*(['"])([^'"\n]+)\1`,
  'gm',
);
const SIDE_EFFECT_RE = /(?:^|(?<=;))[ \t]*import\s*(['"])([^'"\n]+)\1/gm;
// The guard's own view of "an import of a stonyx spec is written here". It
// shares nothing with the two extractors above beyond the spec grammar.
const GUARD_RE = /\b(?:from|import)\s*(['"])([^'"\n]+)\1/g;

const RUNTIME_CONDITIONS = ['import', 'node', 'default', 'require'];
const PROBE_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.gjs', '.ts', '.mts', '.cts', '.gts', '.d.ts'];

// ---------------------------------------------------------------------------
// Markdown

/** Split markdown into fenced blocks: { lang, startLine (1-based, first content line), text }. */
export function extractFences(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const fences = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!open) {
      const m = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`{]*)/);
      if (m && !(m[1][0] === '`' && line.slice(line.indexOf(m[1]) + m[1].length).includes('`'))) {
        open = { char: m[1][0], len: m[1].length, lang: m[2].toLowerCase(), startLine: i + 2, body: [] };
      }
      continue;
    }
    const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === open.char && close[1].length >= open.len) {
      fences.push({ lang: open.lang, startLine: open.startLine, text: open.body.join('\n') });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  // CommonMark: an unclosed fence runs to the end of the document.
  if (open) fences.push({ lang: open.lang, startLine: open.startLine, text: open.body.join('\n') });
  return fences;
}

/**
 * Blank out JS comments, keeping length and newlines so offsets and line
 * numbers are unchanged. Strings are skipped. A comment opener counts only at
 * the start of a line or after whitespace or one of `;,(){}[]=`, so a `/*` or
 * `//` inside a regex literal (`/\/*\/`) does not start one and hide the rest
 * of the fence, and an unclosed `/*` masks nothing. Only the extractors read
 * the masked text; the guard reads the raw fence, so a misread here can turn a
 * statement UNEXTRACTED (red) but can never hide one.
 */
export function maskComments(text) {
  const out = text.split('');
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote || (c === '\n' && quote !== '`')) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c !== '/' || (text[i + 1] !== '/' && text[i + 1] !== '*')) continue;
    if (i > 0 && !/[\s;,(){}[\]=]/.test(text[i - 1])) continue;
    const close = text[i + 1] === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
    // An unclosed `/*` is not JS; masking it would hide the rest of the fence.
    if (close === -1 && text[i + 1] === '*') continue;
    const end = close === -1 ? text.length : text[i + 1] === '/' ? close : close + 2;
    for (let j = i; j < end; j++) if (out[j] !== '\n') out[j] = ' ';
    i = end - 1;
  }
  return out.join('');
}

function lineOf(text, index) {
  let n = 0;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Extract stonyx import statements from one markdown document.
 * Returns { statements: [{ line, spec, text }], unextracted: [{ line, spec, lang }] }.
 */
export function extractImports(markdown) {
  const statements = [];
  const unextracted = [];
  for (const fence of extractFences(markdown)) {
    const isJs = JS_LANGS.has(fence.lang);
    // The extractors read JS fences with comments blanked, so a `// note` on a
    // member line does not break the statement. The guard below reads the raw
    // text: a commented-out import is still reported (AC3), never skipped.
    const code = isJs ? maskComments(fence.text) : fence.text;
    const covered = [];
    if (isJs) {
      for (const re of [STATEMENT_RE, SIDE_EFFECT_RE]) {
        re.lastIndex = 0;
        for (const m of code.matchAll(re)) {
          const spec = m[2];
          if (!SPEC_RE.test(spec)) continue;
          const lead = m[0].length - m[0].trimStart().length;
          const start = m.index + lead;
          const end = m.index + m[0].length;
          if (covered.some(([s, e]) => start < e && s < end)) continue;
          covered.push([start, end]);
          statements.push({
            line: fence.startLine + lineOf(code, start),
            spec,
            text: code.slice(start, end),
          });
        }
      }
    }
    for (const m of fence.text.matchAll(GUARD_RE)) {
      if (!SPEC_RE.test(m[2])) continue;
      const at = m.index;
      if (covered.some(([s, e]) => at >= s && at < e)) continue;
      const commented = code[at] !== fence.text[at];
      unextracted.push({ line: fence.startLine + lineOf(fence.text, at), spec: m[2], lang: fence.lang, ...(commented && { commented }) });
    }
  }
  statements.sort((a, b) => a.line - b.line);
  return { statements, unextracted };
}

// ---------------------------------------------------------------------------
// Package lookup and `exports` matching (used for wildcard and untyped packages)

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function splitSpec(spec) {
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const rest = spec.slice(name.length);
  return { name, subpath: rest ? `.${rest}` : '.' };
}

function findPackageDir(name, repo, resolveFrom) {
  const own = join(repo, 'package.json');
  if (existsSync(own) && readJson(own).name === name) return repo;
  const bases = [];
  for (let dir = repo; ; dir = dirname(dir)) {
    bases.push(dir);
    if (dirname(dir) === dir) break;
  }
  bases.push(...resolveFrom);
  for (const base of bases) {
    const candidate = join(base, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/** Node's PATTERN_KEY_COMPARE ordering: longest prefix before the `*` wins. */
export function matchExports(exportsField, subpath) {
  if (exportsField == null) return null;
  let map = exportsField;
  if (typeof map === 'string' || Array.isArray(map) || !Object.keys(map).some((k) => k.startsWith('.'))) {
    map = { '.': map };
  }
  if (Object.hasOwn(map, subpath) && !subpath.includes('*')) {
    return { key: subpath, target: map[subpath], wildcard: false, star: null };
  }
  let best = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length >= key.length && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      if (!best || prefix.length > best.prefixLength) {
        best = {
          key, target: map[key], wildcard: true, prefixLength: prefix.length,
          star: subpath.slice(prefix.length, subpath.length - suffix.length),
        };
      }
    }
  }
  return best;
}

function runtimeTarget(target) {
  if (target == null) return null;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = runtimeTarget(t);
      if (r) return r;
    }
    return null;
  }
  for (const cond of RUNTIME_CONDITIONS) {
    if (Object.hasOwn(target, cond)) {
      const r = runtimeTarget(target[cond]);
      if (r) return r;
    }
  }
  return null;
}

function hasTypes(pkg) {
  if (pkg.types || pkg.typings) return true;
  const walk = (node) => {
    if (node == null || typeof node !== 'object') return typeof node === 'string' && /\.d\.[cm]?ts$/.test(node);
    return Object.entries(node).some(([k, v]) => k === 'types' || walk(v));
  };
  return walk(pkg.exports);
}

function fileExistsWithProbe(path) {
  const tries = [];
  for (const ext of PROBE_EXTENSIONS) tries.push(path + ext);
  for (const ext of PROBE_EXTENSIONS.slice(1)) tries.push(join(path, `index${ext}`));
  return tries.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

// ---------------------------------------------------------------------------
// TypeScript

function loadTypeScript() {
  // Only this repo's pinned TypeScript, never the checked repo's: the verdict
  // must not depend on which TypeScript the consumer has, and ci.yml runs this
  // script inside the consumer's workspace, where the consumer's own
  // node_modules are code the consumer controls. An uninstalled tooling tree
  // is a usage error (exit 2), not a silent switch to the consumer's copy.
  try {
    return createRequire(import.meta.url)('typescript');
  } catch {
    throw new Error(`typescript is not installed next to ${fileURLToPath(import.meta.url)}; run pnpm install in the stonyx-workflows checkout`);
  }
}

const ANONYMOUS_DEFAULT = /^_?default\d*$/;

function declaredDefaultName(ts, checker, moduleSymbol) {
  const def = checker.tryGetMemberInModuleExports('default', moduleSymbol);
  if (!def) return { exists: false };
  let sym = def;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      // keep the alias
    }
  }
  for (const decl of sym.declarations ?? []) {
    const name = ts.getNameOfDeclaration(decl);
    if (name && ts.isIdentifier(name) && !ANONYMOUS_DEFAULT.test(name.text)) {
      return { exists: true, name: name.text };
    }
  }
  return { exists: true, name: null };
}

/** Exported names of each module, keyed by spec; default reported as its declared name. */
function moduleSurfaces(ts, program, checker, probes) {
  const out = new Map();
  for (const { spec, fileName } of probes) {
    const sf = program.getSourceFile(fileName);
    const decl = sf?.statements.find((s) => ts.isImportDeclaration(s));
    const moduleSymbol = decl && checker.getSymbolAtLocation(decl.moduleSpecifier);
    if (!moduleSymbol) continue;
    const named = checker.getExportsOfModule(moduleSymbol).map((s) => s.name).filter((n) => n !== 'default');
    const def = declaredDefaultName(ts, checker, moduleSymbol);
    out.set(spec, { named, defaultName: def.exists ? def.name : null });
  }
  return out;
}

function createProgram(ts, repo, resolveFrom, probes) {
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
    noUncheckedSideEffectImports: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: false,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const virtual = new Map(probes.map((p) => [p.fileName, p.source]));
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (fileName, languageVersion, ...rest) => (virtual.has(fileName)
    ? ts.createSourceFile(fileName, virtual.get(fileName), languageVersion, true)
    : getSourceFile.call(host, fileName, languageVersion, ...rest));
  host.fileExists = (fileName) => virtual.has(fileName) || fileExists.call(host, fileName);
  host.readFile = (fileName) => (virtual.has(fileName) ? virtual.get(fileName) : readFile.call(host, fileName));

  host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, opts, containingSourceFile) => literals.map((lit) => {
    const mode = ts.getModeForUsageLocation(containingSourceFile, lit, opts);
    const first = ts.resolveModuleName(lit.text, containingFile, opts, host, undefined, redirectedReference, mode);
    if (first.resolvedModule || !virtual.has(containingFile)) return first;
    for (const dir of resolveFrom) {
      const retry = ts.resolveModuleName(lit.text, join(dir, '__stonyx_doc_import_probe__.mts'), opts, host, undefined, redirectedReference, ts.ModuleKind.ESNext);
      if (retry.resolvedModule) return retry;
    }
    return first;
  });

  const program = ts.createProgram({ rootNames: probes.map((p) => p.fileName), options, host });
  return { program, checker: program.getTypeChecker() };
}

// TS appends a suggestion to "has no exported member" that is exactly the
// wrong fix here (`import Command from '@stonyx/discord'` binds Discord), so it
// is removed and replaced with the subpath that really exports the name.
function stripTsSuggestion(message) {
  return message.replace(/\s*Did you mean to use '[^']*' instead\?/g, '').replace(/\s*Did you mean '[^']*'\?/g, '');
}

function sanitize(text) {
  // Doc text is attacker-controllable on a PR. Nothing derived from it may
  // start a line of output (GitHub workflow commands are line-anchored).
  return String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// The check

/** The default doc set: `README.md` and `docs/**\/*.md`, repo-relative. */
export function discoverDocFiles(repo) {
  return [
    ...(existsSync(join(repo, 'README.md')) ? ['README.md'] : []),
    ...globSync('docs/**/*.md', { cwd: repo }).sort(),
  ];
}

/**
 * @param {{ repo: string, files?: string[], resolveFrom?: string[] }} opts
 * @returns {{ checked: number, failures: object[], skippedAnonymousDefault: object[],
 *   membersUnchecked: object[], files: string[], typescript: string }}
 */
export function checkDocImports({ repo, files, resolveFrom = [] }) {
  // Canonical paths throughout: a missing --repo is an error (exit 2), not a
  // vacuous files=0 pass, and a --file given through a different spelling of
  // the same directory (symlink vs realpath) is still reported repo-relative.
  repo = realpathSync(resolve(repo));
  resolveFrom = resolveFrom.map((d) => realpathSync(resolve(d)));
  const ts = loadTypeScript();

  const docFiles = files?.length
    ? files.map((f) => relative(repo, realpathSync(resolve(repo, f))))
    : discoverDocFiles(repo);

  const failures = [];
  const skippedAnonymousDefault = [];
  const membersUnchecked = [];
  const statements = [];

  for (const file of docFiles) {
    const { statements: found, unextracted } = extractImports(readFileSync(join(repo, file), 'utf8'));
    for (const s of found) statements.push({ ...s, file });
    for (const u of unextracted) {
      failures.push({
        file, line: u.line, spec: u.spec, code: 'UNEXTRACTED',
        message: u.lang && !JS_LANGS.has(u.lang)
          ? `import of '${u.spec}' inside a \`${u.lang}\` fence; tag the fence js/ts so it is checked, or move it to prose`
          : u.commented
            ? `commented-out import of '${u.spec}' is not checked; delete it, or move it to prose`
            : `import of '${u.spec}' was not extracted as a statement; write it as one \`import ... from '...'\` statement at the start of a line`,
      });
    }
  }

  const pkgCache = new Map();
  const packageInfo = (name) => {
    if (!pkgCache.has(name)) {
      const dir = findPackageDir(name, repo, resolveFrom);
      const pkg = dir ? readJson(join(dir, 'package.json')) : null;
      pkgCache.set(name, dir ? { dir, pkg, typed: hasTypes(pkg), label: `${name}@${pkg.version ?? '?'}` } : null);
    }
    return pkgCache.get(name);
  };

  // Exports-map checks, before TypeScript.
  const tsStatements = [];
  for (const s of statements) {
    const { name, subpath } = splitSpec(s.spec);
    const info = packageInfo(name);
    if (!info) {
      tsStatements.push(s); // let TS report it as unresolved (TS2307)
      continue;
    }
    const match = matchExports(info.pkg.exports, subpath);
    // TypeScript resolves `pkg/` to the main entry; Node rejects any specifier
    // ending in '/' when the package has exports (ERR_PACKAGE_PATH_NOT_EXPORTED,
    // trailing-slash mappings are removed: DEP0155).
    if (subpath.endsWith('/') && info.pkg.exports != null) {
      failures.push({ ...pick(s), code: 'NOT-EXPORTED', message: `'${s.spec}' ends in '/', which Node does not resolve against the exports of ${info.label}; drop the trailing '/'` });
      continue;
    }
    if (match?.wildcard) {
      const target = runtimeTarget(match.target);
      const file = target && fileExistsWithProbe(join(info.dir, target.replaceAll('*', match.star)));
      if (!file) {
        failures.push({
          ...pick(s), code: 'WILDCARD-NO-FILE',
          message: `'${s.spec}' matches exports key '${match.key}' of ${info.label}, but no file exists at ${target ? target.replaceAll('*', match.star) : '(no runtime target)'}`,
        });
        continue;
      }
    }
    if (!info.typed) {
      if (!match) {
        failures.push({
          ...pick(s), code: 'NOT-EXPORTED',
          message: `'${subpath}' is not in the exports of ${info.label} (exports: ${Object.keys(info.pkg.exports ?? {}).join(', ') || 'none'})`,
        });
      } else if (!match.wildcard) {
        const target = runtimeTarget(match.target);
        if (!target || !fileExistsWithProbe(join(info.dir, target))) {
          failures.push({ ...pick(s), code: 'WILDCARD-NO-FILE', message: `exports '${match.key}' of ${info.label} points at a missing file` });
          continue;
        }
        membersUnchecked.push(pick(s));
      } else {
        membersUnchecked.push(pick(s));
      }
      continue;
    }
    tsStatements.push(s);
  }

  // TypeScript: one virtual probe per statement, at the repo root.
  const probeDir = join(repo, '__stonyx_doc_import_probes__');
  const probes = tsStatements.map((s, i) => ({ ...s, fileName: join(probeDir, `p${i}.mts`).split(sep).join('/'), source: `${s.text};\n` }));
  const { program, checker } = probes.length ? createProgram(ts, repo, resolveFrom, probes) : {};

  const memberMisses = [];
  for (const p of probes) {
    const sf = program.getSourceFile(p.fileName);
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
    for (const d of diags) {
      const offset = d.start ? lineOf(p.source, d.start) : 0;
      const { name } = splitSpec(p.spec);
      const info = packageInfo(name);
      const failure = {
        file: p.file, line: p.line + offset, spec: p.spec, code: `TS${d.code}`,
        message: `${stripTsSuggestion(ts.flattenDiagnosticMessageText(d.messageText, ' ')).replace(/\.$/, '')}${info ? ` [${info.label}]` : ''}`,
      };
      failures.push(failure);
      if ([2305, 2614, 1192].includes(d.code)) memberMisses.push({ failure, pkgName: name, member: d.code === 1192 ? 'default' : memberFrom(d, ts) });
    }
    // Default-import identity.
    for (const stmt of sf.statements) {
      const isImport = ts.isImportDeclaration(stmt);
      const isExport = ts.isExportDeclaration(stmt);
      if ((!isImport && !isExport) || !stmt.moduleSpecifier) continue;
      const moduleSymbol = checker.getSymbolAtLocation(stmt.moduleSpecifier);
      if (!moduleSymbol) continue;
      const bindings = [];
      if (isImport && stmt.importClause?.name) bindings.push(stmt.importClause.name);
      const named = isImport ? stmt.importClause?.namedBindings : stmt.exportClause;
      if (named && (ts.isNamedImports(named) || ts.isNamedExports(named))) {
        for (const el of named.elements) {
          if ((el.propertyName?.text ?? el.name.text) === 'default' && el.propertyName) bindings.push(el.name);
        }
      }
      if (!bindings.length) continue;
      const def = declaredDefaultName(ts, checker, moduleSymbol);
      if (!def.exists) continue; // TS1192/TS2305 already reported it
      for (const b of bindings) {
        if (def.name === null) {
          skippedAnonymousDefault.push({ file: p.file, line: p.line + lineOf(p.source, b.getStart(sf)), spec: p.spec, binding: b.text });
        } else if (b.text !== def.name) {
          failures.push({
            file: p.file, line: p.line + lineOf(p.source, b.getStart(sf)), spec: p.spec, code: 'DEFAULT-NAME',
            message: `default export of '${p.spec}' is declared '${def.name}', the doc binds it as '${b.text}'`,
          });
          memberMisses.push({ failure: failures.at(-1), pkgName: splitSpec(p.spec).name, member: b.text });
        }
      }
    }
  }

  suggestSubpaths(ts, repo, resolveFrom, memberMisses, packageInfo);

  failures.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return {
    checked: statements.length,
    failures,
    skippedAnonymousDefault,
    membersUnchecked,
    files: docFiles,
    typescript: ts.version,
  };
}

function pick(s) {
  return { file: s.file, line: s.line, spec: s.spec };
}

function memberFrom(diag, ts) {
  const text = ts.flattenDiagnosticMessageText(diag.messageText, ' ');
  return text.match(/(?:exported member|member named) '([^']+)'/)?.[1] ?? null;
}

/** Append "exported by '<pkg>/<sub>'" to member misses, from the package's own exports. */
function suggestSubpaths(ts, repo, resolveFrom, misses, packageInfo) {
  const wanted = misses.filter((m) => m.member && m.member !== 'default');
  if (!wanted.length) return;
  const specs = new Set();
  for (const { pkgName } of wanted) {
    const info = packageInfo(pkgName);
    if (!info?.pkg.exports || typeof info.pkg.exports !== 'object') continue;
    for (const key of Object.keys(info.pkg.exports)) {
      if (key.startsWith('.') && !key.includes('*')) specs.add(key === '.' ? pkgName : `${pkgName}${key.slice(1)}`);
    }
  }
  const probeDir = join(repo, '__stonyx_doc_import_suggest__');
  const probes = [...specs].map((spec, i) => ({ spec, fileName: join(probeDir, `s${i}.mts`).split(sep).join('/'), source: `import '${spec}';\n` }));
  if (!probes.length) return;
  const { program, checker } = createProgram(ts, repo, resolveFrom, probes);
  const surfaces = moduleSurfaces(ts, program, checker, probes);
  for (const { failure, pkgName, member } of wanted) {
    const hits = [];
    for (const [spec, surface] of surfaces) {
      if ((spec !== pkgName && !spec.startsWith(`${pkgName}/`)) || spec === failure.spec) continue;
      if (surface.defaultName === member) hits.push(`import ${member} from '${spec}'`);
      else if (surface.named.includes(member)) hits.push(`import { ${member} } from '${spec}'`);
    }
    if (hits.length) failure.message += `. Use: ${hits.join(' or ')}`;
  }
}

// ---------------------------------------------------------------------------
// CLI

export function formatReport(result) {
  const lines = [];
  for (const f of result.failures) {
    lines.push(`${sanitize(f.file)}:${f.line}: ${f.code} ${sanitize(f.message)}`);
  }
  for (const s of result.skippedAnonymousDefault) {
    lines.push(`skip ${sanitize(s.file)}:${s.line}: anonymous default of '${sanitize(s.spec)}' bound as '${sanitize(s.binding)}' (name rule not applicable)`);
  }
  for (const s of result.membersUnchecked) {
    lines.push(`note ${sanitize(s.file)}:${s.line}: '${sanitize(s.spec)}' ships no types; resolution and file existence checked, members not checked`);
  }
  lines.push(`check-doc-imports: files=${result.files.length} checked=${result.checked} failed=${result.failures.length} `
    + `skipped-anonymous-default=${result.skippedAnonymousDefault.length} members-unchecked=${result.membersUnchecked.length} `
    + `typescript=${result.typescript}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { repo: process.cwd(), files: [], resolveFrom: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--repo', '--file', '--resolve-from'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    if (flag === '--repo') args.repo = value;
    else if (flag === '--file') args.files.push(value);
    else args.resolveFrom.push(value);
  }
  return args;
}

// Node gives import.meta.url as the realpath; argv[1] is the path as typed.
// Both sides must be canonical, or running through a symlink (macOS /tmp, a
// symlinked checkout) skips the check and exits 0 with no output.
const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  let result;
  try {
    result = checkDocImports(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`check-doc-imports: ${error.message}`);
    process.exit(2);
  }
  console.log(formatReport(result));
  process.exit(result.failures.length ? 1 : 0);
}
