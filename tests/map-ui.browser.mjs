import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const playwrightPath = process.env.PLAYWRIGHT_MODULE;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_MODULE to a local playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
});
const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:4173';
const output = process.env.SCREENSHOT_DIR ?? '/tmp/zhijing-map-ui';
await mkdir(output, { recursive: true });
const outline = JSON.parse(await readFile(resolve('fixtures/outline-calculus.json'), 'utf8'));
const raw = JSON.parse(await readFile(resolve('fixtures/resources-limits.json'), 'utf8'));
const resources = raw.Data.Items.map((item) => ({
  title: item.Title, url: item.Url, contentId: item.ContentID, contentType: item.ContentType,
  excerpt: item.ContentText, author: item.AuthorName, editTime: item.EditTime,
  voteUpCount: item.VoteUpCount, commentCount: item.CommentCount, score: 1,
}));
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(base);
  await page.getByRole('button', { name: '微积分' }).click();
  await page.locator('.generation-status').filter({ hasText: '地图已生成' }).waitFor();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.knowledge-node').count(), 6);
  await page.screenshot({ path: `${output}/desktop.png` });
  await page.locator('.node-open').first().click();
  assert.equal(await page.locator('.satellite-node').count(), 3);
  assert.equal(await page.locator('.satellite-node a').count(), 0);
  const boxes = await page.locator('.satellite-node').evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().toJSON()));
  assert.ok(boxes.every((box) => box.y > 310 && box.bottom < 970 && box.x >= 0 && box.right <= 1440));
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].top >= boxes[i - 1].bottom);
  await page.screenshot({ path: `${output}/desktop-expanded.png` });
  await page.getByRole('button', { name: '收起资源' }).click();
  assert.equal(await page.locator('.satellite-node').count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: '微积分' }).click();
  await page.getByRole('button', { name: '查看 函数基础 资源' }).waitFor();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${output}/mobile.png` });
  await page.getByRole('button', { name: '查看 函数基础 资源' }).click();
  await page.locator('dialog[open]').waitFor();
  for (const key of ['Tab', 'Shift+Tab', 'Tab']) {
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('dialog')), true);
  }
  await page.screenshot({ path: `${output}/mobile-drawer.png` });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('node-open')), true);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    window.__streams = [];
    window.__retryCalls = 0;
    window.fetch = (url, init) => {
      if (url === '/api/generate') {
        const stream = new ReadableStream({
          start(controller) { window.__streams.push(controller); },
        });
        return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
      }
      if (url === '/api/resources') {
        window.__retryCalls++;
        return Promise.resolve(Response.json({
          ok: true, mockMode: true, nodeId: JSON.parse(init.body).nodeId,
          state: 'empty', resources: [], weight: 0,
        }));
      }
      return realFetch(url, init);
    };
  });
  await page.reload();
  await page.getByRole('button', { name: '微积分' }).click();
  await page.waitForFunction(() => window.__streams.length === 1);
  const identity = { mapId: 'browser-map', mockMode: true };
  const send = (event, data, index = 0) => page.evaluate(({ event, data, index }) => {
    window.__streams[index].enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  }, { event, data, index });
  await send('outline', { ...outline, ...identity, progressScope: 'mock:test' });
  await page.locator('.knowledge-node').first().waitFor();
  await page.waitForTimeout(250);
  const node = page.locator('.react-flow__node-knowledge').first();
  const oldTransform = await node.getAttribute('style');
  const drag = await node.locator('.node-topline').boundingBox();
  await page.mouse.move(drag.x + 15, drag.y + 5);
  await page.mouse.down();
  await page.mouse.move(drag.x + 65, drag.y + 30, { steps: 8 });
  await page.mouse.up();
  const moved = await node.getAttribute('style');
  assert.notEqual(moved, oldTransform);
  await page.getByRole('button', { name: '放大', exact: true }).click();
  const viewport = await page.locator('.react-flow__viewport').getAttribute('style');
  await send('resource_ready', { ...identity, nodeId: 'functions', state: 'ready', resources, weight: 3 });
  await node.locator('.node-open').click();
  await send('resource_empty', { ...identity, nodeId: 'limits', state: 'empty', resources: [], weight: 0 });
  await send('resource_error', {
    ...identity, nodeId: 'derivatives', state: 'error', resources: [], weight: 0, errorCode: 'timeout',
    error: { code: 'UPSTREAM_TIMEOUT', message: '请求超时', retryable: true },
  });
  await send('resource_ready', { ...identity, nodeId: 'functions', state: 'ready', resources, weight: 3 });
  await send('complete', { ...identity, status: 'partial', completedNodeCount: 6, failedNodeCount: 1, generatedAt: 1 });
  await page.locator('.generation-status').filter({ hasText: '原始生成：部分资源失败' }).waitFor();
  assert.equal(await node.getAttribute('style'), moved);
  assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'), viewport);
  assert.equal(await page.locator('.satellite-node').count(), 3);
  assert.equal(await page.locator('.knowledge-node').count(), 6);
  await page.getByRole('button', { name: '重试 导数', exact: true }).click();
  await page.waitForFunction(() => window.__retryCalls === 1);
  await page.locator('.generation-status').filter({ hasText: '当前失败 0 个' }).waitFor();
  assert.ok((await page.locator('.generation-status').innerText()).includes('原始生成：部分资源失败'));
  await page.getByRole('button', { name: '摄影', exact: false }).click();
  await page.waitForFunction(() => window.__streams.length === 2);
  await send('outline', { ...outline, ...identity, topic: '摄影', progressScope: 'mock:photography' }, 1);
  await send('generation_error', { ...identity, error: {
    code: 'UPSTREAM_TIMEOUT', message: '生成超时，请重试', retryable: true,
  } }, 1);
  await page.getByRole('alert').filter({ hasText: '生成超时' }).waitFor();
  assert.equal(await page.locator('.overview-title h1').innerText(), '摄影');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ desktop: true, mobile: true, focus: true, dragPreserved: true,
    viewportPreserved: true, partialRetry: true, topicSwitch: true, screenshots: output }));
} finally { await browser.close(); }
