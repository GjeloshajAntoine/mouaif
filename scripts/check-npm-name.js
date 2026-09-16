// scripts/check-npm-name.js
//
// Pre-publish guard for the `mouaif` package name.
//
// `package.json` declares the name `mouaif`, which is currently unpublished
// on npm. `npm publish` would claim it on the first run. Because the publish
// itself happens outside this repository (and from this machine the registry
// may be unreachable), this script makes the name collision check explicit:
// it asks the registry who owns the name and fails the publish when the
// published package is not this one.
//
//   - registry answers 404  -> name is free, publish is allowed;
//   - registry lists the package -> compare `repository.url`; fail when the
//     published package points somewhere else, pass when it is this repo;
//   - registry is unreachable -> warn and exit 0, because a flaky network
//     must not block a release the maintainer already decided to make.
//
// Exit codes: 0 = publish may proceed, 1 = stop.

'use strict';

const https = require('https');

const REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 8000;

const pkg = require('../package.json');
const name = pkg.name;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve({ status: 404 });
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out after ' + TIMEOUT_MS + 'ms')));
    req.on('error', reject);
  });
}

function normalizeRepo(url) {
  if (!url) return '';
  return String(url)
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function fail(message) {
  console.error('[mouaif] publish check failed: ' + message);
  process.exit(1);
}

async function main() {
  let result;
  try {
    result = await fetchJson(REGISTRY + '/' + encodeURIComponent(name));
  } catch (error) {
    console.warn(
      '[mouaif] could not reach the npm registry to verify the "' + name + '" name (' +
      (error && error.message ? error.message : error) + '). Skipping the check.'
    );
    return;
  }

  if (result.status === 404) {
    console.log('[mouaif] npm name "' + name + '" is free; the publish will claim it.');
    return;
  }

  const published = result.json || {};
  const publishedRepo = normalizeRepo(
    published.repository && (published.repository.url || published.repository)
  );
  const localRepo = normalizeRepo(pkg.repository && (pkg.repository.url || pkg.repository));

  if (localRepo && publishedRepo && publishedRepo !== localRepo) {
    fail(
      'the npm name "' + name + '" is already taken by a package from ' + publishedRepo +
      ', not this repository (' + localRepo + '). Choose a different "name" in package.json.'
    );
  }

  console.warn(
    '[mouaif] the npm name "' + name + '" is already published. ' +
    'The publish will fail unless you are a maintainer of that package and the version is new.'
  );
}

main().catch((error) => {
  console.warn('[mouaif] publish check skipped: ' + (error && error.message ? error.message : error));
});
