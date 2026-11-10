import { test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

test('workspace sources declare their direct package imports', () => {
  const missing: string[] = [];
  const builtins = new Set(builtinModules);
  for (const directory of [
    'apps/agent',
    'apps/bridge',
    'apps/desktop',
    'apps/web',
    'packages/protocol',
    'packages/releases',
    'scripts',
    'tests',
  ]) {
    const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
    declared.add(pkg.name);
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', 'src-tauri', '.eve', '.next'].includes(entry.name)) {
            walk(file);
          }
        } else if (/\.(ts|svelte)$/.test(entry.name)) {
          let source = readFileSync(file, 'utf8');
          if (entry.name.endsWith('.svelte')) {
            source = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] || '';
          }
          const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
          for (const node of ast.statements) {
            if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
              continue;
            }
            const specifier = node.moduleSpecifier.text;
            if (
              specifier.startsWith('.') ||
              specifier.startsWith('node:') ||
              builtins.has(specifier)
            ) {
              continue;
            }
            const dependency = specifier.startsWith('@')
              ? specifier.split('/').slice(0, 2).join('/')
              : specifier.split('/')[0];
            if (!declared.has(dependency)) {
              missing.push(`${file}: ${dependency}`);
            }
          }
        }
      }
    };
    walk(directory);
  }
  expect(missing).toEqual([]);
});
