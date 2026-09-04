// 一次性登录助手（带验证）：打开目标网站 → 引导扫码 → 自动检测登录凭证 web_session 写入才算成功
// 用法：node login-helper.mjs [网址]   （不填默认淘宝）
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolveProfileDir, resolveChannel, stealthFor } from './taobao-common.mjs';
process.chdir(dirname(fileURLToPath(import.meta.url)));

let CFG = {};
try { CFG = JSON.parse(readFileSync('taobao-config.json', 'utf8')); } catch (e) { /* 无配置也允许：走默认 profile */ }

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  console.log('❌ 找不到 playwright 包。先执行：npm install');
  process.exit(1);
}

const PROFILE = resolveProfileDir(CFG);
const CHANNEL = resolveChannel(CFG);
const TARGET = process.argv[2] || 'https://www.taobao.com/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: CHANNEL,
  headless: false,
  viewport: { width: 1366, height: 850 },
  locale: 'zh-CN',
  ...stealthFor(CHANNEL),
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(TARGET, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(3000);

const SESSION_COOKIES = ['web_session', 'cookie2', 'tracknick'];
const hasSession = async () =>
  (await ctx.cookies(['https://www.taobao.com', 'https://s.taobao.com'])).some((c) => SESSION_COOKIES.includes(c.name));

if (await hasSession()) {
  console.log('✅ 已检测到登录（web_session 存在），无需再登录。按回车退出。');
} else {
  console.log('⚠️ 当前自动化配置未登录（没有 web_session）。');
  console.log('请在窗口里完成登录：');
  console.log('  1) 点页面右上角「登录」按钮；');
  console.log('  2) 弹出二维码后用手机淘宝 App 扫码并确认；');
  console.log('  3) 若出现滑块验证，滑一下。');
  console.log('系统每 2 秒自动检测登录是否成功；成功后自动保存。');

  const btn = page.locator('text=登录').first();
  if (await btn.count()) await btn.click({ timeout: 3000 }).catch(() => {});

  let enterPressed = false;
  process.stdin.resume();
  process.stdin.once('data', () => { enterPressed = true; });

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline && !enterPressed) {
    if (await hasSession()) break;
    await sleep(2000);
  }

  if (await hasSession()) console.log('✅ 登录成功！web_session 已写入自动化配置。');
  else console.log('⚠️ 5 分钟内未检测到 web_session。若你确认已登录，按回车保存退出（后续搜索可能仍受限）。');
}

await ctx.close();
console.log('登录态目录：' + PROFILE);
