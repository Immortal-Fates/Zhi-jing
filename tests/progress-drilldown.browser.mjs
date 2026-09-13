import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
const outline = JSON.parse(await readFile('fixtures/outline-calculus.json', 'utf8'));
const output = '/tmp/zhijing-progress-drilldown';
await mkdir(output, { recursive: true });
const resource = { title: '测试文章', url: 'https://www.zhihu.com/answer/123',
  contentId: '123', contentType: 'Answer', author: '测试作者', excerpt: '测试',
  voteUpCount: 10, commentCount: 2, editTime: 1, score: 1 };
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failChild = false;
try {
  await page.context().route('https://www.zhihu.com/**', (route) => route.fulfill({ body: 'Test article' }));
  await page.route('**/api/generate', async (route) => {
    const { topic } = route.request().postDataJSON();
    if (topic === '函数基础' && failChild) {
      return route.fulfill({ status: 504, contentType: 'application/json',
        body: JSON.stringify({ mockMode: false, error: { code: 'UPSTREAM_TIMEOUT', message: '下钻测试失败', retryable: true } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      ...outline, topic, mapId: `version-${topic}`, progressScope: `map_${topic}`, mockMode: false,
      generatedAt: 1, completedNodeCount: 6, failedNodeCount: 0, status: 'complete',
      nodes: outline.nodes.map((node) => ({ ...node, state: 'ready', resources: [resource], weight: 1 })),
    }) });
  });
  await page.goto(process.env.TEST_BASE_URL ?? 'http://127.0.0.1:4173');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('unrelated', 'keep'); });
  await page.getByRole('button', { name: '微积分', exact: true }).click();
  await page.locator('.knowledge-node').first().waitFor();
  await page.waitForTimeout(200);
  await page.locator('.node-open').first().click();
  assert.ok((await page.locator('.learning-progress').innerText()).includes('已学 0 / 6'));
  const popupPromise = page.waitForEvent('popup');
  await page.locator('.satellite-node a').first().click();
  const popup = await popupPromise;
  await popup.close();
  assert.ok((await page.locator('.learning-progress').innerText()).includes('已学 1 / 6'));
  assert.equal(await page.locator('.knowledge-node').first().getAttribute('data-learned'), 'true');
  await page.reload();
  await page.locator('.knowledge-node').first().waitFor();
  await page.waitForTimeout(200);
  assert.ok((await page.locator('.learning-progress').innerText()).includes('已学 1 / 6'));
  const node = page.locator('.react-flow__node-knowledge').first();
  const drag = await node.locator('.node-topline').boundingBox();
  await page.mouse.move(drag.x + 10, drag.y + 5); await page.mouse.down();
  await page.mouse.move(drag.x + 55, drag.y + 25, { steps: 6 }); await page.mouse.up();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await node.locator('.node-open').click();
  const transform = await node.getAttribute('style');
  const viewport = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.screenshot({ path: `${output}/desktop-progress.png` });
  await page.getByRole('button', { name: '下钻 函数基础', exact: true }).click();
  await page.locator('.breadcrumbs').waitFor();
  await page.locator('.overview-title h1').filter({ hasText: '函数基础' }).waitFor();
  assert.ok((await page.locator('.learning-progress').innerText()).includes('已学 0 / 6'));
  assert.equal(await page.getByRole('button', { name: /^下钻 / }).count(), 0);
  await page.screenshot({ path: `${output}/desktop-child.png` });
  await page.locator('.breadcrumbs').getByRole('button', { name: '微积分' }).click();
  await page.locator('.satellite-node').waitFor();
  assert.equal(await node.getAttribute('style'), transform);
  assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'), viewport);
  assert.ok((await page.locator('.learning-progress').innerText()).includes('已学 1 / 6'));
  failChild = true;
  await page.getByRole('button', { name: '下钻 函数基础', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '下钻测试失败' }).waitFor();
  await page.getByRole('button', { name: '返回上级', exact: true }).click();
  assert.equal(await node.getAttribute('style'), transform);
  assert.equal(await page.locator('.satellite-node').count(), 1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '清除本地学习进度' }).click();
  assert.ok((await page.locator('.learning-progress').innerText()).includes('已学 0 / 6'));
  assert.equal(await page.evaluate(() => localStorage.getItem('unrelated')), 'keep');
  assert.equal(await page.locator('.knowledge-node').count(), 6);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload(); await page.locator('.knowledge-node').first().waitFor();
  await page.getByRole('button', { name: '查看 函数基础 资源' }).click();
  await page.locator('dialog[open]').waitFor();
  await page.screenshot({ path: `${output}/mobile-drawer.png` });
  failChild = false;
  await page.getByRole('button', { name: '以此为中心展开', exact: true }).click();
  await page.locator('.overview-title h1').filter({ hasText: '函数基础' }).waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.screenshot({ path: `${output}/mobile-child.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('.breadcrumbs').getByRole('button', { name: '微积分' }).click();
  await page.locator('dialog[open]').waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ resourceClick: true, refresh: true, clearIsolation: true,
    drilldown: true, failurePreservesParent: true, viewportRestored: true, mobile: true, screenshots: output }));
} finally { await browser.close(); }
