#!/usr/bin/env node
'use strict';
// clean-auth-cookies.cjs — 清理陈旧 dsh-auth-* cookie（2026-10-20）
//
// 背景：桌面壳每次启动用随机端口（--host 127.0.0.1 --port 0），宿主发的会话
// cookie 名 = "dsh-auth-" + base64url(sha256(host:port))，同主机不同端口各一条、
// Max-Age 30 天且从不回收。约 70 次重启后 Cookie 头超过 Node 默认 16 KB
// 上限，宿主直接回 431，桌面壳 welcome 校验失败并崩溃：
//   desktop welcome: Web authentication failed
// 修复：DSH 一关闭就删掉 loopback 主机上的 dsh-auth-* 行；dsh_pair（remote-web-ui 手机
// 配对，365 天）等其它 cookie 保留。由常驻看守 dsh-power/tools/supervisor.ps1 在检测到
// "DeepSeek Harness.exe 消失"后调用（计划任务 DSH_supervisor 在登录时拉起看守）。
//
// 用法（看守会自动带 --proc；手工排障时）：
//   set ELECTRON_RUN_AS_NODE=1
//   "%USERPROFILE%\.dsh\electron\electron.exe" scripts\clean-auth-cookies.cjs
// 注意：本进程镜像名也可能是 "DeepSeek Harness.exe"（旧版 restart.cmd 用它跑），判断
// "宿主是否还在跑"必须排除自身 pid。
// 参数：--db <path>  覆盖 cookie 库路径（测试用）
//       --log <path> 覆盖日志路径
//       --dry-run    只统计不删
//       --wait <sec> 等待宿主进程退出的秒数（默认 15，0=不等待）
//       --force      跳过"宿主未退出"检查（仅用于拿副本库做测试）
//       --stale-seconds <n>  只删 last_access 早于 n 秒的行（默认 30，0=不按年龄过滤）
// 退出码恒为 0：清理失败也不能挡住 DSH 启动。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const HOME = process.env.USERPROFILE || os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const DB_DEFAULT = path.join(APPDATA, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies');
const LOG_DEFAULT = path.join(process.env.DSH_POWER_STATE_DIR || path.join(HOME, '.dsh', 'dsh-power'), 'cleanup-cookies.log');
const HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const NAME_LIKE = 'dsh-auth-%';
const PROC = 'DeepSeek Harness.exe';
const PROC_OVERRIDE = (process.argv.indexOf('--proc') >= 0 ? process.argv[process.argv.indexOf('--proc') + 1] : null) || PROC;

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const dbPath = argOf('--db') || DB_DEFAULT;
const logPath = argOf('--log') || LOG_DEFAULT;
const dryRun = process.argv.includes('--dry-run');
const waitRaw = Number(argOf('--wait') || 15);
const waitSec = Math.max(0, Number.isFinite(waitRaw) ? waitRaw : 15);
const staleRaw = Number(argOf('--stale-seconds') || 30);
const staleSec = Math.max(0, Number.isFinite(staleRaw) ? staleRaw : 30);
const force = process.argv.includes('--force');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

const lines = [];
function note(msg) { lines.push(msg); }

function log() {
  const text = lines.map((l) => '[' + stamp() + '] ' + l).join('\n') + '\n';
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, text, 'utf8');
  } catch (_) { /* 日志写不了也不影响清理 */ }
  process.stdout.write(text);
}

function hostPids() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + PROC_OVERRIDE, '/FO', 'CSV', '/NH'], {
      windowsHide: true, encoding: 'latin1', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const wanted = PROC_OVERRIDE.toLowerCase();
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]*)","([0-9]+)"/);
      if (m && m[1].toLowerCase() === wanted) pids.push(Number(m[2]));
    }
    return pids;
  } catch (_) {
    return []; // tasklist 失败就当作没在跑，让 sqlite 自己报锁
  }
}

function isHostRunning(pids = hostPids()) {
  // 自身以 "DeepSeek Harness.exe" 镜像名运行（ELECTRON_RUN_AS_NODE=1），必须排除自己的 pid：
  // 否则永远判定宿主还在跑 → 每次重启都 SKIP（2026-10-20 实测踩过）。
  return pids.some((pid) => pid !== process.pid);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  // 1) 宿主必须完全退出，否则 cookie 库被 Chromium 独占（WAL + 锁）
  let waited = 0;
  while (!force && isHostRunning() && waited < waitSec * 1000) {
    if (waited === 0) note('host still running, waiting up to ' + waitSec + 's');
    sleepMs(500);
    waited += 500;
  }
  if (!force && isHostRunning()) {
    note('SKIP: "' + PROC_OVERRIDE + '" still running after ' + waitSec + 's; not touching ' + dbPath);
    return;
  }

  if (!fs.existsSync(dbPath)) {
    note('SKIP: cookie db not found: ' + dbPath);
    return;
  }

  const { DatabaseSync } = require('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    note('SKIP: cannot open cookie db (' + err.message + '): ' + dbPath);
    return;
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const hosts = HOSTS.map((h) => "'" + h.replace(/'/g, "''") + "'").join(',');
    let where = "name LIKE '" + NAME_LIKE + "' AND host_key IN (" + hosts + ')';
    /* 只碰"确实陈旧"的行：关闭后 2s 内如果用户又起了新实例，新写的那条 last_access 是现在，
     * 年龄过滤会把它保住（无过滤时会误删正在用的 cookie → GUI 401）。Chromium 的
     * last_access_utc 是 1601 起算的微秒。 */
    if (staleSec > 0) {
      const cutoff = Math.round((Date.now() - staleSec * 1000) / 1000 + 11644473600) * 1000000;
      where += ' AND last_access_utc < ' + cutoff;
    }
    const total = db.prepare('SELECT COUNT(*) AS c FROM cookies').get().c;
    const stale = db.prepare('SELECT COUNT(*) AS c FROM cookies WHERE ' + where).get().c;
    let deleted = 0;
    if (!dryRun && stale > 0) {
      deleted = Number(db.prepare('DELETE FROM cookies WHERE ' + where).run().changes || 0);
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* 非 WAL 或忙 */ }
    }
    const kept = total - deleted;
    note((dryRun ? 'DRY-RUN ' : '') + 'cookies total=' + total + ' stale=' + stale +
      ' deleted=' + deleted + ' kept=' + kept + ' staleSeconds=' + staleSec + ' db=' + dbPath);
  } catch (err) {
    note('ERROR: ' + err.message + ' (db=' + dbPath + ')');
  } finally {
    try { db.close(); } catch (_) { /* ignore */ }
  }
}

// 测试可 require 本文件拿 hostPids/isHostRunning 做单测；作为脚本直接运行时才真正清理。
module.exports = { hostPids, isHostRunning };

if (require.main === module) {
  try { main(); } catch (err) { note('ERROR: ' + (err && err.message ? err.message : String(err))); }
  log();
  process.exitCode = 0;
}
