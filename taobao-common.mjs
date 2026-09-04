// 共享工具：解析自动化浏览器 profile 目录 / 浏览器通道 / 反自动化指纹。
// 优先级：环境变量 TAOBAO_PROFILE_DIR > taobao-config.json 的 profileDir > 用户主目录 ~/.taobao-edge-profile
import { homedir } from 'node:os';
import { join } from 'node:path';

export const UA_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
export const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function expand(p) {
  if (typeof p !== 'string' || !p) return p;
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function resolveProfileDir(cfg) {
  if (process.env.TAOBAO_PROFILE_DIR) return expand(process.env.TAOBAO_PROFILE_DIR);
  if (cfg && cfg.profileDir) return expand(cfg.profileDir);
  return join(homedir(), '.taobao-edge-profile');
}

export function resolveChannel(cfg) {
  return (cfg && cfg.browserChannel) || process.env.TAOBAO_BROWSER || 'msedge';
}

// 反自动化指纹（淘宝必需）：真实浏览器 UA + 关闭自动化标记
export function stealthFor(channel) {
  return {
    userAgent: channel === 'chrome' ? UA_CHROME : UA_EDGE,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  };
}
