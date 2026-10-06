import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));

test('public package exports resolve to emitted build artifacts', () => {
  const importTarget = packageJson.exports['.'].import;
  const cssTarget = packageJson.exports['./styles.css'];
  assert.equal(typeof importTarget, 'string');
  assert.equal(typeof cssTarget, 'string');
  assert.ok(existsSync(resolve(packageRoot, importTarget)), `missing module artifact: ${importTarget}`);
  assert.ok(existsSync(resolve(packageRoot, cssTarget)), `missing CSS artifact: ${cssTarget}`);
  assert.ok(existsSync(resolve(packageRoot, packageJson.types)), `missing declaration artifact: ${packageJson.types}`);
  assert.equal(cssTarget, './dist/sparkz-charging-card.css');
});
