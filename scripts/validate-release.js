'use strict';

function validateRelease({ tag, version, eventName, confirmed }) {
  if (eventName === 'workflow_dispatch' && confirmed !== true && confirmed !== 'true') {
    throw new Error('Manual publishing requires explicit confirmation.');
  }
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Invalid release tag: ${tag || '(missing)'}`);
  }
  if (typeof version !== 'string' || tag !== `v${version}`) {
    throw new Error(`Tag ${tag} does not match package.json version ${version || '(missing)'}.`);
  }
  return { tag };
}

module.exports = { validateRelease };

if (require.main === module) {
  try {
    const result = validateRelease({
      tag: process.env.RELEASE_TAG,
      version: process.env.PACKAGE_VERSION,
      eventName: process.env.RELEASE_EVENT,
      confirmed: process.env.PUBLISH_CONFIRMED
    });
    const output = `tag=${result.tag}\n`;
    if (process.env.GITHUB_OUTPUT) {
      require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, output);
    } else {
      process.stdout.write(output);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
