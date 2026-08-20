const assert = require('node:assert/strict');
const { access, readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('portfolio files and synthetic diff fixture are valid', async () => {
  await access(path.join(root, 'ARCHITECTURE.md'));
  await access(path.join(root, 'legacy', 'README.md'));

  const diff = await readFile(path.join(__dirname, 'fixtures', 'synthetic', 'change.diff'), 'utf8');
  assert.match(diff, /^diff --git/m);
  assert.match(diff, /^\+const label = "new";/m);
  assert.equal(diff.length <= 12000, true);
});
