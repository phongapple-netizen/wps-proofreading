'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateRelease } = require('../scripts/validate-release');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('release version validation accepts only an exact existing-version tag and explicit dispatch confirmation', () => {
  assert.deepEqual(validateRelease({ tag: 'v0.3.0', version: '0.3.0', eventName: 'push' }), { tag: 'v0.3.0' });
  assert.deepEqual(validateRelease({
    tag: 'v0.3.0', version: '0.3.0', eventName: 'workflow_dispatch', confirmed: 'true'
  }), { tag: 'v0.3.0' });
  assert.throws(() => validateRelease({ tag: '0.3.0', version: '0.3.0', eventName: 'push' }), /Invalid release tag/);
  assert.throws(() => validateRelease({ tag: 'v0.3.1', version: '0.3.0', eventName: 'push' }), /does not match/);
  assert.throws(() => validateRelease({ tag: 'v0.3.0', version: '0.3.0', eventName: 'workflow_dispatch' }), /explicit confirmation/);
});

test('release entry point is tag or confirmed manual dispatch, and waits for both platform builds', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- ['"]?v\*['"]?/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:/);
  assert.match(workflow, /publish:\s*\n\s+description: Confirm/);
  assert.match(workflow, /needs:\s*\[validate, windows, macos\]/);
  assert.match(workflow, /gh release create[\s\S]*--verify-tag/);
  assert.match(workflow, /WPS-Proofreading-\$\{version\}-Windows-x64-Setup\.exe/);
  assert.match(workflow, /WPS-Proofreading-\$\{version\}-macOS\.dmg/);
  assert.match(workflow, /refs\/tags\/\$RELEASE_TAG\^\{commit\}/);

  for (const file of ['.github/workflows/release-windows.yml', '.github/workflows/release-macos.yml']) {
    const platform = read(file);
    assert.match(platform, /pull_request:/);
    assert.doesNotMatch(platform, /gh release|release create|release upload|\[release-(windows|macos)\]/i);
    assert.doesNotMatch(platform, /pull_request:\s*\n\s+paths:/);
  }
});
