#!/usr/bin/env node
// weekly-upgrade.cjs — 每周自动插件更新（4 点判定门禁）
//
// 用法（必须 electron-as-node）：
//   ELECTRON_RUN_AS_NODE=1 "%USERPROFILE%\.dsh\electron\electron.exe" scripts/weekly-upgrade.cjs [--dry-run] [--max 4] [--pkg name@ver ...] [--restart-after N] [--json]
//
// 流程：插件市场缓存 + registry check → 候选 → 逐包 analyze（C1-C4）→
//       只对 NO_ADAPT 的包自动 apply → verify（loadprof/compose2/contract）→ 写 ds/reports/weekly-YYYYMMDD.md
// 重启：默认取「设置 → 电源管理」保存的两个间隔（缺省 2 分钟 / 60 秒）：升级成功且 verify 通过后，
// 给看守 DSH_supervisor 写重启信号（dsh-power/tools/arm-restart.cjs），到点 restart.cmd + 清 cookie，
// 宿主起来后按设置的秒数把验收提示词注入会话。看守没接住才退回计划任务 DSH_restart_after_update。
// --restart-after 0 关闭自动重启；两个间隔均可用命令行临时覆盖。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// 本机路径全部可覆盖；默认推导：脚本在 scripts/ 下，工作区 = 上一级，profile 在 ~/.dsh 下。
const DS = process.env.DSH_WORKSPACE || path.resolve(__dirname, "..");
const PROFILE = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), ".dsh", "profiles", "desktop");
const ELECTRON = process.env.DSH_ELECTRON || path.join(os.homedir(), ".dsh", "electron", "electron.exe");
const UPGRADE = path.join(__dirname, "upgrade.cjs");
const MARKET_CACHE = path.join(PROFILE, ".dsh-market", "discovery-compatibility-v1.json");
const REPORT_DIR = path.join(DS, "reports");
const RESTART_TASK = "DSH_restart_after_update";
// 看守的状态/日志/设置目录；与 supervisor.ps1、arm-restart.cjs 用同一个可覆盖目录。
const POWER_STATE_DIR = process.env.DSH_POWER_STATE_DIR || path.join(os.homedir(), ".dsh", "dsh-power");
const RESTART_CMD = process.env.DSH_RESTART_CMD || path.join(POWER_STATE_DIR, "restart.cmd");
// 本仓库里 arm-restart.cjs 与 weekly-upgrade.cjs 同目录；换位置时用 DSH_ARM_RESTART 覆盖。
const ARM_RESTART = process.env.DSH_ARM_RESTART || path.join(__dirname, "arm-restart.cjs");
const SUPERVISOR_SETTINGS = path.join(POWER_STATE_DIR, "supervisor-settings.json");
function readSupervisorSettings() {
  try {
    return JSON.parse(fs.readFileSync(SUPERVISOR_SETTINGS, "utf8")) || {};
  } catch {
    return {};
  }
}
const supSettings = readSupervisorSettings();
const savedRestartMin = Number(supSettings.restartDelayMinutes);
const savedInjectSec = Number(supSettings.injectDelaySec);
const DEFAULT_RESTART_MIN = Number.isFinite(savedRestartMin) ? savedRestartMin : 2;
const savedInject = Number.isFinite(savedInjectSec) ? savedInjectSec : 60;
const CLEAN_LOG = path.join(POWER_STATE_DIR, "cleanup-cookies.log");

function pad(s, n) { s = String(s == null ? "" : s); while (s.length < n) s += " "; return s; }
function stamp(d) {
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function stampMin(d) { return stamp(d) + " " + (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes(); }

function run(args, timeout) {
  const r = spawnSync(ELECTRON, [UPGRADE].concat(args), {
    encoding: "utf8", cwd: DS, timeout: timeout || 300000,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" })
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// upgrade.cjs 的 JSON 输出前后可能混有 [fetch]/[card] 行和 stderr（Electron deprecation 警告），
// 逐个找平衡的 {...} 块并尝试 JSON.parse。
function parseJson(out) {
  const s = String(out || "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    try { return JSON.parse(s.slice(i, end + 1)); } catch (e) { i = end; }
  }
  return null;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }

// 排一次「N 分钟后重启」：计划任务不在 DSH 进程树里，宿主被 taskkill 后仍在。
function scheduleRestart(minutes) {
  const at = new Date(Date.now() + minutes * 60000);
  const hh = (at.getHours() < 10 ? "0" : "") + at.getHours();
  const mm = (at.getMinutes() < 10 ? "0" : "") + at.getMinutes();
  const r = spawnSync("schtasks.exe", ["/Create", "/F", "/TN", RESTART_TASK, "/SC", "ONCE", "/ST", hh + ":" + mm, "/TR", RESTART_CMD], { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, mode: "schtasks", at: hh + ":" + mm, err: r.status === 0 ? "" : String(r.stdout || "") + String(r.stderr || "") };
}

// 首选：给看守写信号（到点重启 + 清 cookie + 注入验收提示词），计划任务只作兜底。
function armRestart(minutes, prompt, injectDelaySec) {
  const r = spawnSync(ELECTRON, [ARM_RESTART, "--minutes", String(minutes), "--inject-delay-sec", String(injectDelaySec), "--prompt", prompt, "--note", "weekly-upgrade"], {
    encoding: "utf8", windowsHide: true, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }),
  });
  const at = new Date(Date.now() + minutes * 60000);
  const p = function (n) { return (n < 10 ? "0" : "") + n; };
  const label = p(at.getMonth() + 1) + "-" + p(at.getDate()) + " " + p(at.getHours()) + ":" + p(at.getMinutes());
  return { ok: r.status === 0, mode: "supervisor", at: label, err: r.status === 0 ? "" : String(r.stdout || "") + String(r.stderr || "") };
}

function buildInjectPrompt(applied, minutes) {
  return [
    "【每周自动更新·看守注入】weekly-upgrade.cjs 已自动升级 " + applied.length + " 个包（" + applied.join(" ") + "），这是重启后自动注入的验收请求。请立刻：",
    "1) cd " + DS + " 后跑 ELECTRON_RUN_AS_NODE=1 " + ELECTRON + " tools/accept.cjs（工作区自带的验收脚本），12 项全过才算成功；",
    "2) 读 reports/weekly-" + stamp(new Date()) + ".md 的「离线校验」「apply 输出」与 reports/last-weekly.json；",
    "3) 看 " + CLEAN_LOG + " 最后一行，记下本次重启删掉的 stale cookie 数；",
    "4) 用 3–5 行汇报：升级了哪些包（名+版本）/ verify 三项 / accept 结果 / cookie 清理；报告里若有「需人工」「BLOCK」也列出来，但不改配置、不自动处理，等用户决定。",
  ].join("\n");
}

function marketInfo() {
  const j = readJson(MARKET_CACHE);
  if (!j || !j.entries) return { at: null, entries: {} };
  let at = 0;
  Object.keys(j.entries).forEach(function (k) { const c = j.entries[k].checkedAt || 0; if (c > at) at = c; });
  return { at: at || null, entries: j.entries };
}

function touchedOf(a) {
  const cp = a && a.coupling;
  if (!cp) return [];
  return ["C1", "C2", "C3", "C4"].map(function (id) {
    const c = cp[id];
    return { id: id, title: (c && c.title) || id, touched: !!(c && c.touched), notes: (c && c.notes) || [], actions: (c && c.actions) || [] };
  });
}

function analyzeOne(spec) {
  const r = run(["analyze", spec, "--json"], 420000);
  const j = parseJson(r.out);
  return { spec: spec, ok: !!j, json: j, raw: r.out, code: r.status };
}

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.indexOf("--dry-run") >= 0 || argv.indexOf("--no-apply") >= 0;
  const asJson = argv.indexOf("--json") >= 0;
  const maxIdx = argv.indexOf("--max");
  const max = maxIdx >= 0 ? Math.max(1, parseInt(argv[maxIdx + 1], 10) || 4) : 4;
  const raIdx = argv.indexOf("--restart-after");
  const restartAfter = raIdx >= 0 ? Math.max(0, parseInt(argv[raIdx + 1], 10) || 0) : DEFAULT_RESTART_MIN;
  const idsIdx = argv.indexOf("--inject-delay-sec");
  const injectDelaySec = idsIdx >= 0 ? Math.max(0, parseInt(argv[idsIdx + 1], 10) || 0) : savedInject;
  const pkgIdx = argv.indexOf("--pkg");
  const forced = pkgIdx >= 0 ? argv.slice(pkgIdx + 1).filter(function (s) { return s.indexOf("@") > 0; }) : [];
  const now = new Date();
  const report = [];

  const market = marketInfo();
  const marketAt = market.at ? new Date(market.at) : null;
  let rows = [], candidates = [];

  if (forced.length) {
    candidates = forced.map(function (s) {
      const at = s.lastIndexOf("@");
      return { name: s.slice(0, at), latest: s.slice(at + 1), installed: "?", update: true, forced: true, marketVersion: null };
    });
  } else {
    const chk = run(["check", "--json"], 300000);
    const cj = parseJson(chk.out);
    if (!cj || !cj.results) { console.error("check --json 解析失败，输出尾部:\n" + chk.out.slice(-2000)); return 1; }
    rows = cj.results;
    candidates = rows.filter(function (r) { return r && r.update && !r.local; }).map(function (r) {
      const mk = market.entries[r.name];
      return {
        name: r.name, installed: r.installed, latest: r.latest, update: true,
        peerOk: r.peerOk, enginesOk: r.enginesOk, mrae: r.mrae, published: r.published,
        marketVersion: mk && mk.facts ? mk.facts.version : null
      };
    });
  }
  candidates.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });

  const analysis = [];
  const autoList = [], manualList = [], blockList = [];

  candidates.slice(0, max).forEach(function (c) {
    const spec = c.name + "@" + c.latest;
    process.stdout.write("[analyze] " + spec + " ... ");
    const a = analyzeOne(spec);
    if (!a.ok) {
      console.log("失败");
      analysis.push({ c: c, spec: spec, verdict: "ERROR", risk: "ERROR", items: [], note: "analyze 未返回 JSON: " + (a.raw || "").slice(-300) });
      manualList.push({ c: c, why: "analyze 失败，需人工看" });
      return;
    }
    const verdict = (a.json.coupling && a.json.coupling.verdict) || "UNKNOWN";
    const risk = (a.json.risk && a.json.risk.level) || "UNKNOWN";
    const items = touchedOf(a.json);
    const blockers = (a.json.risk && a.json.risk.blockers) || [];
    const touched = items.filter(function (i) { return i.touched; }).map(function (i) { return i.id; }).join(",") || "无";
    console.log(verdict + " (risk " + risk + ", touched " + touched + ")");
    const rec = { c: c, spec: spec, verdict: verdict, risk: risk, items: items, blockers: blockers, note: "" };
    analysis.push(rec);
    if (risk === "BLOCK" || (c.peerOk === false) || (c.enginesOk === false)) {
      blockList.push(rec);
    } else if (verdict === "NO_ADAPT") {
      autoList.push(rec);
    } else {
      manualList.push({ c: c, why: "4 点判定 " + verdict + "（" + touched + "）" });
    }
  });

  let applyOut = null, applied = [];
  if (autoList.length && !dry) {
    const specs = autoList.map(function (r) { return r.spec; });
    console.log("");
    console.log("[apply] " + specs.join(" "));
    const ap = run(["apply"].concat(specs), 900000);
    applyOut = ap.out;
    console.log(applyOut);
    applied = specs;
  }

  const vf = run(["verify", "--json"], 420000);
  const vj = parseJson(vf.out);
  const verifyOk = !!(vj && vj.ok);
  const vText = vj ? ("loadprof layers " + vj.loadprof.layers + " skipped " + vj.loadprof.skipped + " · compose2 entries " + vj.compose2.entries + " warns " + vj.compose2.warns + " · contract " + (vj.contract.ok ? "OK" : "未通过（" + (vj.contract.errors || []).length + " error）")) : "verify 解析失败";

  let restart = null;
  if (!dry && applied.length && verifyOk && restartAfter > 0) {
    restart = armRestart(restartAfter, buildInjectPrompt(applied, restartAfter), injectDelaySec);
    if (!restart.ok && !/pending request already exists/.test(restart.err)) {
      const fb = scheduleRestart(restartAfter);
      if (fb.ok) restart = Object.assign(fb, { fellBack: true });
    }
    console.log("[restart] " + (restart.ok
      ? "已排定 " + restart.at + " 自动重启（" + (restart.mode === "supervisor" ? "看守 DSH_supervisor；起来 60s 后自动注入验收提示词" : "计划任务 " + RESTART_TASK + "，无注入") + "）"
      : "排定失败: " + restart.err.slice(0, 300)));
  }

  // ---- report ----
  report.push("# 每周插件更新 " + stamp(now));
  report.push("");
  report.push("- 时间: " + stampMin(now));
  report.push("- 宿主: DSH 0.2.1-rc.2 · profile desktop · 脚本 tools/weekly-upgrade.cjs" + (dry ? "（dry-run，未安装）" : ""));
  report.push("- 插件市场缓存: " + (marketAt ? stampMin(marketAt) : "无缓存") + "（市场缓存的版本仅作参考，最终以 registry check 为准）");
  report.push("- 候选: " + (candidates.length ? candidates.length + " 个（本次最多处理 " + max + " 个）" : "无"));
  if (candidates.length) {
    report.push("");
    report.push("| 包 | 已装 | 最新 | 市场缓存版本 |");
    report.push("| --- | --- | --- | --- |");
    candidates.forEach(function (c) { report.push("| " + c.name + " | " + c.installed + " | " + c.latest + " | " + (c.marketVersion || "-") + " |"); });
  }
  report.push("");
  report.push("## 4 点判定");
  if (!analysis.length) report.push("本轮没有可更新包。");
  analysis.forEach(function (a) {
    report.push("");
    report.push("### " + a.c.name + " " + a.c.installed + " → " + a.c.latest);
    report.push("- 判定: **" + a.verdict + "** · 风险: " + a.risk);
    a.items.forEach(function (i) {
      report.push("- " + i.id + " " + i.title + ": " + (i.touched ? "TOUCHED" : "未触及"));
      i.notes.slice(0, 4).forEach(function (n) { report.push("  - " + n); });
      i.actions.slice(0, 4).forEach(function (n) { report.push("  - -> " + n); });
    });
    a.blockers.forEach(function (b) { report.push("- BLOCK: " + b); });
    if (a.note) report.push("- " + a.note);
  });
  report.push("");
  report.push("## 处理结果");
  if (dry) report.push("dry-run：只判定，没有安装任何包。");
  if (applied.length) {
    report.push("已自动升级（NO_ADAPT）: " + applied.join(", "));
  } else if (!dry) {
    report.push("没有自动升级的包。");
  }
  if (blockList.length) report.push("BLOCK（不要升）: " + blockList.map(function (r) { return r.c.name + " 因 " + (r.blockers.join("; ") || "peer/engines"); }).join(" | "));
  if (manualList.length) report.push("需人工适配: " + manualList.map(function (m) { return m.c.name + "（" + m.why + "）"; }).join(" | "));
  report.push("");
  report.push("## 离线校验");
  report.push("- " + vText);
  report.push("- 结果: " + (verifyOk ? "OK" : "未通过，先看 verify 输出再决定是否回滚"));
  report.push("- 重启: " + (restart
    ? (restart.ok
      ? "已排定 " + restart.at + " 自动重启（" + (restart.mode === "supervisor"
        ? "看守 <code>DSH_supervisor</code>；宿主退出清 cookie，起来 60s 后自动注入验收提示词"
        : "计划任务 <code>" + RESTART_TASK + "</code>，无注入（看守未接住，退回兜底）") + "；取消：删 <code>pending/restart-request.json</code> 或 <code>schtasks /Delete /TN " + RESTART_TASK + " /F</code>）"
      : "排定失败：" + restart.err.slice(0, 200))
    : "未排定（" + (restartAfter > 0 ? "无升级 / verify 未过" : "--restart-after 0") + "）"));
  report.push("");
  report.push("## 下一步");
  let stepNo = 1;
  if (applied.length && restart && restart.ok) report.push((stepNo++) + ". " + restart.at + " 看守自动重启（清 cookie），起来 60s 后自动注入验收提示词并跑 accept：不需要用户操作。");
  else if (applied.length) report.push((stepNo++) + ". 自动重启没排上：手动双击工作区的 restart-dsh.cmd，重启后发 (1) 跑验收。");
  if (manualList.length || blockList.length) report.push((stepNo++) + ". 处理上面 需人工/BLOCK 项：analyze 的 C1-C4 动作 → 改补丁/配置 → 再 apply → verify。");
  report.push((stepNo++) + ". 重启后跑 verify + 按各包卡片 verifyExtra 验收；卡片 lastChange.what 补一句。");
  if (applyOut) {
    report.push("");
    report.push("## apply 输出（尾部）");
    report.push("```");
    report.push(applyOut.split("\n").slice(-40).join("\n"));
    report.push("```");
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const mdPath = path.join(REPORT_DIR, "weekly-" + stamp(now) + (dry ? "-dryrun" : "") + ".md");
  fs.writeFileSync(mdPath, report.join("\n") + "\n");
  const lastPath = path.join(REPORT_DIR, dry ? "last-dryrun.json" : "last-weekly.json");
  fs.writeFileSync(lastPath, JSON.stringify({
    at: now.toISOString(), dry: dry, verifyOk: verifyOk,
    candidates: candidates.map(function (c) { return { name: c.name, installed: c.installed, latest: c.latest, marketVersion: c.marketVersion || null }; }),
    applied: applied,
    restart: restart ? { scheduled: restart.ok, mode: restart.mode || null, at: restart.ok ? restart.at : null, task: restart.ok && restart.mode === "schtasks" ? RESTART_TASK : null, error: restart.ok ? null : restart.err.slice(0, 500) } : null,
    manual: manualList.map(function (m) { return { name: m.c.name, latest: m.c.latest, why: m.why }; }),
    blocked: blockList.map(function (r) { return { name: r.c.name, latest: r.c.latest, blockers: r.blockers }; }),
    report: mdPath
  }, null, 2) + "\n");

  if (asJson) {
    console.log(JSON.stringify({ ok: verifyOk, applied: applied, manual: manualList.map(function (m) { return m.c.name; }), blocked: blockList.map(function (r) { return r.c.name; }), report: mdPath }, null, 2));
    return verifyOk && !manualList.length && !blockList.length ? 0 : 2;
  }
  console.log("");
  console.log("===== 每周更新 " + stamp(now) + " =====");
  console.log("候选 " + candidates.length + " · 自动升级 " + applied.length + (dry ? "（dry-run）" : "") + " · 需人工 " + manualList.length + " · BLOCK " + blockList.length);
  manualList.forEach(function (m) { console.log("  [人工] " + m.c.name + " " + m.c.installed + "->" + m.c.latest + "  " + m.why); });
  blockList.forEach(function (r) { console.log("  [BLOCK] " + r.c.name + " " + r.blockers.join("; ")); });
  console.log("校验: " + vText);
  console.log("报告: " + mdPath);
  if (restart && restart.ok) console.log("重启: 已排定 " + restart.at + "（" + (restart.mode === "supervisor" ? "看守 DSH_supervisor，起来 60s 后注入验收提示词" : "计划任务 " + RESTART_TASK + "）"));
  if (applied.length && !(restart && restart.ok)) console.log("下一步: 自动重启没排上，手动双击工作区的 restart-dsh.cmd 重启，然后发 (1) 跑验收");
  return verifyOk && !manualList.length && !blockList.length ? 0 : 2;
}

process.exitCode = main();
