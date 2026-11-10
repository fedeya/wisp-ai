import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import luaparse from 'luaparse';

function visit(node, callback) {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (node.type) {
    callback(node);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc' || key === 'range') {
      continue;
    }
    if (Array.isArray(child)) {
      child.forEach((item) => visit(item, callback));
    } else if (child && typeof child === 'object') {
      visit(child, callback);
    }
  }
}

// These checks complement Luacheck's scope analysis and StyLua's formatting.
// Parse the AST so comments, strings, and protocol payload keys are left alone.
export function checkConventions(source, filename) {
  const errors = [];
  const report = (node, message) => {
    errors.push(`${filename}:${node.loc?.start.line ?? 1}: ${message}`);
  };
  let tree;
  try {
    tree = luaparse.parse(source, { luaVersion: '5.1', locations: true });
  } catch (error) {
    return [`${filename}: ${error.message}`];
  }
  if (!/^[A-Z][A-Za-z0-9]*\.lua$/.test(path.basename(filename))) {
    report(tree, 'Lua filenames must use PascalCase.');
  }
  const aliases = new Map([['ns', ['ns']]]);
  const functions = new Set();
  const modulePath = (node) => {
    if (node?.type === 'Identifier') {
      return aliases.get(node.name);
    }
    if (node?.type === 'MemberExpression') {
      const base = modulePath(node.base);
      return base && [...base, node.identifier.name];
    }
    return undefined;
  };
  const namespace = tree.body.some(
    (node) =>
      node.type === 'LocalStatement' &&
      ['_', 'addonName'].includes(node.variables[0]?.name) &&
      node.variables[1]?.name === 'ns' &&
      node.init.length === 1 &&
      node.init[0].type === 'VarargLiteral',
  );
  visit(tree, (node) => {
    if (node.type === 'FunctionDeclaration' && node.isLocal) {
      functions.add(node.identifier.name);
      if (!/^[a-z][A-Za-z0-9]*$/.test(node.identifier.name)) {
        report(node, 'Local helper functions must use lowerCamelCase.');
      }
    }
    if (node.type === 'Identifier' && node.name === 'C') {
      report(node, 'Use the private ns namespace instead of C.');
    }
    if (node.type !== 'LocalStatement') {
      return;
    }
    node.variables.forEach((variable, index) => {
      const value = node.init[index];
      if (value?.type === 'FunctionDeclaration') {
        functions.add(variable.name);
        if (!/^[a-z][A-Za-z0-9]*$/.test(variable.name)) {
          report(variable, 'Local helper functions must use lowerCamelCase.');
        }
      }
      const owner = modulePath(value);
      if (owner) {
        aliases.set(variable.name, owner);
      }
    });
  });
  if (!namespace) {
    report(tree, 'Receive the private namespace with local _, ns = ... .');
  }

  // Modules may build a local table first, then publish it on ns.
  visit(tree, (node) => {
    if (node.type !== 'AssignmentStatement') {
      return;
    }
    node.variables.forEach((variable, index) => {
      const owner = modulePath(variable);
      const value = node.init[index];
      if (owner && value?.type === 'Identifier') {
        aliases.set(value.name, owner);
      }
    });
  });
  const checkFunction = (node, owner, declaration = true) => {
    if (!owner || owner[0] !== 'ns') {
      return;
    }
    if (owner.some((part) => part.startsWith('_'))) {
      return;
    }
    // Lowercase root fields are session state or native widgets, not modules.
    if (!declaration && owner.length > 2 && !/^[A-Z]/.test(owner[1])) {
      return;
    }
    if (owner.length < 3) {
      report(node, 'Put functions in a subsystem, such as ns.Chat.NewChat.');
    }
    if (owner.slice(1, -1).some((name) => !/^[A-Z][A-Za-z0-9]*$/.test(name))) {
      report(node, `Subsystem names must use PascalCase: ${owner.join('.')}.`);
    }
    const name = owner.at(-1);
    if (!/^_?[A-Z][A-Za-z0-9]*$/.test(name)) {
      report(node, `Public module functions must use PascalCase: ${owner.join('.')}.`);
    }
  };
  const callable = (node) =>
    node?.type === 'FunctionDeclaration' ||
    (node?.type === 'Identifier' && functions.has(node.name));
  const checkTable = (table, owner) => {
    if (!owner || owner.at(-1).startsWith('_')) {
      return;
    }
    for (const field of table.fields) {
      if (field.type !== 'TableKeyString') {
        continue;
      }
      const fieldPath = [...owner, field.key.name];
      if (callable(field.value)) {
        checkFunction(field, fieldPath);
      }
      if (field.value.type === 'TableConstructorExpression') {
        checkTable(field.value, fieldPath);
      }
    }
  };
  visit(tree, (node) => {
    if (node.type === 'FunctionDeclaration' && !node.isLocal) {
      checkFunction(node, modulePath(node.identifier));
    }
    if (node.type === 'CallExpression') {
      checkFunction(node, modulePath(node.base), false);
    }
    if (node.type === 'AssignmentStatement' || node.type === 'LocalStatement') {
      node.variables.forEach((variable, index) => {
        const owner = modulePath(variable);
        const value = node.init[index];
        if (callable(value)) {
          checkFunction(variable, owner);
        }
        if (value?.type === 'TableConstructorExpression') {
          checkTable(value, owner);
        }
      });
    }
  });
  return errors;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : file.endsWith('.lua') ? [file] : [];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = sourceFiles('addon/WispAI');
  const errors = files.flatMap((file) => checkConventions(readFileSync(file, 'utf8'), file));
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Lua conventions: ${files.length} files checked.`);
  }
}
