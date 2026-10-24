#!/usr/bin/env node
/**
 * doc-registry-packages: list the stonyx packages a repo's docs import but the
 * repo neither is nor declares (abofs/stonyx#122, part 2).
 *
 * ci.yml installs each of these at `@beta` (with `--ignore-scripts`) into a
 * temp directory and passes it to check-doc-imports.mjs as `--resolve-from`.
 * That is how stonyx core's docs, which import orm, discord, cron and
 * rest-server, are checked without adding those modules to core's
 * devDependencies (`loadModules` reads devDependencies and would boot them).
 *
 * Declared means listed in `dependencies`, `devDependencies`,
 * `peerDependencies` or `optionalDependencies`; those resolve from the repo's
 * own install and are never fetched from the registry, so a module's check
 * runs against what its lockfile pins.
 *
 * The names come from the repo's docs, so they are consumer-controlled text.
 * Only names matching the stonyx npm-name grammar are printed; anything else
 * (`@stonyx/Orm`, a trailing `/`) is left for check-doc-imports to fail as
 * unresolved, never passed to a package manager.
 *
 * Usage: node doc-registry-packages.mjs [--repo <dir>]
 * Output: one package name per line, sorted. Exit 0, or 2 on a usage error.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { declaredNames, discoverDocFiles, extractImports, splitSpec } from './check-doc-imports.mjs';

export const PACKAGE_NAME_RE = /^(?:stonyx|@stonyx\/[a-z0-9][a-z0-9-]*)$/;

export function docRegistryPackages(repo) {
  repo = realpathSync(resolve(repo));
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const known = declaredNames(pkg);

  const wanted = new Set();
  for (const file of discoverDocFiles(repo)) {
    for (const s of extractImports(readFileSync(join(repo, file), 'utf8')).statements) {
      const { name } = splitSpec(s.spec);
      if (PACKAGE_NAME_RE.test(name) && !known.has(name)) wanted.add(name);
    }
  }
  return [...wanted].sort();
}

const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const argv = process.argv.slice(2);
  let repo = process.cwd();
  try {
    if (argv.length === 2 && argv[0] === '--repo') repo = argv[1];
    else if (argv.length) throw new Error(`usage: doc-registry-packages.mjs [--repo <dir>]`);
    const names = docRegistryPackages(repo);
    if (names.length) console.log(names.join('\n'));
  } catch (error) {
    console.error(`doc-registry-packages: ${error.message}`);
    process.exit(2);
  }
}
