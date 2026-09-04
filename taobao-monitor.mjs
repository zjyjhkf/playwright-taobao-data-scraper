// 淘宝商品信息监控 v2：在 v1 基础上新增竞品情报字段 + 风控节奏
// 新增：店铺/评价数/好评率/促销标签/发货承诺/DSR、竞品广告标识、自家商品排名标记、页间随机延时
// 用法：node taobao-monitor.mjs    （先 node login-helper.mjs 登录）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveProfileDir, resolveChannel, stealthFor } from './taobao-common.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));

let CFG;
try {
  CFG = JSON.parse(readFileSync(join(DIR, 'taobao-config.json'), 'utf8'));
} catch (e) {
  console.log('读取 taobao-config.json 失败：' + e.message);
  process.exit(1);
}
const DATA = join(DIR, CFG.dataDir || 'taobao-data');
const HEADLESS = !!CFG.headless;
const WAIT = CFG.waitAfterLoadMs || 3500;
// 风控节奏：页面之间随机等待，避免机器节奏触发风控
const MIN_DELAY = CFG.minDelayMs || 2500;
const MAX_DELAY = CFG.maxDelayMs || 6000;
const randDelay = () => new Promise((r) => setTimeout(r, MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY)));

// 浏览器通道与登录态目录：taobao-config.json 的 browserChannel / profileDir，未配置则用 ~/.taobao-edge-profile
const CHANNEL = resolveChannel(CFG);
const PROFILE = resolveProfileDir(CFG);
// 反自动化指纹（淘宝必需）：真实 UA + 关闭自动化标记
const STEALTH = stealthFor(CHANNEL);

// 自家商品 ID（用于在竞品排行里标记“我”）
const OWN_IDS = new Set((CFG.products || []).map((p) => { const m = String(p.url || '').match(/id=(\d+)/); return m ? m[1] : null; }).filter(Boolean));

function safe(name) { return String(name).replace(/[\\/:*?"<>|]/g, '_'); }

function parseSales(s) {
  if (!s) return null;
  const t = String(s).replace(/[，,]/g, '');
  const m = t.match(/([\d.]+)\s*万?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (t.includes('万')) n *= 10000;
  return Math.round(n);
}

function normalizeImg(u) {
  try {
    const url = new URL(u.replace(/^\/\//, 'https://'));
    url.search = '';
    return url.href;
  } catch { return u; }
}

const RISK_MARKS = ['安全验证', '滑动验证', '滑块', '请登录', '访问过于频繁', '小二正忙', '网络超时', '完成安全验证'];

async function detectRisk(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  return RISK_MARKS.filter((r) => body.includes(r));
}

async function waitEnter(msg) {
  if (process.stdin.isTTY) {
    console.log(msg);
    await new Promise((res) => { process.stdin.resume(); process.stdin.once('data', () => res()); });
  } else {
    console.log(msg + '（非交互模式，等待 60 秒）');
    await new Promise((res) => setTimeout(res, 60000));
  }
}

function tsSafe(d) { return d.toISOString().replace(/[:T]/g, '-').slice(0, 19); }

// ---------- 商品页附加情报字段 ----------
const PROMO_KEYS = ['超级立减', '直降', '补贴后', '优惠后', '首单价', '淘金币', '分期', '包邮', '运费险', '退货宝', '价保', '次日达', '满减', '政府补贴', '立减'];

function extractProductExtra(body) {
  const shopM = body.match(/([一-鿿A-Za-z0-9]{2,20}(?:旗舰店|专卖店|专营店|自营))/);
  const shop = shopM ? shopM[1] : null;
  const reviewCount = (body.match(/([\d.]+万?\+?)\s*条?评价/) || body.match(/([\d.]+万?\+?)\s*人?已?评价/) || body.match(/评价(?:数)?[^\d]{0,4}([\d.]+万?\+?)/) || [])[1] || null;
  const goodRate = (body.match(/好评率\s*(\d+(?:\.\d+)?%)/) || body.match(/(\d+(?:\.\d+)?%)\s*好评/) || [])[1] || null;
  const delivery = (body.match(/(\d+小时内发|次日达)/) || [])[1] || null;
  const promotions = [...new Set(PROMO_KEYS.filter((k) => body.includes(k)))].slice(0, 8);
  const dsrDesc = (body.match(/描述(?:相符)?[^\d]{0,8}(\d\.\d)/) || [])[1] || null;
  const dsrService = (body.match(/服务[^\d]{0,8}(\d\.\d)/) || [])[1] || null;
  const dsrLogistics = (body.match(/物流[^\d]{0,8}(\d\.\d)/) || [])[1] || null;
  return { shop, reviewCount, goodRate, delivery, promotions, dsrDesc, dsrService, dsrLogistics };
}

// ---------- 商品页快照 ----------
async function snapshotProduct(page, ctx, p) {
  console.log('>>> 抓取商品：' + p.name);
  await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('导航失败: ' + e.message));
  await page.waitForTimeout(WAIT);

  const risk = await detectRisk(page);
  if (risk.length) {
    console.log('检测到风控/验证：' + risk.join('、'));
    if (!HEADLESS) await waitEnter('请在窗口中完成验证（滑块/登录），完成后按回车继续...');
    await page.waitForTimeout(2000);
  }

  const body = await page.locator('body').innerText().catch(() => '');
  const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content').catch(() => null);
  const ogImg = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);
  const imgs = await page.locator('img').evaluateAll((els) => els.map((e) => e.currentSrc || e.src).filter(Boolean)).catch(() => []);
  const price = (body.match(/[¥￥]\s*([\d.,]+)/) || [])[1] || null;
  const salesRaw = (body.match(/月销\s*([\d.,]+万?\+?)/) || body.match(/已售\s*([\d.,]+万?\+?)/) || body.match(/([\d.,]+万?\+?)\s*人付款/) || [])[0] || null;
  const images = [...new Set([ogImg, ...imgs].filter(Boolean).map(normalizeImg))].slice(0, 12);
  const extra = extractProductExtra(body);

  // 下载主图并哈希（可发现“同一链接换了图”）
  const imageHashes = [];
  const imgDir = join(DATA, 'products', safe(p.name), 'images', tsSafe(new Date()));
  for (const u of images.slice(0, 6)) {
    try {
      const res = await ctx.request.get(u, { timeout: 20000 });
      if (res.ok()) {
        const buf = await res.body();
        const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
        imageHashes.push(hash);
        mkdirSync(imgDir, { recursive: true });
        writeFileSync(join(imgDir, hash + '.jpg'), buf);
      }
    } catch (e) { /* 单张图片失败忽略 */ }
  }

  const snap = {
    time: new Date().toISOString(),
    name: p.name,
    url: page.url(),
    title: ogTitle || (await page.title().catch(() => '')),
    price,
    salesRaw,
    sales: parseSales(salesRaw),
    images,
    imageHashes,
    ...extra,
  };
  const dir = join(DATA, 'products', safe(p.name));
  mkdirSync(dir, { recursive: true });
  const ts = tsSafe(new Date());
  writeFileSync(join(dir, ts + '.json'), JSON.stringify(snap, null, 2));
  await page.screenshot({ path: join(dir, ts + '.png'), fullPage: false }).catch(() => {});
  console.log('  已保存快照: ' + ts + ' | 销量: ' + (snap.salesRaw || '?') + ' | 价格: ' + (snap.price || '?') + ' | 店铺: ' + (snap.shop || '?') + ' | 评价: ' + (snap.reviewCount || '?') + ' | 好评率: ' + (snap.goodRate || '?') + ' | 促销: ' + (snap.promotions.length ? snap.promotions.join('/') : '无'));
}

// ---------- 搜索页排行快照 ----------
async function snapshotRanking(page, r) {
  const u = new URL('https://s.taobao.com/search');
  u.searchParams.set('q', r.keyword);
  if (r.sort && r.sort !== 'default') u.searchParams.set('sort', r.sort);
  const url = u.href;
  console.log('>>> 抓取排行：' + r.name + ' -> ' + url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('导航失败: ' + e.message));
  await page.waitForTimeout(WAIT + 2000);

  const risk = await detectRisk(page);
  if (risk.length) {
    console.log('检测到风控/验证：' + risk.join('、'));
    if (!HEADLESS) await waitEnter('请在窗口中完成验证后按回车继续...');
  }

  for (let s = 0; s < 3; s++) {
    await page.evaluate(() => window.scrollBy(0, 2500)).catch(() => {});
    await page.waitForTimeout(1200);
  }

  const topN = r.topN || 20;
  const items = [];
  const links = page.locator('a[href*="item.htm?id="]');
  const total = Math.min(await links.count(), topN * 4);
  for (let i = 0; i < total; i++) {
    const info = await links.nth(i).evaluate((el) => {
      const href = el.href || '';
      const idM = href.match(/id=(\d+)/);
      const id = idM ? idM[1] : null;
      if (!id) return null;
      const isAd = /ad_ztc|xxc=ad|simba/i.test(href);
      const title = (el.innerText || el.getAttribute('title') || '').trim().split('\n').find((l) => l.trim().length > 2)?.trim().slice(0, 60) || '';
      const parseSold = (s) => { if (!s) return null; const t = String(s).replace(/[，,]/g, ''); const m = t.match(/([\d.]+)\s*万?/); if (!m) return null; let n = parseFloat(m[1]); if (t.includes('万')) n *= 10000; return Math.round(n); };
      let price = null, sold = null, soldRaw = null, cardText = '';
      let cur = el;
      for (let d = 0; d < 7 && cur; d++) {
        const t = (cur.innerText || '').replace(/\s+/g, ' ');
        if (price == null) { const pm = t.match(/[¥￥]\s*([\d.,]+)/); if (pm) price = pm[1]; }
        if (sold == null) {
          const sm1 = t.match(/([\d.,]+万?\+?)\s*人付款/);
          const sm2 = t.match(/(已售|月销|付款)\s*([\d.,]+万?\+?)/);
          if (sm1) { soldRaw = sm1[1] + '人付款'; sold = parseSold(sm1[1]); }
          else if (sm2) { soldRaw = sm2[1] + ' ' + sm2[2]; sold = parseSold(sm2[2]); }
        }
        // 记录包含价格/销量的那一层文本 = 卡片级文本（店铺一般在卡片底部）
        if (!cardText && (price != null || sold != null)) cardText = t;
        cur = cur.parentElement;
      }
      const shops = cardText ? cardText.match(/([一-鿿A-Za-z0-9]{2,20}(?:旗舰店|专卖店|专营店|自营|官方店|运动复健))/g) : null;
      const shop = shops ? shops[shops.length - 1] : null;
      return { id, isAd, title, price, soldRaw, sold, shop };
    }).catch(() => null);
    if (info && info.id && !items.some((x) => x.id === info.id)) {
      items.push({ position: items.length + 1, ...info });
    }
    if (items.length >= topN) break;
  }

  // 标记自家商品在榜单中的位置
  for (const it of items) it.isMine = OWN_IDS.has(it.id);

  const snap = { time: new Date().toISOString(), name: r.name, keyword: r.keyword, url, items };
  const dir = join(DATA, 'rankings', safe(r.name));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, tsSafe(new Date()) + '.json'), JSON.stringify(snap, null, 2));
  if (!items.length) {
    await page.screenshot({ path: join(dir, 'debug-empty-' + tsSafe(new Date()) + '.png') }).catch(() => {});
    console.log('  ⚠️ 排行 0 条：已保存调试截图，请发给 Claude Code 排查');
  }
  const mine = items.filter((x) => x.isMine).map((x) => '第' + x.position + '名').join(',') || '不在榜';
  console.log('  已保存排行快照: ' + items.length + ' 条 | 自家商品: ' + mine);
}

// ---------- 评论抓取与结构化洞察（v3.1） ----------
// 目标：抓取商品页公开评论，优先「高赞 / 带图 / 追评」；提炼代表性好评卖点与差评痛点，输出结构化洞察。
// v3.1 修复（2026-09-04 实测诊断）：① 评论块去重改为“正文长度分层 + 最小叶子”取块，避免“作者+日期”短行抢先占位；② 增加窗口+内层容器滚动（天猫新版评论懒加载）；③ 捕获模块头部“用户评价·N+ 大家都在说”聚合标签。
// 说明：DOM 随淘宝改版/登录墙会变化——评论抓空时保存 debug-reviews-empty-*.png，把截图交给 Claude Code 修复即可。
const RV = Object.assign({
  enabled: true, maxTotal: 60, scrollRounds: 5,
  filters: ['图片', '追评', '差评'],
  minLen: 8, topHighLike: 8, topTerms: 12,
}, CFG.reviews || {});

// 卖点/痛点种子词典（按类目可在 taobao-config.json 的 reviews.terms 补充自定义词）
const RV_POS_TERMS = (CFG.reviews && CFG.reviews.terms && CFG.reviews.terms.positive) || [
  '舒服', '舒适', '放松', '缓解', '恢复', '有效', '推荐', '不错', '满意', '惊喜', '好用', '质量好', '做工',
  '面料', '透气', '静音', '轻柔', '轻便', '方便', '贴合', '包裹', '支撑', '专业', '性价比', '超值', '回购',
  '耐用', '售后', '正品', '包装', '实用', '效果明显', '恢复快', '气压足', '力度合适', '充电方便', '无噪音', '服务好', '快递快', '值得'
];
const RV_NEG_TERMS = (CFG.reviews && CFG.reviews.terms && CFG.reviews.terms.negative) || [
  '漏气', '充气不足', '气压不足', '噪音', '声音大', '太硬', '硌', '勒', '太紧', '闷', '不透气', '异味',
  '粗糙', '开线', '坏了', '失灵', '没反应', '没用', '无效', '效果差', '恢复慢', '失望', '退货', '退款',
  '客服差', '发货慢', '物流慢', '虚假', '夸大', '不值', '浪费', '故障', '容易坏', '太吵', '一直响', '有味道', '松', '力度小'
];

const RV_DATE_RE = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/;
const pad2 = (n) => String(n).padStart(2, '0');

// 页内收集候选评论块：取「含日期」的最小叶子级文本块并去重。
// 关键：分层正文长度过滤（>=32，不足再放宽到 >=20），先剔除“作者+日期”短行，避免整条评论被当成容器丢掉。
async function collectReviewBlocks(page) {
  const blocks = await page.evaluate(() => {
    const dateRe = /(20\d{2})[-/.年]\d{1,2}[-/.月]\d{1,2}|\d{1,2}天前/;
    const pick = (minLen) => {
      const cand = [];
      for (const el of document.querySelectorAll('div,li,section,article')) {
        if (el.offsetParent === null) continue;
        const t = (el.innerText || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        if (t.length < minLen || t.length > 900) continue;
        if (!dateRe.test(t)) continue;
        if (/问：|答：|用户评价|大家都在说/.test(t)) continue;
        const imgs = Array.from(el.querySelectorAll('img')).map((i) => i.currentSrc || i.src || '').filter((s) => /alicdn|taobaocdn|tbcdn/.test(s));
        cand.push({ el, t, imgs });
      }
      cand.sort((a, b) => a.t.length - b.t.length);
      const accepted = [];
      for (const c of cand) {
        if (accepted.some((a) => a.el.contains(c.el) || c.el.contains(a.el))) continue;
        accepted.push(c);
        if (accepted.length >= 80) break;
      }
      return accepted;
    };
    let acc = pick(32);
    if (acc.length < 2) acc = acc.concat(pick(20));
    const seen = new Set();
    const uniq = [];
    for (const c of acc) {
      const key = c.t.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push({ text: c.t, images: c.imgs.slice(0, 9) });
    }
    return uniq;
  }).catch(() => []);
  return blocks;
}

// 滚动加载：窗口下滚 + 页面内可滚动容器滚到底（天猫新版评论为懒加载/虚拟滚动）
async function scrollReviewsPage(page, rounds) {
  for (let s = 0; s < rounds; s++) {
    await page.evaluate(() => window.scrollBy(0, 1600)).catch(() => {});
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('div,section,ul')) {
        try { if (el.scrollHeight > el.clientHeight + 60 && el.clientWidth > 400) el.scrollTop = el.scrollHeight; } catch (e) { /* ignore */ }
      }
    }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1200);
}

// 模块头部聚合标签（“用户评价·200+ 用起来很方便7 排酸有用4 …” 这类大家印象词）
async function collectSummaryTags(page) {
  const tags = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div,section'));
    const hits = els.filter((el) => {
      if (el.offsetParent === null) return false;
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      return t.startsWith('用户评价') && t.length > 120;
    }).sort((a, b) => a.innerText.length - b.innerText.length);
    const root = hits[0];
    if (!root) return [];
    const text = root.innerText.replace(/\s+/g, ' ');
    const end = text.search(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}|\d{1,2}天前/);
    const head = (end > 0 ? text.slice(0, end) : text).replace(/^用户评价[·\d+]*/, '');
    const out = [];
    const re = /([\u4e00-\u9fa5A-Za-z]{2,10}?)(\d{1,3})/g;
    let m;
    while ((m = re.exec(head)) !== null) {
      out.push({ tag: m[1], count: parseInt(m[2], 10) });
      if (out.length >= 15) break;
    }
    return out;
  }).catch(() => []);
  return tags;
}

// 从评论块文本解析字段（作者已脱敏；“匿名买家”等前缀与日期/点赞数一并剔除）
function parseReviewBlock(raw) {
  const text = String(raw.text || '').replace(/\u00a0/g, ' ');
  const dm = text.match(RV_DATE_RE);
  const date = dm ? dm[1] + '-' + pad2(+dm[2]) + '-' + pad2(+dm[3]) : null;
  const likesM = text.match(/有用\s*[（(]\s*(\d+)\s*[)）]/);
  const likes = likesM ? parseInt(likesM[1], 10) : 0;
  let followUp = null;
  let mainText = text;
  const fuM = mainText.match(/追评(?:[：:\s]*)(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})?\s*/);
  if (fuM) {
    followUp = mainText.slice(fuM.index + fuM[0].length).trim();
    mainText = mainText.slice(0, fuM.index);
  }
  let content = mainText
    .replace(/(20\d{2})[-/.年]\d{1,2}[-/.月]\d{1,2}/g, ' ')
    .replace(/\d{1,2}天前/g, ' ')
    .replace(/[^*\s]{1,24}\*{1,4}\s*/g, ' ')
    .replace(/(匿名买家|匿名用户|该会员|买家已买过)/g, ' ')
    .replace(/有用\s*[（(]\s*\d+\s*[)）]/g, ' ')
    .replace(/\b(回复|举报|投诉|分享)\b/g, ' ')
    .replace(/[★☆]+/g, '')
    .replace(/[\s|#/\\,，。;；:：'"“”‘’()（）]+/g, '')
    .trim();
  if (!content || content.length < RV.minLen) return null;
  const images = (raw.images || []).filter(Boolean);
  const fu = followUp ? followUp.replace(/\s+/g, '').slice(0, 200) : null;
  return {
    date, likes, content: content.slice(0, 300), followUp: fu && fu.length >= 4 ? fu : null,
    hasImage: images.length > 0, images: images.slice(0, 6),
  };
}

// 情感粗分类：好评 / 差评 / 中性（词典打分）
function classifyReview(r) {
  const c = (r.content || '') + (r.followUp || '');
  let pos = 0, neg = 0;
  for (const t of RV_POS_TERMS) if (c.includes(t)) pos++;
  for (const t of RV_NEG_TERMS) if (c.includes(t)) neg++;
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

function pickBrief(r) {
  const flags = [(r.likes ? '有用' + r.likes : ''), (r.hasImage ? '带图' : ''), (r.followUp ? '追评' : '')].filter(Boolean).join('·');
  const c = (r.content || '') + (r.followUp ? '（追评：' + r.followUp + '）' : '');
  return { date: r.date || null, likes: r.likes, flags, content: c.slice(0, 140) };
}

// 结构化洞察：按「有用数×100 + 带图×12 + 追评×15」加权排序 → 高赞/带图/追评代表；词频 → 卖点/痛点；代表性好评/差评
function buildInsight(reviews) {
  const rs = reviews.filter((r) => r.content);
  const labeled = rs.map((r) => ({ ...r, label: classifyReview(r) }));
  const posR = labeled.filter((r) => r.label === 'positive');
  const negR = labeled.filter((r) => r.label === 'negative');
  const neutral = labeled.length - posR.length - negR.length;
  const score = (r) => (r.likes || 0) * 100 + (r.hasImage ? 12 : 0) + (r.followUp ? 15 : 0);
  const ranked = [...labeled].sort((a, b) => score(b) - score(a));
  const topHighLike = ranked.slice(0, RV.topHighLike).map(pickBrief);
  const countTerms = (list, terms) => {
    const map = new Map();
    for (const r of list) {
      for (const t of terms) {
        if ((r.content || '').includes(t) || (r.followUp || '').includes(t)) {
          if (!map.has(t)) map.set(t, { term: t, count: 0, best: null });
          const e = map.get(t);
          e.count++;
          if (!e.best || (r.likes || 0) > (e.best.likes || 0)) e.best = pickBrief(r);
        }
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  };
  const sellPoints = countTerms(posR, RV_POS_TERMS).filter((x) => x.count >= 2).slice(0, RV.topTerms);
  const painPoints = countTerms(negR, RV_NEG_TERMS).filter((x) => x.count >= 1).slice(0, RV.topTerms);
  const reps = (list) => ranked.filter((r) => r.label === list).slice(0, 3).map(pickBrief);
  return {
    total: labeled.length, positive: posR.length, negative: negR.length, neutral,
    withImage: labeled.filter((r) => r.hasImage).length,
    withFollowUp: labeled.filter((r) => r.followUp).length,
    positiveRatio: labeled.length ? +((posR.length / labeled.length) * 100).toFixed(1) : null,
    topHighLike, sellPoints, painPoints,
    representative: { positives: reps('positive'), negatives: reps('negative') },
  };
}

// 尝试点击文本匹配的可点击元素（筛选/展开按钮），找不到返回 false
async function clickReviewFilter(page, label) {
  const ok = await page.evaluate((lab) => {
    const els = Array.from(document.querySelectorAll('a,button,li,span,em,div'));
    const hits = els.filter((el) => {
      if (el.offsetParent === null) return false;
      const t = (el.innerText || '').trim();
      if (!(t === lab || t.startsWith(lab + '(') || t.startsWith(lab + '（') || t === '有' + lab)) return false;
      return el.getElementsByTagName('*').length <= 3;
    }).sort((a, b) => a.innerText.length - b.innerText.length);
    const el = hits[0];
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, label).catch(() => false);
  return ok;
}

// 商品评论快照：默认视图滚动采集 → 展开/筛选(图片/追评/差评) → 高赞/带图/追评加权洞察
async function snapshotReviews(page, p) {
  console.log('>>> 抓取评论：' + p.name + '（优先 高赞 / 带图 / 追评）');
  const risk = await detectRisk(page);
  if (risk.length) {
    console.log('检测到风控/验证：' + risk.join('、'));
    if (!HEADLESS) await waitEnter('请在窗口中完成验证后按回车继续...');
    await page.waitForTimeout(2000);
  }
  const pool = new Map();
  const add = (raw) => {
    const r = parseReviewBlock(raw);
    if (!r) return;
    const key = (r.content || '') + '|' + (r.followUp || '');
    if (!pool.has(key)) pool.set(key, r);
  };
  const collect = async (view) => {
    const before = pool.size;
    const blocks = await collectReviewBlocks(page);
    for (const b of blocks) add(b);
    console.log('  [' + view + '] 候选 ' + blocks.length + ' 块，累计去重 ' + pool.size + ' 条' + (pool.size > before ? '' : '（无新增）'));
  };
  // 1) 默认/全部视图：滚动加载
  await scrollReviewsPage(page, Math.max(3, RV.scrollRounds));
  await collect('默认/全部');
  // 2) 若太少，尝试点开“查看全部/展开”类入口
  if (pool.size < 5) {
    const openLabels = ['查看全部评价', '全部评价', '查看更多评价', '展开全部'];
    for (const lab of openLabels) {
      if (await clickReviewFilter(page, lab)) {
        console.log('  已点击「' + lab + '」展开更多评价');
        await scrollReviewsPage(page, 2);
        await collect('展开后');
        break;
      }
    }
  }
  // 3) 筛选视图：图片(带图) / 追评 / 差评（找不到自动跳过）
  const views = [];
  for (const f of RV.filters) {
    if (pool.size >= RV.maxTotal) break;
    const ok = await clickReviewFilter(page, f);
    if (ok) {
      views.push(f);
      console.log('  已切换到筛选：' + f);
      await scrollReviewsPage(page, 2);
      await collect('筛选:' + f);
    } else {
      console.log('  未找到筛选「' + f + '」（改版/需登录则跳过）');
    }
  }
  // 4) 洞察并落盘（>=1 条也保存，便于增量观察）
  const reviews = [...pool.values()];
  const dirP = join(DATA, 'products', safe(p.name));
  if (!reviews.length) {
    const dbg = join(dirP, 'debug-reviews-empty-' + tsSafe(new Date()) + '.png');
    await page.screenshot({ path: dbg }).catch(() => {});
    console.log('  ⚠️ 评论 0 条：调试截图 ' + dbg + '，请发给 Claude Code 修复');
    return;
  }
  const summaryTags = await collectSummaryTags(page);
  const insight = buildInsight(reviews);
  const top3 = reviews.slice().sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 3);
  console.log('  ✔ 评论 ' + reviews.length + ' 条 | 高赞TOP:' + top3.map((t) => t.likes).join('/') + ' | 好评' + insight.positive + ' 差评' + insight.negative + ' 中性' + insight.neutral + ' | 带图' + insight.withImage + ' 追评' + insight.withFollowUp + (summaryTags.length ? ' | 印象标签' + summaryTags.length + ' 个' : ''));
  const snap = {
    time: new Date().toISOString(), product: p.name, url: p.url,
    filtersUsed: ['默认/全部', ...views],
    summary: {
      total: insight.total, positive: insight.positive, negative: insight.negative, neutral: insight.neutral,
      withImage: insight.withImage, withFollowUp: insight.withFollowUp, positiveRatio: insight.positiveRatio,
      tags: summaryTags,
    },
    insight: { topHighLike: insight.topHighLike, sellPoints: insight.sellPoints, painPoints: insight.painPoints, representative: insight.representative },
    reviews: reviews.slice(0, RV.maxTotal).map((r) => ({ date: r.date, likes: r.likes, label: classifyReview(r), content: r.content, hasImage: r.hasImage, images: r.images, followUp: r.followUp })),
  };
  const dir = join(dirP, 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, tsSafe(new Date()) + '.json'), JSON.stringify(snap, null, 2));
  console.log('  评论快照已保存到 products/' + safe(p.name) + '/reviews/');
}
// ---------- 主流程 ----------
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: CHANNEL,
  headless: HEADLESS,
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  ...STEALTH,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
console.log('开始监控 @ ' + new Date().toLocaleString('zh-CN'));
for (const p of CFG.products || []) {
  await snapshotProduct(page, ctx, p);
  if (RV.enabled) await snapshotReviews(page, p);
  await randDelay();
}
for (const r of CFG.rankings || []) { await snapshotRanking(page, r); await randDelay(); }
await ctx.close();
console.log('全部完成 @ ' + new Date().toLocaleString('zh-CN'));