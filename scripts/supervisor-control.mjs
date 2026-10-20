/**
 * supervisor-control.mjs — dsh-power 插件的「看守控制面」
 *
 * 职责：把「重启排程 + 重启后注入提示词」这套编排收敛到一处。全部脚本同目录，
 * 状态目录固定在 ~/.dsh/dsh-power（可用 DSH_POWER_STATE_DIR 覆盖）：
 *
 *   supervisor.ps1            常驻看守（计划任务 DSH_supervisor 拉起）
 *   clean-auth-cookies.cjs    宿主退出后清理陈旧 dsh-auth-* cookie
 *   arm-restart.cjs           agent 排程用的 CLI（写请求文件）
 *   <state>/pending/          请求 / 状态 / 注入结果 / 证据（插件私有状态）
 *
 * 两个时间间隔由 agent 自由决定，插件只给默认值并原样记录：
 *   restartDelayMinutes  默认 2    —— 收到 /api/arm 后多久重启
 *   injectDelaySec       默认 60   —— 新宿主起来后隔多久注入提示词
 *
 * 本模块只依赖 node 内置模块（本包用 link: 安装，解析不到 dsh 自带包）。
 */
import { spawn } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* mjs 里没有 __dirname，用 import.meta.url 反推：脚本目录 = 本文件所在目录。 */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const STATE_DIR = process.env.DSH_POWER_STATE_DIR || path.join(homedir(), '.dsh', 'dsh-power')
export const PENDING_DIR = path.join(STATE_DIR, 'pending')
export const SUPERVISOR_SCRIPT = path.join(SCRIPT_DIR, 'supervisor.ps1')
export const CLEANER_SCRIPT = path.join(SCRIPT_DIR, 'clean-auth-cookies.cjs')
export const RESTART_CMD = path.join(STATE_DIR, 'restart.cmd')
export const WATCH_LOG = path.join(STATE_DIR, 'watch.log')
export const COOKIE_LOG = path.join(STATE_DIR, 'cleanup-cookies.log')
export const TASK_NAME = 'DSH_supervisor'
export const DEFAULT_RESTART_MINUTES = 2
export const DEFAULT_INJECT_DELAY_SEC = 60
/* 用户设置（设置 → 电源管理）落盘到这里；只存覆盖值，不存默认值。 */
export const SETTINGS_FILE = path.join(STATE_DIR, 'supervisor-settings.json')

export function supervisorConfig(config = {}) {
  const raw = (config && config.supervisor) || {}
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n) || n < min || n > max) return fallback
    return n
  }
  return {
    enabled: raw.enabled !== false,
    restartDelayMinutes: num(raw.restartDelayMinutes, DEFAULT_RESTART_MINUTES, 0, 24 * 60),
    injectDelaySec: num(raw.injectDelaySec, DEFAULT_INJECT_DELAY_SEC, 0, 3600),
  }
}

function settingsFrom(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  const pick = (key, min, max) => {
    const n = Number(raw[key])
    if (Number.isFinite(n) && n >= min && n <= max) out[key] = Math.round(n)
  }
  pick('restartDelayMinutes', 0, 24 * 60)
  pick('injectDelaySec', 0, 3600)
  return out
}

export async function readSettings() {
  const raw = await readJson(SETTINGS_FILE)
  return {
    values: settingsFrom(raw),
    updatedAt: (raw && raw.updatedAt) || null,
    updatedBy: (raw && raw.updatedBy) || null,
  }
}

export function validateSettings(input = {}) {
  const errors = []
  const check = (key, min, max, label) => {
    const n = Number(input[key])
    if (!Number.isFinite(n) || n < min || n > max) errors.push(label + '需在 ' + min + '–' + max + ' 之间')
  }
  check('restartDelayMinutes', 0, 24 * 60, '重启延迟（分钟）')
  check('injectDelaySec', 0, 3600, '检查/注入延迟（秒）')
  return { ok: errors.length === 0, values: settingsFrom(input), errors }
}

export async function writeSettings(input = {}, by = 'settings-ui') {
  const checked = validateSettings(input)
  if (!checked.ok) {
    return { ok: false, code: 400, error: 'invalid-settings', detail: checked.errors.join('；') }
  }
  const value = {
    restartDelayMinutes: checked.values.restartDelayMinutes,
    injectDelaySec: checked.values.injectDelaySec,
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  }
  await writeJsonAtomic(SETTINGS_FILE, value)
  return { ok: true, settings: value }
}

/* 生效顺序：内置默认值 ← config.supervisor ← supervisor-settings.json。
 * 设置界面写的是最后一份，所以用户点保存后总以它为准；agent 排程仍可按请求单独覆盖。 */
export async function effectiveSupervisorConfig(config = {}) {
  const base = supervisorConfig(config)
  const saved = await readSettings()
  const values = saved.values || {}
  return {
    enabled: base.enabled,
    restartDelayMinutes: values.restartDelayMinutes ?? base.restartDelayMinutes,
    injectDelaySec: values.injectDelaySec ?? base.injectDelaySec,
  }
}

function resolvePowerShell() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(full) ? full : 'powershell.exe'
}

function runPowershell(script) {
  const file = resolvePowerShell()
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    const child = spawn(file, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true,
    })
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('error', (error) => resolve({ code: -1, stdout: out, stderr: String(error && error.message) }))
    child.on('close', (code) => resolve({ code: code === null ? -1 : code, stdout: out.trim(), stderr: err.trim() }))
  })
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function encodeBase64(text) {
  return Buffer.from(String(text), 'utf16le').toString('base64')
}

async function readJson(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    if (!raw.trim()) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

export async function readTask() {
  // 中文 Windows PowerShell 的 stdout 是 GBK，直接写文本经 Node utf8 解码会乱码；
  // 这里统一让 PS 输出 UTF-8 的 base64，再在 JS 侧解码，避免编码与换行差异。
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$t = Get-ScheduledTask -TaskName ' + psQuote(TASK_NAME),
    'if (-not $t) { Write-Output ("MISSING") ; exit 0 }',
    '$a = $t.Actions | Select-Object -First 1',
    '$text = $t.State.ToString() + "|" + $a.Execute + "|" + $a.Arguments',
    'Write-Output ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)))',
  ].join('\r\n')
  const r = await runPowershell(script)
  const line = (r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() || ''
  if (!line || line === 'MISSING') return { installed: false, state: null, execute: null, arguments: null }
  let text = ''
  try { text = Buffer.from(line, 'base64').toString('utf8') } catch { text = '' }
  const parts = text.split('|')
  if (parts.length < 2) return { installed: false, state: null, execute: null, arguments: null }
  return { installed: true, state: (parts[0] || '').trim(), execute: parts[1] || '', arguments: parts[2] || '' }
}

function desiredArguments() {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    '"' + SUPERVISOR_SCRIPT + '"',
    '-TaskName',
    '"' + TASK_NAME + '"',
    '-PendingDir',
    '"' + PENDING_DIR + '"',
  ].join(' ')
}

async function registerTask() {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    '$name = ' + psQuote(TASK_NAME),
    '$ps = ' + psQuote(resolvePowerShell()),
    '$arg = ' + psQuote(desiredArguments()),
    '$action = New-ScheduledTaskAction -Execute $ps -Argument $arg',
    '$trigger = New-ScheduledTaskTrigger -AtLogOn',
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)',
    "$desc = 'DSH 看守（dsh-power 插件）：cookie 清理 + 重启编排 + 重启后自动注入'",
    'Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description $desc -Force | Out-Null',
    '$t = Get-ScheduledTask -TaskName $name',
    'Write-Output $t.State',
  ].join('\r\n')
  const r = await runPowershell(ps)
  return { ok: r.code === 0, state: (r.stdout || '').split(/\r?\n/).pop() || '', detail: r.stderr || '' }
}

async function taskRunning() {
  const task = await readTask()
  return task.installed && String(task.state || '').toLowerCase() === 'running'
}

export async function ensureSupervisor(config = {}) {
  const conf = await effectiveSupervisorConfig(config)
  if (!conf.enabled) return { ok: false, disabled: true, detail: 'config.supervisor.enabled = false' }
  if (!existsSync(SUPERVISOR_SCRIPT)) {
    return { ok: false, error: 'script-missing', detail: '缺少 ' + SUPERVISOR_SCRIPT }
  }
  await fsp.mkdir(PENDING_DIR, { recursive: true })
  let task = await readTask()
  let registered = false
  const wanted = desiredArguments()
  const stale = !task.installed || String(task.arguments || '').trim() !== wanted
  if (stale) {
    const reg = await registerTask()
    if (!reg.ok) return { ok: false, error: 'register-failed', detail: reg.detail }
    registered = true
    task = await readTask()
  }
  let started = false
  if (!task.installed || String(task.state || '').toLowerCase() !== 'running') {
    const r = await runPowershell(["$ErrorActionPreference = 'SilentlyContinue'", 'Start-ScheduledTask -TaskName ' + psQuote(TASK_NAME), 'Start-Sleep -Seconds 2', '(Get-ScheduledTask -TaskName ' + psQuote(TASK_NAME) + ').State'].join('\r\n'))
    started = r.code === 0
    task = await readTask()
  }
  return { ok: task.installed && String(task.state || '').toLowerCase() === 'running', registered, started, task }
}

export async function supervisorStatus(config = {}) {
  const conf = await effectiveSupervisorConfig(config)
  const saved = await readSettings()
  const hasSaved = Object.keys(saved.values || {}).length > 0
  const task = await readTask()
  const state = await readJson(path.join(PENDING_DIR, 'supervisor-state.json'))
  const request = await readJson(path.join(PENDING_DIR, 'restart-request.json'))
  let requestSummary = null
  if (request) {
    requestSummary = {
      id: request.id || null,
      restartAt: request.restartAt || null,
      minutes: request.minutes ?? null,
      injectDelaySec: request.injectDelaySec ?? null,
      note: request.note || '',
      promptChars: typeof request.prompt === 'string' ? request.prompt.length : 0,
    }
  }
  return {
    ok: task.installed && String(task.state || '').toLowerCase() === 'running',
    config: conf,
    task: {
      name: TASK_NAME,
      installed: task.installed,
      state: task.state,
      action: task.arguments || null,
      actionMatchesPlugin: task.installed ? String(task.arguments || '').trim() === desiredArguments() : false,
    },
    files: {
      supervisor: SUPERVISOR_SCRIPT,
      cleaner: CLEANER_SCRIPT,
      restartCmd: RESTART_CMD,
      pendingDir: PENDING_DIR,
      watchLog: WATCH_LOG,
      cookieLog: COOKIE_LOG,
    },
    phase: (state && state.phase) || 'idle',
    request: requestSummary,
    settings: {
      restartDelayMinutes: conf.restartDelayMinutes,
      injectDelaySec: conf.injectDelaySec,
      source: hasSaved ? 'user' : 'default',
      updatedAt: saved.updatedAt,
      updatedBy: saved.updatedBy,
      file: SETTINGS_FILE,
    },
    defaults: {
      restartDelayMinutes: DEFAULT_RESTART_MINUTES,
      injectDelaySec: DEFAULT_INJECT_DELAY_SEC,
      note: '两个间隔只是默认值，agent 可在 /api/arm 时随意指定',
    },
  }
}

export async function armRequest(config, input = {}) {
  const conf = await effectiveSupervisorConfig(config)
  const minutes = Number(input.minutes)
  const injectDelaySec = Number(input.injectDelaySec)
  const resolvedMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : conf.restartDelayMinutes
  const resolvedInject = Number.isFinite(injectDelaySec) && injectDelaySec >= 0 ? injectDelaySec : conf.injectDelaySec
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  if (!prompt.trim()) return { ok: false, code: 400, error: 'prompt-required', detail: 'prompt 不能为空（注入到新会话的提示词）' }
  const target = path.join(PENDING_DIR, 'restart-request.json')
  if (existsSync(target)) {
    return { ok: false, code: 409, error: 'request-exists', detail: '已有排程请求未处理：' + target }
  }
  const now = Date.now()
  const restartAt = now + resolvedMinutes * 60000
  const id = (input.id && String(input.id)) || new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const request = {
    id,
    createdAt: new Date(now).toISOString(),
    createdAtMs: now,
    restartAt: new Date(restartAt).toISOString(),
    restartAtMs: restartAt,
    minutes: resolvedMinutes,
    injectDelaySec: resolvedInject,
    prompt,
    note: input.note || '',
    createdBy: input.createdBy || 'api',
  }
  await writeJsonAtomic(target, request)
  const ensured = await ensureSupervisor(config)
  return { ok: true, request, supervisor: { ok: ensured.ok, registered: ensured.registered, started: ensured.started } }
}

export async function disarmRequest(config = {}) {
  const target = path.join(PENDING_DIR, 'restart-request.json')
  const state = await readJson(path.join(PENDING_DIR, 'supervisor-state.json'))
  const phase = (state && state.phase) || 'idle'
  if (phase !== 'idle') {
    return { ok: false, code: 409, error: 'not-idle', detail: '看守正在执行（phase=' + phase + '），不能撤单' }
  }
  if (!existsSync(target)) return { ok: true, removed: false }
  const archive = path.join(PENDING_DIR, 'done')
  await fsp.mkdir(archive, { recursive: true })
  const name = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-disarmed.json'
  await fsp.rename(target, path.join(archive, name))
  return { ok: true, removed: true, archived: path.join(archive, name) }
}
