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
  assert.equal(packageJson.scripts.start, 'HOSTNAME=0.0.0.0 PORT=${PORT:-4173} node .next/standalone/server.js');
  assert.equal(packageJson.scripts.check, 'tsc --noEmit');
});

test('production configuration uses standalone output and disables mock in the container', async () => {
  const dockerfile = await readFile(new URL('Dockerfile', root), 'utf8');
  const dockerignore = await readFile(new URL('.dockerignore', root), 'utf8');
  const nextConfig = await readFile(new URL('next.config.ts', root), 'utf8');
  assert.match(dockerfile, /ENV ZHIJING_MOCK_MODE=false/);
  assert.match(dockerfile, /CMD \["node", "server\.js"\]/);
  assert.doesNotMatch(dockerfile, /COPY --from=builder \/app\/public/);
  assert.match(dockerignore, /\.codex\//);
  assert.match(dockerignore, /\.next\//);
  assert.match(dockerignore, /node_modules\//);
  assert.match(nextConfig, /output:\s*'standalone'/);
  assert.match(nextConfig, /X-Frame-Options/);
  assert.match(nextConfig, /Content-Security-Policy/);
});
