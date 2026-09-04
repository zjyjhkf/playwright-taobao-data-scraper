# 淘宝商品公开信息监控 · Taobao Public Monitor

> 纯本地运行的商品公开信息监控工具：**商品页快照（价格/销量/主图/店铺/评价数）+ 搜索排行 + 评论抓取与结构化洞察**。
> 核心卖点是 **0 Token 复用**：调试阶段用 AI 调一次，之后每天双击脚本直接跑，全程不再经过 AI。

中文说明为主，末尾附英文一句话简介（English summary）。

---

## 一、功能特性

| 模块 | 能力 |
| --- | --- |
| 商品监控 | 商品页标题 / 价格 / 销量（月销·已售·人付款）/ 12 张主图（下载 + SHA-256 指纹，能发现「同链接换图」）/ 店铺 / 评价数 / 好评率 / 促销标签 / 发货承诺 / DSR |
| 竞品排行 | 按关键词搜索并**按销量排序**取 TOP N：位次升降、销量变化、广告标识、自家商品标记、掉榜追踪 |
| 评论洞察（v3） | 抓取商品页公开评论，**优先高赞 / 带图 / 追评**；词典情感分类 + 高频词提炼**好评卖点 / 差评痛点**；输出结构化 JSON + 报告小节 + CSV |
| 报告与导出 | 每天一份快照，报告脚本对比历史：销量波动 / 图片变更 / 排行变化 / 评论洞察；同时导出 UTF-8 BOM CSV（Excel / pandas 直接读） |
| 0 Token 运行 | 采集、报告均为纯 Playwright 脚本，无 AI 调用，可配 Windows 任务计划每天自动跑 |

## 二、目录结构

```
browser-automation/
├─ taobao-common.mjs        # 共享配置解析（profile 目录 / 浏览器通道 / 反自动化指纹）
├─ taobao-config.example.json  # 配置模板 → 复制为 taobao-config.json 后使用
├─ taobao-config.json       # 【个人】你的配置（git 已忽略，勿提交）
├─ taobao-monitor.mjs       # 采集脚本（商品快照 + 搜索排行 + 评论抓取）
├─ taobao-report.mjs        # 报告脚本（report.md + exports/*.csv）
├─ login-helper.mjs         # 登录助手（打开自动化浏览器扫码，登录态持久化）
├─ example-task.mjs         # 0-Token 示例骨架（node example-task.mjs [网址]）
├─ start-login.cmd / start-monitor.cmd / start-report.cmd  # Windows 双击入口
├─ .mcp.json.example        # 【可选】Claude Code + Playwright MCP 配置模板
├─ package.json             # npm 依赖（playwright）
├─ taobao-data/             # 【生成】快照 / 报告 / CSV（git 已忽略）
│  ├─ products/<商品名>/<时间戳>.json|.png    # 商品快照+截图
│  │   └─ reviews/<时间戳>.json               # 评论快照与洞察
│  ├─ rankings/<关键词>/<时间戳>.json         # 排行快照
│  ├─ report.md             # 可读报告（VSCode 预览）
│  └─ exports/*.csv         # 可导入分析 CSV
└─ output/                  # 【生成】示例/临时输出（git 已忽略）
```

## 三、环境要求

- Windows（10/11）+ **Microsoft Edge**（系统自带即可；也支持 Chrome，改配置 browserChannel）
- [Node.js](https://nodejs.org) ≥ 18（自带 npm）
- 手机淘宝 App（扫码登录用，仅首次 + 登录过期时需要）
- 网络可访问淘宝/天猫

无需安装 Playwright 自带浏览器：脚本走 `channel: msedge` 直接驱动你电脑里已装的 Edge。

## 四、快速开始（6 步）

### ① 安装依赖
```bash
cd browser-automation
npm install
```

### ② 准备配置
```bash
# Windows
copy taobao-config.example.json taobao-config.json
# 或 macOS/Linux 同理：cp taobao-config.example.json taobao-config.json
```
用编辑器打开 `taobao-config.json`：
- `products`：改成你要盯的商品（`name` 商品名可中文；`url` 商品链接，淘宝 `item.taobao.com` 或天猫 `detail.tmall.com` 均可，可多个）；
- `rankings`：竞品关键词（`keyword`、`topN`、`sort: "sale-desc"` 按销量）；
- `profileDir`：自动化浏览器登录态目录，默认 `~/.taobao-edge-profile`，一般不用改。

### ③ 登录淘宝（只需一次，长期有效）
```bash
npm run login        # 等价 node login-helper.mjs
```
会弹出独立 Edge 窗口 → 点右上角「登录」→ 手机淘宝 App **扫码**确认（有滑块就滑一下）→ 看到「✅ 登录成功」即可。登录态保存在 profileDir 目录，与日常浏览器隔离。

### ④ 采集快照
```bash
npm run monitor      # 等价 node taobao-monitor.mjs，或双击 start-monitor.cmd
```
有头窗口可看到过程；遇到滑块验证在窗口里手动滑一下按回车。结束后在 `taobao-data/` 生成带时间戳的商品/排行/评论快照。

### ⑤ 生成报告
```bash
npm run report       # 等价 node taobao-report.mjs，或双击 start-report.cmd
```
打开 `taobao-data/report.md`（VSCode 按 Ctrl+Shift+V 预览）。报告含：商品销量排行、逐商品价格/销量/图片变更、竞品位次升降与掉榜、**评论洞察**（高赞·带图·追评代表、好评卖点 TOP、差评痛点 TOP、大家印象）。

### ⑥ （可选）每天自动跑
Windows 任务计划（示例，路径换成你自己的）：
```bash
schtasks /create /tn TaobaoMonitor /sc daily /st 09:30 /tr "cmd /c cd /d D:\你的路径\browser-automation && node taobao-monitor.mjs >> taobao-data\monitor.log 2>&1"
```
注意：定时任务要求电脑开机、登录态未过期；同一登录态目录同一时间只能跑一个进程。

## 五、配置说明（taobao-config.json）

| 键 | 说明 | 默认 |
| --- | --- | --- |
| products | 监控商品数组：name（文件夹名，可中文）/ url | 必填 |
| rankings | 排行关键词数组：name / keyword / topN / sort(sale-desc) | 可选 |
| profileDir | 自动化浏览器登录态目录（~ 展开为家目录；可用环境变量 TAOBAO_PROFILE_DIR 覆盖） | ~/.taobao-edge-profile |
| browserChannel | 驱动浏览器：msedge 或 chrome（可环境变量 TAOBAO_BROWSER 覆盖） | msedge |
| dataDir | 数据目录 | taobao-data |
| headless | 无头模式（默认有头，风控更稳） | false |
| waitAfterLoadMs | 页面加载后等待 | 3500 |
| minDelayMs / maxDelayMs | 页面间随机等待（风控节奏） | 2500 / 6000 |
| reviews | 评论抓取开关与参数（见下） | 开启 |
| reviews.terms | positive / negative 自定义情感词典，按类目增减 | 内置通用词 |

## 六、评论抓取与结构化洞察（v3）

每次采集商品页公开评论并做洞察，**优先「高赞 / 带图 / 追评」**：

1. 默认视图滚动加载（窗口 + 页面内滚动容器，适配新版懒加载）；再尝试点击「图片 / 追评 / 差评」筛选分别收集；
2. 代表性排序加权 = 有用数(点赞)×100 + 带图×12 + 追评×15；
3. 情感粗分类 + 高频词组统计 → `sellPoints`（好评卖点）/ `painPoints`（差评痛点），各附代表性例句；
4. 捕获模块头部「大家印象」标签（如 用起来很方便×7）。

输出位置：
- `taobao-data/products/<商品名>/reviews/<时间戳>.json`：summary（总数/好评/差评/中性/带图/追评/好评率 + tags）、insight（topHighLike / sellPoints / painPoints / representative）、reviews（逐条：日期/有用数/内容/带图/追评/情感标签）；
- `report.md` 每商品「### 评论洞察」小节；
- `exports/reviews_latest.csv`（商品/采集日期/有用数/内容/带图/追评/情感）。

评论抓空时自动截图 `debug-reviews-empty-*.png` 留存排查。

## 七、常见问题

- **登录过期 / 搜索要求登录**：重新 `npm run login` 扫码。
- **滑块验证**：在有头窗口手动滑一下，回车继续（非交互等待 60 秒）。
- **评论 0 条**：多为登录态过期或淘宝改版。先重新登录；仍无效把 `debug-reviews-empty-*.png` 截图发回修复。
- **页面改版抓不到数据**：正常现象。让 Claude Code 看截图修选择器即可（哈希类名随版本变化）。
- **情感显示“中性”**：用词不在词典内，在 `reviews.terms` 补词后重跑。
- **想换 Chrome**：把 `browserChannel` 改为 `chrome`（登录需重做一次，因为登录态目录与浏览器绑定）。

## 八、可选：Claude Code + Playwright MCP（AI 调优模式）

正常采集不需要 AI。只有页面改版需要“看图修脚本”时才用：

1. 全局安装 MCP：`npm install -g @playwright/mcp`；
2. 复制 `.mcp.json.example` 为 `.mcp.json`，把里面的 `<你的用户名>`、项目路径换成你的（与 taobao-config.json 的 profileDir 保持一致）；
3. VSCode 打开本目录 → Claude Code 面板直接下指令，例如：`用浏览器打开这个商品页，看评论模块为什么抓不到，修一下选择器`。

## 九、合规与风险提示（重要）

- 只采集**任何人都能在网页上看到**的公开信息，**个人自用**；勿采集账号私有数据（订单/收藏/聊天），勿用于商业分发。
- 淘宝/天猫有风控：登录、滑块、频率限制、封号风险。请保持**低频（建议每天 1-2 次）、有头、真人节奏**，勿高频批量。
- 登录态会过期，过期后重新登录即可；页面改版导致选择器失效属正常，修一次即可固化复用。

## 十、发布到 GitHub

仓库内容已就绪：`.gitignore` 会排除 node_modules、taobao-config.json、.mcp.json、taobao-data、output 等个人/生成内容。步骤：

```bash
git init
git add .
git commit -m "feat: taobao public info monitor v3.1"
# 在 GitHub 新建空仓库后：
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
```

他人克隆后按「四、快速开始」6 步即可使用。

---

## English summary

A privacy-respecting, 0-token local monitor for **public** Taobao/Tmall product info: product snapshots (price/sales/images/shop), search rankings, and review insights (high-like / with-photo / follow-up reviews first, plus selling-point & pain-point mining). Runs purely on Playwright + your installed Edge/Chrome; reports to Markdown and CSV. Personal use only — see compliance notes above.

## License

MIT
