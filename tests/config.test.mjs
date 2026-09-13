import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);

test('basic template excludes OAuth configuration', async () => {
  const config = JSON.parse(await readFile(new URL('hackathon.config.json', root), 'utf8'));
  assert.equal(config.oauth.enabled, false);
  assert.equal('appId' in config.oauth, false);
  assert.equal('redirectUri' in config.oauth, false);
  assert.equal('credentialService' in config.oauth, false);
});

test('foundation exposes the required project scripts', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(packageJson.scripts.build, 'next build');
  assert.equal(packageJson.scripts.start, 'next start -H 127.0.0.1 -p 4173');
  assert.equal(packageJson.scripts.check, 'tsc --noEmit');
});
