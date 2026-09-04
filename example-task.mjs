// 0 Token 复用示例：纯 Playwright 脚本，不经过 AI，直接跑，不烧 Token。
// 用法：node example-task.mjs [网址]   （不填则打开 example.com 演示）
// 说明：任何页面结构都是动态的，此文件只是“0-Token 脚本”的骨架示例——把要做的机械重复步骤写进
//       你自己的 .mjs 里（参考 taobao-monitor.mjs），之后每次直接跑即可，全程不经过 AI。
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { resolveProfileDir, resolveChannel, stealthFor } from './taobao-common.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE = resolveProfileDir({});
const CHANNEL = resolveChannel({});
const TARGET = process.argv[2] || 'https://example.com';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: CHANNEL,
  headless: false,
  viewport: { width: 1280, height: 850 },
  locale: 'zh-CN',
  ...stealthFor(CHANNEL),
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('导航提示:', e.message));
await page.waitForTimeout(4000);

console.log('页面标题:', await page.title().catch(() => '(未知)'));
console.log('页面 URL :', page.url());

const dir = join(DIR, 'output');
mkdirSync(dir, { recursive: true });
await page.screenshot({ path: join(dir, 'example-' + Date.now() + '.png'), fullPage: false }).catch(() => {});
console.log('已截图 -> output/example-*.png');
await ctx.close();
