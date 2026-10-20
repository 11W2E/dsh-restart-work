#!/usr/bin/env node
/* arm-restart.cjs — 给 dsh-power 看守写重启信号（插件自带 CLI）
 *
 * 用法（agent 排程时调用；脚本可放任意目录，状态目录固定在 ~/.dsh/dsh-power）：
 *   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/arm-restart.cjs \
 *     --minutes 2 --inject-delay-sec 60 --prompt-file <文本路径> [--note weekly-upgrade]
 *
 * 两个时间间隔由调用方（agent）决定，命令行优先级最高；没传时用「设置 → 电源管理」里
 * 保存的默认值（~/.dsh/dsh-power/supervisor-settings.json），再没有才用内置 2 分钟 / 60 秒：
 *   --minutes N           到点重启的延迟（分钟；0 = 立刻）
 *   --inject-delay-sec N  宿主起来后隔多久注入提示词（秒；0 = 立刻）
 * 请求文件：~/.dsh/dsh-power/pending/restart-request.json（Windows: %USERPROFILE%\.dsh\dsh-power\pending）
 * 看守（计划任务 DSH_supervisor）轮询它：到点重启 → 清 cookie → 宿主起来 → 注入。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// 状态目录与看守、清理器共用；DSH_POWER_STATE_DIR 可覆盖。
const STATE = process.env.DSH_POWER_STATE_DIR || path.join(os.homedir(), '.dsh', 'dsh-power');
const PEND = path.join(STATE, 'pending');
const argv = process.argv.slice(2);
function get(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
function num(name, def, min) {
  const raw = get(name, null);
  if (raw === null) return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) {
    console.error('bad ' + name + ': ' + raw);
    process.exit(2);
  }
  return v;
}

function savedSettings() {
  try {
    const raw = fs.readFileSync(path.join(STATE, 'supervisor-settings.json'), 'utf8');
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}
const saved = savedSettings();
const defMinutes = Number.isFinite(Number(saved.restartDelayMinutes)) ? Number(saved.restartDelayMinutes) : 2;
const defInject = Number.isFinite(Number(saved.injectDelaySec)) ? Number(saved.injectDelaySec) : 60;
const minutes = num('--minutes', defMinutes, 0);
const injectDelaySec = num('--inject-delay-sec', defInject, 0);
let prompt = get('--prompt', '');
const pf = get('--prompt-file', '');
if (pf) prompt = fs.readFileSync(pf, 'utf8');
if (!prompt || !prompt.trim()) {
  console.error('need --prompt or --prompt-file');
  process.exit(2);
}
const now = Date.now();
const restartAt = now + minutes * 60000;
const id = get('--id', new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14));
const target = path.join(PEND, 'restart-request.json');
if (fs.existsSync(target)) {
  console.error('pending request already exists: ' + target);
  process.exit(3);
}
const req = {
  id,
  createdAt: new Date(now).toISOString(),
  createdAtMs: now,
  restartAt: new Date(restartAt).toISOString(),
  restartAtMs: restartAt,
  minutes,
  injectDelaySec,
  prompt,
  note: get('--note', ''),
  createdBy: 'agent',
};
fs.mkdirSync(PEND, { recursive: true });
const tmp = target + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(req, null, 2), 'utf8');
fs.renameSync(tmp, target);
console.log('armed id=' + id + ' restartAt=' + new Date(restartAt).toLocaleString('zh-CN') + ' injectDelaySec=' + injectDelaySec
  + ' (minutes=' + minutes + (get('--minutes', null) === null ? ' 来自设置' : ' 命令行') + ')');
console.log('request=' + target);
