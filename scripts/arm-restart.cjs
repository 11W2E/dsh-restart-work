#!/usr/bin/env node
/* arm-restart.cjs — 给重启看守写一个「到点重启」请求
 *
 * 请求写到 <StateDir>/pending/restart-request.json，看守（计划任务）轮询到点执行。
 * StateDir 默认 %USERPROFILE%\.dsh\restart-work，可用环境变量 DSH_RESTART_STATE_DIR 覆盖。
 *
 * 用法：
 *   node arm-restart.cjs --minutes 2 --inject-delay-sec 60 --prompt-file prompt.txt
 *
 * 参数：
 *   --minutes N           多久后重启（分钟，0 = 立刻；默认 2）
 *   --inject-delay-sec N  宿主起来后隔多久注入提示词（秒，0 = 立刻；默认 60）
 *   --prompt TEXT         注入的提示词
 *   --prompt-file PATH    从文件读提示词（推荐，避免引号/反斜杠被 shell 改写）
 *   --note TEXT           备注，写进请求文件方便排查
 *   --id TEXT             请求 id（默认时间戳）
 *
 * 退出码：0 成功；2 参数错；3 已存在未处理的请求。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE = process.env.DSH_RESTART_STATE_DIR || path.join(os.homedir(), '.dsh', 'restart-work');
const PEND = path.join(STATE, 'pending');
const argv = process.argv.slice(2);
function get(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
function num(name, def, min, max) {
  const raw = get(name, null);
  if (raw === null) return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    console.error('bad ' + name + ': ' + raw);
    process.exit(2);
  }
  return v;
}
const minutes = num('--minutes', 2, 0, 1440);
const injectDelaySec = num('--inject-delay-sec', 60, 0, 3600);
let prompt = get('--prompt', '');
const pf = get('--prompt-file', '');
if (pf) {
  try { prompt = fs.readFileSync(pf, 'utf8'); } catch (e) { console.error('cannot read ' + pf + ': ' + e.message); process.exit(2); }
}
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
  createdBy: 'arm-restart.cjs',
};
fs.mkdirSync(PEND, { recursive: true });
const tmp = target + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(req, null, 2), 'utf8');
fs.renameSync(tmp, target);
console.log('armed id=' + id + ' restartAt=' + new Date(restartAt).toISOString() + ' injectDelaySec=' + injectDelaySec);
console.log('request=' + target);
