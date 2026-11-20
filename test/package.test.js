import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('package: zero runtime dependencies and Node v22.5+ floor (README:7-8)', () => {
  // README:7-8 opens with "Node v22.5+（零运行时依赖，仅使用 Node 内置模块）" —
  // the engines floor and the empty dependency maps are the manifest face of that.
  assert.deepEqual(pkg.dependencies, {}, 'package.json must declare no runtime dependencies');
  assert.deepEqual(pkg.devDependencies, {}, 'no dev dependencies either (zero-dep project)');
  assert.equal(pkg.engines.node, '>=22.5', 'README:7 documents a Node v22.5+ floor');
});

test('package: lib/bin import only relative modules or node: built-ins (README:7-8)', () => {
  // The same README sentence claims only Node built-in modules are used. A bare
  // third-party specifier sneaking into a lib/bin import would silently violate
  // it while the suite stayed green. Static scan: every `from '<spec>'` /
  // `import('<spec>')` must be relative (`.`) or a `node:` built-in.
  const files = [
    ...readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`),
    ...readdirSync(path.join(root, 'bin')).filter((f) => f.endsWith('.js')).map((f) => `bin/${f}`),
  ];
  const fromRe = /^\s*(?:import|export)\b[^;]*?\bfrom\s+(['"])([^'"]+)\1/gm;
  const dynamicRe = /\bimport\(\s*(['"])([^'"]+)\1\)/g;
  const bare = [];
  for (const rel of files) {
    const src = readFileSync(path.join(root, rel), 'utf8');
    for (const m of src.matchAll(fromRe)) {
      const spec = m[2];
      if (!spec.startsWith('.') && !spec.startsWith('node:')) bare.push(`${rel}: ${spec}`);
    }
    for (const m of src.matchAll(dynamicRe)) {
      const spec = m[2];
      if (!spec.startsWith('.') && !spec.startsWith('node:')) bare.push(`${rel}: import(${spec})`);
    }
  }
  assert.deepEqual(bare, [], 'lib/bin must import only relative modules or node: built-ins');
});
