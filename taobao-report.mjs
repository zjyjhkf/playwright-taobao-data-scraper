// 淘宝监控报告 v2：可读报告(report.md) + 可导入分析 CSV(exports/*.csv，UTF-8 BOM，Excel 可直接打开)
// 用法：node taobao-report.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
let CFG = {};
try { CFG = JSON.parse(readFileSync(join(DIR, 'taobao-config.json'), 'utf8')); } catch { /* 使用默认 */ }
const DATA = join(DIR, CFG.dataDir || 'taobao-data');
const EXPORT = join(DATA, 'exports');

function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

function byDay(snaps) {
  const map = new Map();
  for (const s of snaps) map.set(s.time.slice(0, 10), s);
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function diffList(a, b) {
  const sa = new Set(a || []);
  const sb = new Set(b || []);
  return { added: (b || []).filter((x) => !sa.has(x)), removed: (a || []).filter((x) => !sb.has(x)) };
}

function fmtDelta(n) {
  if (n == null) return '-';
  if (n === 0) return '0';
  return (n > 0 ? '+' : '') + n;
}

function fmtPos(d) {
  if (d == null) return '-';
  if (d === 0) return '持平';
  return d > 0 ? '↑' + d : '↓' + -d;
}

function sortBySold(items) {
  return [...(items || [])].sort((a, b) => {
    const na = a.sold == null ? -1 : a.sold;
    const nb = b.sold == null ? -1 : b.sold;
    return nb - na;
  });
}

// ---------- CSV 工具（UTF-8 BOM，Excel 可直接打开） ----------
function csvCell(v) {
  const s = v == null ? '' : String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? '"' + s + '"' : s;
}
function csvLine(arr) { return arr.map(csvCell).join(','); }
function writeCsv(file, headers, rows) {
  mkdirSync(EXPORT, { recursive: true });
  const text = [csvLine(headers), ...rows.map(csvLine)].join('\n') + '\n';
  writeFileSync(join(EXPORT, file), String.fromCharCode(0xFEFF) + text, 'utf8');
}

const out = [];
out.push('# 淘宝监控报告');
out.push('');
out.push('生成时间：' + new Date().toLocaleString('zh-CN'));
out.push('');
out.push('> 原始快照：taobao-data/products 与 taobao-data/rankings；可导入分析 CSV：taobao-data/exports/*.csv');
out.push('');

// ---------- 商品 ----------
const prodRoot = join(DATA, 'products');
const productList = [];
if (existsSync(prodRoot)) {
  for (const name of readdirSync(prodRoot)) {
    const dir = join(prodRoot, name);
    const files = listJson(dir);
    if (!files.length) continue;
    const snaps = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    const days = byDay(snaps);
    productList.push({ name, dir, days, latest: days[days.length - 1][1] });
  }
}

const prodDailyRows = [];
const prodHistoryRows = [];
const reviewRows = [];

if (productList.length) {
  // ① 商品销量排行
  const ranked = sortBySold(productList.map((p) => ({ ...p, sold: p.latest.sales })));
  out.push('## 商品销量排行（按最新销量降序）');
  out.push('');
  out.push('| 排名 | 商品 | 最新日期 | 最新价格 | 最新销量 | 店铺 | 评价数 | 好评率 |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  ranked.forEach((p, i) => {
    const L = p.latest;
    out.push('| ' + (i + 1) + ' | ' + p.name + ' | ' + L.time.slice(0, 10) + ' | ' + (L.price || '?') + ' | ' + (L.salesRaw || '?') + ' | ' + (L.shop || '?') + ' | ' + (L.reviewCount || '?') + ' | ' + (L.goodRate || '?') + ' |');
  });
  out.push('');

  // ② 逐商品明细 + CSV
  for (const { name, days } of productList) {
    out.push('## 商品：' + name);
    out.push('');
    out.push('| 日期 | 价格 | 销量 | 销量变化 | 图片数 | 图片状态 | 评价数 | 好评率 | 促销 |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    let prev = null;
    for (const [d, s] of days) {
      const delta = prev ? (s.sales != null && prev.sales != null ? s.sales - prev.sales : null) : null;
      const imgDiff = prev ? diffList(prev.images, s.images) : null;
      const hashDiff = prev ? diffList(prev.imageHashes, s.imageHashes) : null;
      let imgState = '无变化';
      if (imgDiff && (imgDiff.added.length || imgDiff.removed.length)) imgState = '链接变化';
      if (hashDiff && (hashDiff.added.length || hashDiff.removed.length)) imgState = imgState === '无变化' ? '内容变化' : imgState + '+内容变化';
      const promos = (s.promotions || []).join('/') || '无';
      out.push('| ' + d + ' | ' + (s.price || '?') + ' | ' + (s.salesRaw || '?') + ' | ' + fmtDelta(delta) + ' | ' + (s.images || []).length + ' | ' + imgState + ' | ' + (s.reviewCount || '?') + ' | ' + (s.goodRate || '?') + ' | ' + promos + ' |');
      prodDailyRows.push([d, name, s.price || '', s.salesRaw || '', delta == null ? '' : delta, (s.images || []).length, imgState, s.reviewCount || '', s.goodRate || '', promos]);
      prev = s;
    }
    out.push('');
    // 历史明细 CSV
    for (const s of days.map((x) => x[1])) {
      prodHistoryRows.push([s.time.slice(0, 19), name, s.price || '', s.salesRaw || '', s.sales == null ? '' : s.sales, s.shop || '', s.reviewCount || '', s.goodRate || '', (s.promotions || []).join('/') || '', (s.images || []).length]);
    }
    // 图片变更明细
    prev = null;
    for (const [d, s] of days) {
      if (prev) {
        const imgDiff = diffList(prev.images, s.images);
        const hashDiff = diffList(prev.imageHashes, s.imageHashes);
        if (imgDiff.added.length || imgDiff.removed.length || hashDiff.added.length || hashDiff.removed.length) {
          out.push('### ' + d + ' 图片变更明细');
          if (imgDiff.added.length) out.push('- 新增图片链接：' + imgDiff.added.length + ' 张');
          if (imgDiff.removed.length) out.push('- 移除图片链接：' + imgDiff.removed.length + ' 张');
          if (hashDiff.added.length || hashDiff.removed.length) out.push('- 图文件内容变化：' + hashDiff.added.length + ' 张新 / ' + hashDiff.removed.length + ' 张删');
        }
      }
      prev = s;
    }
    // 评论洞察（v3：读取最新一次评论快照，汇总卖点/痛点/高赞代表）
    const prodDir = join(prodRoot, name);
    const revRoot = join(prodDir, 'reviews');
    if (existsSync(revRoot)) {
      const revFiles = listJson(revRoot);
      if (revFiles.length) {
        const revSnap = JSON.parse(readFileSync(join(revRoot, revFiles[revFiles.length - 1]), 'utf8'));
        const sum = revSnap.summary || {};
        const ins = revSnap.insight || {};
        out.push('### 评论洞察（' + (revSnap.time || '').slice(0, 19).replace('T', ' ') + ' 采集 · 共 ' + sum.total + ' 条）');
        out.push('');
        out.push('- 情感分布：好评 ' + sum.positive + (sum.positiveRatio != null ? '（' + sum.positiveRatio + '%）' : '') + ' / 差评 ' + sum.negative + ' / 中性 ' + sum.neutral + ' ｜ 带图 ' + sum.withImage + ' ｜ 追评 ' + sum.withFollowUp);
        if ((sum.tags || []).length) out.push('- 大家印象：' + (sum.tags || []).map((t) => t.tag + '×' + t.count).join('、'));
        const hlikes = ins.topHighLike || [];
        if (hlikes.length) {
          out.push('');
          out.push('**高赞 / 带图 / 追评 代表（按「有用数 + 图文加权」排序）**');
          hlikes.forEach((h, i) => {
            out.push((i + 1) + '. ' + (h.flags ? '`' + h.flags + '` ' : '') + (h.date ? h.date + ' ' : '') + h.content);
          });
        }
        if ((ins.sellPoints || []).length) {
          out.push('');
          out.push('**好评卖点 TOP（高频词 → 代表性例句）**');
          (ins.sellPoints || []).forEach((t) => {
            out.push('- 「' + t.term + '」出现在 ' + t.count + ' 条好评' + (t.best && t.best.content ? '｜例（' + (t.best.likes ? '有用' + t.best.likes : '无点赞') + '）：' + t.best.content.slice(0, 90) : ''));
          });
        }
        if ((ins.painPoints || []).length) {
          out.push('');
          out.push('**差评痛点 TOP（重点观察）**');
          (ins.painPoints || []).forEach((t) => {
            out.push('- 「' + t.term + '」出现在 ' + t.count + ' 条差评' + (t.best && t.best.content ? '｜例：' + t.best.content.slice(0, 90) : ''));
          });
        }
        const repP = ((ins.representative || {}).positives || []).slice(0, 3);
        const repN = ((ins.representative || {}).negatives || []).slice(0, 3);
        if (repP.length) {
          out.push('');
          out.push('**代表好评**');
          repP.forEach((r) => out.push('- ' + (r.flags ? r.flags + ' ' : '') + r.content));
        }
        if (repN.length) {
          out.push('');
          out.push('**代表差评**');
          repN.forEach((r) => out.push('- ' + (r.flags ? r.flags + ' ' : '') + r.content));
        }
        out.push('');
        out.push('> 原始快照：products/' + name + '/reviews/ ｜ 明细 CSV：exports/reviews_latest.csv');
        out.push('');
        for (const r of revSnap.reviews || []) {
          reviewRows.push([name, (revSnap.time || '').slice(0, 10), r.likes == null ? '' : r.likes, r.content || '', r.hasImage ? '是' : '否', r.followUp || '', r.label || '']);
        }
      }
    }
    out.push('');
  }
}

// ---------- 竞品排行 ----------
const rankRoot = join(DATA, 'rankings');
const rankHistoryRows = [];
const rankLatestRows = [];
if (existsSync(rankRoot)) {
  for (const name of readdirSync(rankRoot)) {
    const dir = join(rankRoot, name);
    const files = listJson(dir);
    if (!files.length) continue;
    const snaps = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))).sort((a, b) => (a.time < b.time ? -1 : 1));
    const days = byDay(snaps);
    if (!days.length) continue;
    const last = days[days.length - 1][1];
    const prev = days.length >= 2 ? days[days.length - 2][1] : null;
    const kw = last.keyword || '';

    // 历史 CSV：每个快照的每条商品
    for (const [d, snap] of days) {
      for (const it of snap.items || []) {
        rankHistoryRows.push([d, kw, it.position, it.id, it.title || '', it.price || '', it.soldRaw || '', it.sold == null ? '' : it.sold, it.shop || '', it.isAd ? '是' : '否', it.isMine ? '我' : '']);
      }
    }

    out.push('## 竞品排行：' + name + '（关键词：' + kw + '，按销量降序）');
    out.push('');
    out.push('最近两次采集：' + (prev ? prev.time.slice(0, 10) : '无') + ' -> ' + last.time.slice(0, 10));
    out.push('');
    out.push('| 位次 | 位次变化 | 商品 | 价格 | 销量 | 销量变化 | 店铺 | 广告 | 自家 |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const lastSorted = sortBySold(last.items);
    const prevSorted = prev ? sortBySold(prev.items) : null;
    const prevRank = new Map((prevSorted || []).map((it, i) => [it.id, i + 1]));
    const prevById = new Map((prev ? prev.items : []).map((it) => [it.id, it]));
    lastSorted.forEach((it, i) => {
      const pos = i + 1;
      const p = prevById.get(it.id);
      const prevPos = prevRank.get(it.id);
      const posDelta = prevPos ? prevPos - pos : null;
      const soldDelta = p && it.sold != null && p.sold != null ? it.sold - p.sold : null;
      const titleChanged = p && p.title && it.title && p.title !== it.title ? '（标题已改）' : '';
      out.push('| ' + pos + ' | ' + fmtPos(posDelta) + ' | ' + it.title + titleChanged + ' | ' + (it.price || '?') + ' | ' + (it.soldRaw || '?') + ' | ' + fmtDelta(soldDelta) + ' | ' + (it.shop || '?') + ' | ' + (it.isAd ? '广告' : '自然') + ' | ' + (it.isMine ? '★我' : '') + ' |');
      rankLatestRows.push([kw, pos, it.id, it.title || '', it.price || '', it.soldRaw || '', it.sold == null ? '' : it.sold, it.shop || '', it.isAd ? '是' : '否', it.isMine ? '我' : '', posDelta == null ? '' : posDelta, soldDelta == null ? '' : soldDelta, titleChanged.replace(/（|）/g, '')]);
    });
    if (prev) {
      const dropped = (prevSorted || []).filter((it) => !lastSorted.some((x) => x.id === it.id));
      if (dropped.length) {
        out.push('');
        for (const it of dropped) out.push('- 掉出前' + prevSorted.length + '：' + it.title + '（原销量排名第 ' + (prevRank.get(it.id) || '?') + ' 名）');
      }
    }
    out.push('');
  }
}

// ---------- 写出 CSV ----------
writeCsv('products_daily.csv', ['日期', '商品', '价格', '销量', '销量变化', '图片数', '图片状态', '评价数', '好评率', '促销'], prodDailyRows);
writeCsv('products_history.csv', ['时间', '商品', '价格', '销量原文', '销量数字', '店铺', '评价数', '好评率', '促销', '图片数'], prodHistoryRows);
writeCsv('rankings_history.csv', ['日期', '关键词', '位次', '商品ID', '标题', '价格', '销量原文', '销量数字', '店铺', '广告', '自家'], rankHistoryRows);
writeCsv('rankings_latest.csv', ['关键词', '位次', '商品ID', '标题', '价格', '销量原文', '销量数字', '店铺', '广告', '自家', '位次变化', '销量变化', '标题变更'], rankLatestRows);
writeCsv('reviews_latest.csv', ['商品', '采集日期', '有用数', '内容', '带图', '追评', '情感'], reviewRows);

if (out.length <= 4) {
  console.log('taobao-data 下还没有快照。先运行：node taobao-monitor.mjs');
} else {
  const text = out.join('\n');
  writeFileSync(join(DATA, 'report.md'), text, 'utf8');
  console.log(text);
  console.log('');
  console.log('报告已保存：' + join(DATA, 'report.md'));
  console.log('可导入 CSV（Excel/pandas 可直接读）：' + EXPORT);
}
