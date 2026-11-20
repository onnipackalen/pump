/**
 * The wall between the game rules and the fair module.
 *
 * CLAUDE.md: "PumpEngine.ts has zero I/O: no database, HTTP, clock or
 * crypto" and "The engine never sees seeds. A pump asks for one integer in
 * [0, den) and the fair module supplies it." The fair module (src/fair) is
 * where HMAC-SHA256, SHA-256 and the seeds live. It sits in the same
 * tsconfig project as PumpEngine.ts, and @noble/hashes is a dependency of
 * the engine package, so nothing in tsc stops the rules from importing
 * drawRoll or hmacSha256 and taking a server seed themselves. The engine's
 * lint block only bans `node:*`.
 *
 * So this test reads every engine source file outside src/fair and fails if
 * one of them loads, at run time, anything from:
 *   - the fair module: a relative path into src/fair, or `@pump/engine/fair`
 *   - `@noble/...`, the hash library the fair module wraps
 *
 * Types are fine. The engine may say `import type { Drawer } from './fair'`
 * to name the shape of the randomness it is handed. Only a whole-statement
 * `import type` / `export type` counts as types-only. `import { type Drawer }`
 * does not: this repo compiles with verbatimModuleSyntax, under which that
 * line still becomes `import {} from './fair'` and loads the module.
 *
 * The check parses each file with the TypeScript compiler, so imports split
 * over several lines, or mentioned in comments, are handled correctly.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));
const FAIR_DIR = join(SRC_DIR, 'fair');

/** True when `path` is `dir` itself or anywhere inside it. */
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** True when `specifier`, written in the file `fromFile`, points at crypto or seeds. */
function isForbiddenTarget(specifier: string, fromFile: string): boolean {
  if (specifier.startsWith('.')) return isInside(resolve(dirname(fromFile), specifier), FAIR_DIR);
  return (
    specifier === '@pump/engine/fair' ||
    specifier.startsWith('@pump/engine/fair/') ||
    specifier.startsWith('@noble/')
  );
}

/** The module text of a string-literal specifier, or undefined for anything else. */
function specifierText(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/**
 * Every run-time import of the fair module or @noble in one source file, as
 * `line N: <statement>`. Empty means the file is clean.
 *
 * Kinds of statement it looks at:
 *   import ... from 'x'        allowed only as `import type ...`
 *   import 'x'                 never allowed (runs the module)
 *   export ... from 'x'        allowed only as `export type ...`
 *   import x = require('x')    allowed only as `import type x = ...`
 *   import('x')                never allowed (the lint rules also ban it)
 * A type position like `import('x').Drawer` is a type, and is allowed.
 */
function runtimeFairImports(fileName: string, sourceText: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const report = (node: ts.Node): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`line ${line + 1}: ${node.getText(source)}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const target = specifierText(node.moduleSpecifier);
      const typeOnly = node.importClause?.isTypeOnly === true;
      if (target !== undefined && !typeOnly && isForbiddenTarget(target, fileName)) report(node);
    } else if (ts.isExportDeclaration(node)) {
      const target = specifierText(node.moduleSpecifier);
      if (target !== undefined && !node.isTypeOnly && isForbiddenTarget(target, fileName)) {
        report(node);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const target = specifierText(node.moduleReference.expression);
      if (target !== undefined && !node.isTypeOnly && isForbiddenTarget(target, fileName)) {
        report(node);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const target = specifierText(node.arguments[0]);
      if (target !== undefined && isForbiddenTarget(target, fileName)) report(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

/** Every .ts file under src/ that is not part of the fair module. */
function engineFilesOutsideFair(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .map((rel) => join(SRC_DIR, rel))
    .filter((path) => path.endsWith('.ts') && !isInside(path, FAIR_DIR))
    .sort();
}

describe('the checker itself', () => {
  const ENGINE_FILE = join(SRC_DIR, 'PumpEngine.ts');
  const check = (text: string, file = ENGINE_FILE): string[] => runtimeFairImports(file, text);

  it.each([
    ["import { drawRoll, hmacSha256 } from './fair';"],
    ["import { drawerFor } from './fair/index';"],
    ["import { drawerFor } from './fair/draw.ts';"],
    ["import * as fair from './fair';"],
    ["import fair from './fair';"],
    ["import './fair';"],
    ["import { drawerFor } from '@pump/engine/fair';"],
    ["import { sha256 } from '@noble/hashes/sha2.js';"],
    ["import { hmac } from '@noble/hashes/hmac.js';"],
    // Still loads the module under verbatimModuleSyntax.
    ["import { type Drawer } from './fair';"],
    ["export { drawRoll } from './fair';"],
    ["export * from './fair';"],
    ["export * as fair from '@pump/engine/fair';"],
    ["import fair = require('./fair');"],
    ["export const load = () => import('./fair');"],
    ["import {\n  drawRoll,\n  hmacSha256,\n} from './fair';"],
  ])('catches %j', (text) => {
    expect(check(text)).toHaveLength(1);
  });

  it('catches the leaks from the review, with their line numbers', () => {
    const text = [
      "import { drawerFor, hmacSha256 } from './fair';",
      "import { sha256 } from '@noble/hashes/sha2.js';",
      'export const leak = [drawerFor, hmacSha256, sha256];',
    ].join('\n');
    expect(check(text)).toEqual([
      "line 1: import { drawerFor, hmacSha256 } from './fair';",
      "line 2: import { sha256 } from '@noble/hashes/sha2.js';",
    ]);
  });

  it('follows relative paths from files in subfolders', () => {
    const nested = join(SRC_DIR, 'rules', 'pump.ts');
    expect(check("import { drawRoll } from '../fair';", nested)).toHaveLength(1);
    expect(check("import { drawRoll } from '../fair/draw';", nested)).toHaveLength(1);
    expect(check("import { RTP_BP } from '../config';", nested)).toEqual([]);
  });

  it.each([
    ["import type { Drawer } from './fair';"],
    ["import type { Drawer } from '@pump/engine/fair';"],
    ["export type { Drawer } from './fair';"],
    ["type D = import('./fair').Drawer;"],
    ["import { RTP_BP } from './config';"],
    ["export * from './config';"],
    // A folder that only starts with the same letters is not the fair module.
    ["import { x } from './fairness';"],
    ["// import { drawRoll } from './fair';"],
  ])('allows %j', (text) => {
    expect(check(text)).toEqual([]);
  });
});

describe('engine files outside src/fair', () => {
  const files = engineFilesOutsideFair();

  it('include PumpEngine.ts, so a rename cannot quietly skip it', () => {
    expect(files).toContain(join(SRC_DIR, 'PumpEngine.ts'));
  });

  it.each(files.map((path) => [relative(SRC_DIR, path), path]))(
    '%s loads nothing from the fair module or @noble at run time',
    (_name, path) => {
      expect(runtimeFairImports(path, readFileSync(path, 'utf8'))).toEqual([]);
    },
  );
});
