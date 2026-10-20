#!/usr/bin/env node
'use strict';
// upgrade.cjs - DSH 插件升级一键通道：check / analyze / apply / verify / contract / inventory / watch
//
// 目的：把「发现更新 -> 判断要不要适配 -> 安装 -> 离线校验」压成 2-3 条命令，
// 只对 REVIEW 级包读源码；SAFE 级包直接升。必须用 Electron 的 node 模式跑（才能读 app.asar）：
//   "%USERPROFILE%\.dsh\electron\electron.exe" scripts\upgrade.cjs check
//   ... upgrade.cjs check --md
//   ... upgrade.cjs analyze @michengai/dsh-im-connect@1.0.9
//   ... upgrade.cjs apply dsh-ops@0.4.1 --dry-run
//   ... upgrade.cjs verify
//   ... upgrade.cjs contract        （只跑本机 4 个耦合点 C1-C4 断言）
//   ... upgrade.cjs inventory --md  （由 plugins/*.json 卡片生成插件清单）
//   ... upgrade.cjs watch           （打印带本地耦合/改动的包，来自卡片）
// 退出码：0 正常；1 失败/校验不过；2 用法错误。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

// 全部本机路径都可覆盖：默认按「脚本在 scripts/ 下、工作区是上一级、profile 在 ~/.dsh」推导。
const DS = process.env.DSH_WORKSPACE || path.resolve(__dirname, '..');
const PROFILE = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const PROFILE_NAME = process.env.DSH_PROFILE_NAME || 'desktop';
const INSTALL_DIR = process.env.DSH_INSTALL_DIR || 'C:/ds';
const ASAR = process.env.DSH_APP_ASAR || path.join(INSTALL_DIR, 'resources', 'app.asar', 'dsh');
const ELECTRON = process.env.DSH_ELECTRON || path.join(os.homedir(), '.dsh', 'electron', 'electron.exe');
const DSHCMD = process.env.DSH_CLI || path.join(INSTALL_DIR, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
const REGISTRY = process.env.DSH_UPGRADE_REGISTRY || 'https://registry.npmmirror.com';
const STAGE = path.join(DS, '.stage', 'upgrade');
const TAR = process.env.DSH_TAR || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const CARDS_DIR = path.join(DS, 'plugins');
const ARCHIVE_FILE = path.join(DS, 'archive', 'history.md');
// coupling.cjs 是本机 4 点判定模块（C1-C4 的实现）。本公开仓库不包含它：
// 缺失时 analyze / contract 退化为「只用粗风险分级」，并在输出里显式标注 unavailable。
var coupling = null;
try { coupling = require(path.join(__dirname, 'coupling.cjs')); } catch (e) { coupling = null; }
var COUPLING_MISSING = !coupling;
function couplingRows(file) { if (coupling && coupling.readRows) { try { return coupling.readRows(file); } catch (e) {} } return yamlRows(file); }
function couplingAnalyze(opts) {
  if (coupling && coupling.analyze) return coupling.analyze(opts);
  function mk(id, title) { return { id: id, title: title, touched: false, notes: ['coupling.cjs 未随仓库提供，本项未判定'], actions: [] }; }
  return { verdict: 'UNKNOWN', unavailable: true, blockers: [],
    C1: mk('C1', 'bundle patch 行'), C2: mk('C2', 'client inject 服务'), C3: mk('C3', 'profile 配置行'), C4: mk('C4', '就地补丁') };
}
function couplingContract(opts) {
  if (coupling && coupling.contract) return coupling.contract(opts);
  return { ok: true, unavailable: true, host: hostVersion, packages: (opts.deps || []).length, checks: [],
    issues: [{ sev: 'warn', point: 'contract', detail: 'coupling.cjs 未随仓库提供：跳过 C1-C4 断言' }] };
}

function jread(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function tryJread(p) { try { return jread(p); } catch (e) { return null; } }
function pad(s, n) { s = String(s === null || s === undefined ? '-' : s); var w = 0; for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) > 255 ? 2 : 1; while (w < n) { s += ' '; w++; } return s; }
function stamp() { var d = new Date(); function p(n) { return (n < 10 ? '0' : '') + n; } return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()); }

var hostPkg = null;
try { hostPkg = require(path.join(ASAR, 'package.json')); } catch (e) { hostPkg = tryJread(path.join(ASAR, 'package.json')); }
if (!hostPkg) { console.error('无法读取宿主 package.json: ' + ASAR); process.exit(1); }
var hostVersion = hostPkg.version;
var hostNode = process.versions.node;
var semver = null;
try { semver = require(path.join(ASAR, 'node_modules', 'semver')); } catch (e) { semver = null; }

function cmpVer(a, b) {
  var pa = String(a).split(/[.+-]/), pb = String(b).split(/[.+-]/);
  for (var i = 0; i < 3; i++) { var x = parseInt(pa[i] || '0', 10) || 0, y = parseInt(pb[i] || '0', 10) || 0; if (x !== y) return x < y ? -1 : 1; }
  return String(a) === String(b) ? 0 : (String(a) < String(b) ? -1 : 1);
}
function gt(a, b) { return semver ? semver.gt(a, b) : cmpVer(a, b) > 0; }
function satisfies(v, range) { if (!range) return null; if (semver) return semver.satisfies(v, range, { includePrerelease: true }); return null; }

function profilePkg() { return jread(path.join(PROFILE, 'package.json')); }
function installedVersion(name) {
  var pj = tryJread(path.join(PROFILE, 'node_modules', name, 'package.json'));
  if (pj && pj.version) return pj.version;
  var spec = (profilePkg().dependencies || {})[name] || '';
  if (/^\d/.test(spec)) return spec;
  return null;
}
function parseTarget(s) {
  var i = String(s).lastIndexOf('@');
  if (i <= 0) throw new Error('目标要写成 pkg@ver: ' + s);
  return { name: s.slice(0, i), version: s.slice(i + 1) };
}
function safeName(name) { return name.replace(/[\/@]/g, '_'); }
function loadCards() {
  var out = {};
  var files = [];
  try { files = fs.readdirSync(CARDS_DIR).filter(function (f) { return /\.json$/.test(f); }); } catch (e) { return out; }
  files.forEach(function (f) {
    var p = path.join(CARDS_DIR, f);
    var c = tryJread(p);
    if (c && c.pkg) { c._file = p; out[c.pkg] = c; }
  });
  return out;
}

// 卡片是唯一事实来源：watch 视图由 coupling 字段派生（patchFiles / strictConfigKeys / profileRowIds）
function loadWatch() {
  var cards = loadCards(), out = {};
  Object.keys(cards).forEach(function (p) {
    var c = cards[p], cp = c.coupling || {};
    var head = (c.current || [])[0];
    out[p] = {
      reason: head ? (head.aspect + "：" + head.state) : "本机有耦合/改动，见卡片",
      afterUpgrade: (c.verifyExtra || []).slice(),
      restartRequired: !c.noUpgrade,
      noUpgrade: !!c.noUpgrade,
      patchFiles: cp.patchFiles || [],
      strictConfigKeys: !!cp.strictConfigKeys,
      profileRowIds: (cp.profileRows || []).map(function (r) { return r.id; }),
      installed: c.installed || null,
      cardPath: c._file
    };
  });
  return out;
}

async function fetchJson(url) {
  var res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + url);
  return await res.json();
}
async function registryMeta(name) { return await fetchJson(REGISTRY + '/' + name.replace('/', '%2F')); }

async function mapLimit(items, limit, fn) {
  var out = new Array(items.length), next = 0;
  async function worker() {
    while (true) {
      var i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: (e && e.message) ? e.message : String(e) }; }
    }
  }
  var ws = [];
  for (var k = 0; k < Math.min(limit, items.length); k++) ws.push(worker());
  await Promise.all(ws);
  return out;
}

function wsText() { return fs.readFileSync(path.join(PROFILE, 'pnpm-workspace.yaml'), 'utf8'); }

function mraeEntry(text, pkg) {
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    var m = /^-\s+['"]?([^'"\s]+)@([0-9][^'"\s]*)/.exec(t);
    if (!m || m[1] !== pkg) continue;
    var end = i, buf = t;
    for (var j = i + 1; j < lines.length; j++) {
      if (/^\s{2,}\S/.test(lines[j]) && !/^\s*-\s/.test(lines[j])) { buf += ' ' + lines[j].trim(); end = j; } else break;
    }
    var vers = buf.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/g) || [];
    return { start: i, end: end, versions: vers, line: buf };
  }
  return null;
}
function mraeHas(text, pkg, ver) { var e = mraeEntry(text, pkg); return !!(e && e.versions.indexOf(ver) >= 0); }
function mraeAdd(text, pkg, ver) {
  var lines = text.split(/\r?\n/), entry = mraeEntry(text, pkg), scoped = pkg.charAt(0) === '@';
  if (!entry) {
    var start = -1;
    for (var i = 0; i < lines.length; i++) { if (/^minimumReleaseAgeExclude:/.test(lines[i])) { start = i; break; } }
    if (start < 0) throw new Error('pnpm-workspace.yaml 缺 minimumReleaseAgeExclude 段，请手工加: ' + pkg + '@' + ver);
    var insert = start + 1;
    for (var j = start + 1; j < lines.length; j++) { if (/^\s+/.test(lines[j]) || lines[j].trim() === '') insert = j + 1; else break; }
    lines.splice(insert, 0, '  - ' + (scoped ? "'" + pkg + '@' + ver + "'" : pkg + '@' + ver));
    return lines.join('\n');
  }
  if (entry.versions.indexOf(ver) >= 0) return text;
  var all = entry.versions.concat([ver]).join(' || ');
  var line = scoped ? "'" + pkg + '@' + all + "'" : pkg + '@' + all;
  lines.splice(entry.start, entry.end - entry.start + 1, '  - ' + line);
  return lines.join('\n');
}

function fmtAge(iso) {
  if (!iso) return '-';
  var d = (Date.now() - Date.parse(iso)) / 86400000;
  return d < 1 ? '今' : (Math.floor(d) + 'd');
}

// ---------- check ----------
async function cmdCheck(flags) {
  var json = flags.indexOf('--json') >= 0, md = flags.indexOf('--md') >= 0;
  var pkg = profilePkg(), deps = pkg.dependencies || {}, watch = loadWatch();
  var names = Object.keys(deps);
  var rows = await mapLimit(names, 5, async function (name) {
    var spec = deps[name];
    var rec = { name: name, spec: spec, installed: null, latest: null, published: null, peerOk: null, peerRange: null, enginesOk: null, mrae: null, watch: !!watch[name], update: false, local: false, error: null };
    if (/^(link|file|workspace):/.test(spec)) { rec.local = true; return rec; }
    rec.installed = installedVersion(name);
    var meta = await registryMeta(name);
    var latest = meta['dist-tags'] && meta['dist-tags'].latest;
    rec.latest = latest || null;
    rec.published = latest && meta.time ? meta.time[latest] || null : null;
    if (latest) {
      var v = (meta.versions || {})[latest] || {};
      var peer = v.peerDependencies || {};
      rec.peerRange = peer['@deepseek-ai/dsh'] || null;
      rec.peerOk = rec.peerRange ? satisfies(hostVersion, rec.peerRange) : null;
      if (v.engines && v.engines.node) rec.enginesOk = satisfies(hostNode, v.engines.node);
      rec.mrae = mraeHas(wsText(), name, latest);
    }
    rec.update = !!(rec.latest && rec.installed && /^\d/.test(rec.installed) && gt(rec.latest, rec.installed));
    return rec;
  });
  var updates = [];
  rows.forEach(function (r) { if (r && r.update) updates.push(r); else if (r && r.error) { /* keep */ } });
  if (json) { console.log(JSON.stringify({ host: hostVersion, profile: PROFILE, checkedAt: new Date().toISOString(), results: rows }, null, 2)); return 0; }
  if (md) {
    console.log('| 包 | 已装 | 最新 | 发布 | peer | 放行 | 判定 |');
    console.log('| --- | --- | --- | --- | --- | --- | --- |');
    rows.forEach(function (r) {
      if (r.local) { console.log('| ' + r.name + ' | ' + r.spec + ' | - | - | - | - | 本地 link，不升级 |'); return; }
      var verdict = r.error ? '查询失败' : (!r.update ? '已最新' : (r.peerOk === false ? 'BLOCK peer 不兼容' : (r.mrae ? '直接升' : '需先放行 MRAE')));
      console.log('| ' + r.name + ' | ' + (r.installed || '-') + ' | ' + (r.latest || '-') + ' | ' + fmtAge(r.published) + ' | ' + (r.peerOk === null ? '?' : (r.peerOk ? 'OK' : 'NO')) + ' | ' + (r.mrae ? 'yes' : 'no') + ' | ' + verdict + ' |');
    });
    return 0;
  }
  console.log('宿主 DSH ' + hostVersion + ' / node ' + hostNode + ' / profile ' + PROFILE);
  console.log('');
  console.log(pad('包', 46) + pad('已装', 18) + pad('最新', 12) + pad('发布', 6) + pad('peer', 6) + pad('放行', 6) + '判定');
  console.log('-'.repeat(120));
  rows.forEach(function (r) {
    if (r.local) { console.log(pad(r.name, 46) + pad('link:', 18) + pad('-', 12) + pad('-', 6) + pad('-', 6) + pad('-', 6) + '本地 link，不升级'); return; }
    if (r.error) { console.log(pad(r.name, 46) + pad(r.installed, 18) + pad('查询失败', 12) + pad('-', 6) + pad('-', 6) + pad('-', 6) + r.error); return; }
    var verdict;
    if (!r.update) {
      if (r.installed && r.latest && gt(r.installed, r.latest)) verdict = '已最新(高于 registry latest)';
      else if (r.watch) verdict = '已最新 [有本地补丁/特配]';
      else verdict = '已最新';
    } else verdict = (r.peerOk === false ? 'BLOCK peer 不兼容' : (r.mrae ? '可直接升' : '需先放行 MRAE'));
    if (r.update && r.watch) verdict += ' [有本地补丁/特配]';
    console.log(pad(r.name, 46) + pad(r.installed, 18) + pad(r.latest, 12) + pad(fmtAge(r.published), 6) + pad(r.peerOk === null ? '?' : (r.peerOk ? 'OK' : 'NO'), 6) + pad(r.mrae ? 'yes' : 'no', 6) + verdict);
  });
  console.log('');
  console.log('待更新: ' + (updates.length === 0 ? '无' : updates.map(function (r) { return r.name + '@' + r.installed + ' -> ' + r.latest; }).join(', ')));
  if (updates.length) {
    console.log('下一步: upgrade.cjs analyze <pkg>@<ver>  然后  upgrade.cjs apply <pkg>@<ver>');
    var needMrae = updates.filter(function (r) { return !r.mrae; });
    if (needMrae.length) console.log('apply 会自动把版本加进 minimumReleaseAgeExclude（当前未放行: ' + needMrae.length + ' 个）');
  }
  return 0;
}

// ---------- analyze ----------
async function ensurePackage(name, version) {
  var base = path.join(STAGE, safeName(name) + '-' + version);
  var tgz = path.join(STAGE, 'reg', safeName(name) + '-' + version + '.tgz');
  fs.mkdirSync(path.dirname(tgz), { recursive: true });
  if (!fs.existsSync(tgz)) {
    var meta = await registryMeta(name);
    var v = (meta.versions || {})[version];
    if (!v || !v.dist || !v.dist.tarball) throw new Error('注册表里没有 ' + name + '@' + version);
    var res = await fetch(v.dist.tarball, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error('下载失败 HTTP ' + res.status + ': ' + v.dist.tarball);
    var buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tgz, buf);
    console.log('[fetch] ' + name + '@' + version + ' -> ' + tgz + ' (' + buf.length + ' B)');
  }
  var extracted = path.join(base, 'package');
  if (!fs.existsSync(path.join(extracted, 'package.json'))) {
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(extracted, { recursive: true });
    var r = spawnSync(TAR, ['-xzf', tgz, '-C', extracted, '--strip-components=1'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('解包失败: ' + (r.stderr || r.error || ('tar exit ' + r.status)));
  }
  return { tgz: tgz, extracted: extracted };
}

function hashFile(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function listFiles(root) {
  var out = [];
  function walk(dir) {
    var ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    ents.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e.name === 'node_modules' || e.name === '.git') continue;
      var full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push({ rel: path.relative(root, full).split(path.sep).join('/'), full: full, size: fs.statSync(full).size });
      if (out.length > 20000) return;
    }
  }
  walk(root);
  return out;
}

function diffTrees(a, b) {
  var A = new Map(), B = new Map();
  listFiles(a).forEach(function (f) { A.set(f.rel, f); });
  listFiles(b).forEach(function (f) { B.set(f.rel, f); });
  var changed = [], added = [], removed = [];
  B.forEach(function (f, rel) {
    var o = A.get(rel);
    if (!o) { added.push(f.rel); return; }
    if (o.size !== f.size || hashFile(o.full) !== hashFile(f.full)) changed.push({ rel: rel, oldSize: o.size, newSize: f.size });
  });
  A.forEach(function (f, rel) { if (!B.has(rel)) removed.push(rel); });
  return { changed: changed, added: added, removed: removed };
}

function pkgSummary(dir) {
  var pj = tryJread(path.join(dir, 'package.json')) || {};
  var comps = [];
  try {
    comps = fs.readdirSync(path.join(dir, 'lib', 'components'), { withFileTypes: true })
      .filter(function (e) { return e.isDirectory(); }).map(function (e) { return e.name; }).sort();
  } catch (e) {}
  return {
    version: pj.version || null,
    engines: pj.engines || {},
    peer: pj.peerDependencies || {},
    deps: pj.dependencies || {},
    optional: pj.optionalDependencies || {},
    exports: Object.keys(pj.exports || {}).sort(),
    clientInject: (pj.dsh && pj.dsh.client && pj.dsh.client.inject) || [],
    bundle: pj.dsh && pj.dsh.bundle ? pj.dsh.bundle : null,
    components: comps
  };
}

function yamlRows(file) {
  if (!fs.existsSync(file)) return null;
  var lines = fs.readFileSync(file, 'utf8').split(/\r?\n/), rows = [], cur = null;
  lines.forEach(function (ln) {
    var m = /^\s*-\s+id:\s*['"]?([^'"\s]+)/.exec(ln);
    if (m) { cur = { id: m[1], name: null, disabled: null, keys: [] }; rows.push(cur); return; }
    if (!cur) return;
    var n = /^\s*name:\s*['"]?([^'"\s]+)/.exec(ln);
    if (n && !cur.name) cur.name = n[1];
    var d = /^\s*disabled:\s*(true|false)/.exec(ln);
    if (d && cur.disabled === null) cur.disabled = d[1] === 'true';
    var k = /^\s{4}([A-Za-z0-9_]+):/.exec(ln);
    if (k && cur.keys.indexOf(k[1]) < 0) cur.keys.push(k[1]);
  });
  return rows;
}

function lineCounts(lines) { var m = new Map(); lines.forEach(function (l) { m.set(l, (m.get(l) || 0) + 1); }); return m; }
function onlyIn(a, b, limit) {
  var mb = lineCounts(b), out = [];
  a.forEach(function (l) { var c = mb.get(l) || 0; if (c > 0) mb.set(l, c - 1); else if (out.length < limit) out.push(l); });
  return out;
}
function cmpOne(a, b) { return a === b ? null : (a || '-') + '->' + (b || '-'); }
function diffKeys(a, b) {
  var A = Object.keys(a || {}), B = Object.keys(b || {}), out = [];
  var all = A.concat(B.filter(function (k) { return A.indexOf(k) < 0; }));
  all.forEach(function (k) { if (JSON.stringify((a || {})[k]) !== JSON.stringify((b || {})[k])) out.push(k + ': ' + JSON.stringify((a || {})[k]) + ' -> ' + JSON.stringify((b || {})[k])); });
  return out;
}

function classifyRel(rel) {
  if (rel === 'package.json') return 'manifest';
  if (rel === 'cordis.patch.yml') return 'cordis-patch';
  if (rel === 'dsh-plugin.json') return 'dsh-plugin';
  if (/^lib\/components\//.test(rel)) return 'component';
  if (/^lib\/types\//.test(rel)) return 'types';
  if (/^lib\/client/.test(rel) || /^client\.js$/.test(rel) || /^lib\/client\//.test(rel) || /^client\//.test(rel) || /^dist\/client/.test(rel)) return 'client';
  if (/^lib\/.*\.js$/.test(rel)) return 'lib';
  if (/^src\//.test(rel)) return 'src';
  if (/^docs?\//.test(rel) || /\.md$/.test(rel)) return 'docs';
  return 'other';
}

function riskOf(name, diff, oldS, newS, rowsOld, rowsNew, watchEntry) {
  var blockers = [], reviews = [], safe = [];
  if (newS.engines && newS.engines.node) {
    var eng = satisfies(hostNode, newS.engines.node);
    if (eng === false) blockers.push('engines.node ' + newS.engines.node + ' 不满足 node ' + hostNode);
  }
  var peerRange = newS.peer && newS.peer['@deepseek-ai/dsh'];
  if (peerRange) {
    var peer = satisfies(hostVersion, peerRange);
    if (peer === false) blockers.push('peer @deepseek-ai/dsh ' + peerRange + ' 不满足宿主 ' + hostVersion);
  }
  if (watchEntry) reviews.push('卡片: ' + watchEntry.reason);
  var groups = {};
  diff.changed.forEach(function (c) { var k = classifyRel(c.rel); (groups[k] = groups[k] || []).push(c); });
  diff.added.forEach(function (r) { var k = classifyRel(r); (groups[k] = groups[k] || []).push({ rel: r, added: true }); });
  if (diff.removed.length) reviews.push('删除文件 ' + diff.removed.length + ' 个: ' + diff.removed.slice(0, 6).join(', '));
  if (groups['cordis-patch']) {
    reviews.push('cordis.patch.yml 变了（bundle 默认行/配置可能变）');
  } else if (rowsOld && rowsNew && JSON.stringify(rowsOld) !== JSON.stringify(rowsNew)) {
    reviews.push('cordis.patch.yml 行结构变了');
  }
  if (groups['lib'] || groups['component']) reviews.push('lib 运行时代码变了 ' + ((groups['lib'] || []).length + (groups['component'] || []).length) + ' 个文件');
  if (diff.added.some(function (r) { return /^lib\/components\//.test(r); })) reviews.push('新增组件目录');
  if (groups['dsh-plugin'] || groups['manifest']) {
    var pjChange = diff.changed.filter(function (c) { return c.rel === 'package.json'; }).length > 0;
    if (pjChange) {
      var metaDiffs = diffKeys(oldS.peer, newS.peer).concat(diffKeys(oldS.deps, newS.deps)).concat(diffKeys(oldS.optional, newS.optional));
      if (metaDiffs.length) reviews.push('依赖/peer 变化: ' + metaDiffs.slice(0, 4).join('; '));
      if (JSON.stringify(oldS.exports) !== JSON.stringify(newS.exports)) reviews.push('exports 键变了');
      if (JSON.stringify(oldS.clientInject) !== JSON.stringify(newS.clientInject)) reviews.push('dsh.client.inject 变了');
      if (JSON.stringify(oldS.components) !== JSON.stringify(newS.components)) reviews.push('组件清单变了: ' + oldS.components.length + ' -> ' + newS.components.length);
    }
  }
  var onlyClient = diff.changed.every(function (c) { return classifyRel(c.rel) === 'client'; });
  var onlyMeta = diff.changed.every(function (c) { return classifyRel(c.rel) === 'manifest' || classifyRel(c.rel) === 'docs'; });
  if (blockers.length) return { level: 'BLOCK', blockers: blockers, reviews: reviews, safe: safe };
  if (reviews.length) return { level: 'REVIEW', blockers: blockers, reviews: reviews, safe: safe };
  if (diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0) return { level: 'SAFE', blockers: blockers, reviews: [], safe: ['与已装版本逐字节相同'] };
  if (onlyMeta) return { level: 'SAFE', blockers: [], reviews: [], safe: ['仅 package.json/文档变化'] };
  if (onlyClient) return { level: 'SAFE', blockers: [], reviews: [], safe: ['仅客户端 UI 产物变化(需重启生效)'] };
  return { level: 'REVIEW', blockers: [], reviews: reviews.concat(['未归类变化']), safe: [] };
}

async function cmdAnalyze(args, flags) {
  var json = flags.indexOf('--json') >= 0;
  if (!args.length) throw new Error('analyze 需要 pkg@ver');
  var t = parseTarget(args[0]);
  var got = await ensurePackage(t.name, t.version);
  var installedDir = path.join(PROFILE, 'node_modules', t.name);
  if (!fs.existsSync(installedDir)) throw new Error('没装这个包: ' + installedDir);
  var oldS = pkgSummary(installedDir), newS = pkgSummary(got.extracted);
  // 双基线：干净旧版 tarball 才是上游基线（已装目录含本地补丁/.bak，不能当基线）
  var pristineOld = await ensurePackage(t.name, oldS.version);
  var diff = diffTrees(pristineOld.extracted, got.extracted);
  var localDiff = diffTrees(pristineOld.extracted, installedDir);
  var rowsOld = yamlRows(path.join(pristineOld.extracted, 'cordis.patch.yml'));
  var rowsNew = yamlRows(path.join(got.extracted, 'cordis.patch.yml'));
  var watch = loadWatch()[t.name] || null;
  var profileRows = couplingRows(path.join(PROFILE, 'cordis.patch.yml')) || [];
  var cp = couplingAnalyze({ name: t.name, oldDir: pristineOld.extracted, newDir: got.extracted, profileRows: profileRows, watch: watch || {}, localDiff: localDiff });
  var risk = riskOf(t.name, diff, oldS, newS, rowsOld, rowsNew, watch);
  var sameVer = oldS.version === t.version && diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0;
  if (sameVer) {
    risk = { level: cp.verdict === 'BLOCK' ? 'BLOCK' : 'SAFE', blockers: [], reviews: [], safe: ['同版本且解包与已装逐字节相同（本次只验证工具链）'] };
    if (cp.verdict === 'ADAPT') risk.safe.push('本机有本地补丁/改动（见 C4），真实升级时必须重打/重放');
  } else {
    // 4 点判定补充旧的粗风险分级
    cp.blockers.forEach(function (s) { if (risk.blockers.indexOf(s) < 0) risk.blockers.push(s); });
    if (cp.verdict === 'ADAPT' && risk.level === 'SAFE') risk.level = 'ADAPT';
    if (cp.verdict === 'BLOCK') risk.level = 'BLOCK';
  }
  var bakCount = 0;
  try { bakCount = listFiles(installedDir).filter(function (f) { return /\.bak/.test(f.rel); }).length; } catch (e) {}
  var result = {
    name: t.name, requested: t.version, installedVersion: oldS.version, diff: diff, old: oldS, next: newS,
    rowsOld: rowsOld, rowsNew: rowsNew, risk: risk, watch: watch, localBakFiles: bakCount,
    coupling: cp, localDiff: { changed: localDiff.changed.map(function (c) { return c.rel; }), added: localDiff.added, removed: localDiff.removed }
  };
  if (json) { console.log(JSON.stringify(result, null, 2)); return risk.level === 'BLOCK' ? 1 : 0; }
  console.log('== ' + t.name + ' ' + oldS.version + ' (已装)' + (oldS.version === t.version ? '  [同版本，analyze 只在验证解包/校验脚本]' : ' -> ' + t.version) + ' ==');
  console.log('变化: 修改 ' + diff.changed.length + ' 个文件, 新增 ' + diff.added.length + ', 删除 ' + diff.removed.length);
  if (bakCount) console.log('[warn] 已装目录含 ' + bakCount + ' 个 .bak 本地改动（本地改动已单独统计: 修改 ' + localDiff.changed.length + ' / 新增 ' + localDiff.added.length + ' 个文件）');
  var byGroup = {};
  diff.changed.forEach(function (c) { var k = classifyRel(c.rel); (byGroup[k] = byGroup[k] || []).push(c); });
  Object.keys(byGroup).sort().forEach(function (k) {
    console.log('  [' + k + '] ' + byGroup[k].length + ' 个');
    byGroup[k].slice(0, 12).forEach(function (c) {
      console.log('    ' + c.rel + (c.oldSize !== c.newSize ? '  (' + c.oldSize + 'B -> ' + c.newSize + 'B)' : ''));
    });
  });
  if (diff.added.length) console.log('  新增: ' + diff.added.slice(0, 15).join(', '));
  if (diff.removed.length) console.log('  删除: ' + diff.removed.slice(0, 15).join(', '));
  if (rowsOld && rowsNew) {
    var oldIds = rowsOld.map(function (r) { return r.id + '|' + (r.name || ''); });
    var newIds = rowsNew.map(function (r) { return r.id + '|' + (r.name || ''); });
    var rowNotes = [];
    newIds.forEach(function (x) { if (oldIds.indexOf(x) < 0) rowNotes.push('+ ' + x); });
    oldIds.forEach(function (x) { if (newIds.indexOf(x) < 0) rowNotes.push('- ' + x); });
    rowsOld.forEach(function (o) {
      var n = rowsNew.filter(function (x) { return x.id === o.id; })[0];
      if (n && (o.disabled !== n.disabled || JSON.stringify(o.keys) !== JSON.stringify(n.keys))) rowNotes.push('~ ' + o.id + ' disabled ' + o.disabled + '->' + n.disabled + ' keys ' + JSON.stringify(o.keys) + '->' + JSON.stringify(n.keys));
    });
    if (rowNotes.length) { console.log('  bundle patch 行变化:'); rowNotes.slice(0, 20).forEach(function (l) { console.log('    ' + l); }); }
  }
  if (rowsOld && rowsNew) {
    var oldLines = fs.readFileSync(path.join(installedDir, 'cordis.patch.yml'), 'utf8').split(/\r?\n/);
    var newLines = fs.readFileSync(path.join(got.extracted, 'cordis.patch.yml'), 'utf8').split(/\r?\n/);
    var addedLines = onlyIn(newLines, oldLines, 20), removedLines = onlyIn(oldLines, newLines, 20);
    if (addedLines.length || removedLines.length) {
      console.log('  patch 文本差异(+新/-旧，最多 20 行):');
      addedLines.forEach(function (l) { console.log('    + ' + l); });
      removedLines.forEach(function (l) { console.log('    - ' + l); });
    }
  }
  var pjDiffs = diffKeys(oldS.peer, newS.peer).concat(diffKeys(oldS.deps, newS.deps), diffKeys(oldS.optional, newS.optional));
  if (pjDiffs.length) { console.log('  依赖/peer:'); pjDiffs.slice(0, 15).forEach(function (l) { console.log('    ' + l); }); }
  if (JSON.stringify(oldS.exports) !== JSON.stringify(newS.exports)) console.log('  exports: ' + oldS.exports.join(',') + '  =>  ' + newS.exports.join(','));
  if (watch) {
    console.log('');
    console.log('[卡片] ' + watch.reason);
    (watch.afterUpgrade || []).forEach(function (s) { console.log('  - ' + s); });
  }
  console.log('');
  console.log('== 本机 4 个耦合点 ==');
  [cp.C1, cp.C2, cp.C3, cp.C4].forEach(function (c) {
    console.log('[' + c.id + '] ' + c.title + '  ' + (c.touched ? 'TOUCHED（需适配）' : '未触及'));
    (c.notes || []).slice(0, 12).forEach(function (s) { console.log('    ' + s); });
    (c.actions || []).forEach(function (s) { console.log('    -> ' + s); });
  });
  console.log('4 点判定: ' + cp.verdict);
  console.log('');
  console.log('风险判定: ' + risk.level);
  risk.blockers.forEach(function (s) { console.log('  [BLOCK] ' + s); });
  risk.reviews.forEach(function (s) { console.log('  [REVIEW] ' + s); });
  risk.safe.forEach(function (s) { console.log('  [SAFE] ' + s); });
  var next = risk.level === 'SAFE' ? '可直接 apply' : (risk.level === 'BLOCK' ? '不要升，先解决 BLOCK 项' : (risk.level === 'ADAPT' ? '按上面 C1-C4 的 -> 动作准备适配，改完再 apply' : '读上面 REVIEW 项，必要时 grep 源码后再 apply'));
  console.log('建议: ' + next);
  return risk.level === 'BLOCK' ? 1 : 0;
}

// ---------- contract（本机 4 个耦合点断言） ----------
function cmdContract(flags) {
  var json = flags.indexOf('--json') >= 0;
  var prof = profilePkg();
  var depNames = Object.keys(prof.dependencies || {});
  var ct = couplingContract({ profileDir: PROFILE, deps: depNames, watch: loadWatch() });
  if (json) { console.log(JSON.stringify(ct, null, 2)); return ct.ok ? 0 : 1; }
  console.log('== contract  宿主 ' + ct.host + ' · 已装包 ' + ct.packages + ' · 检查项 ' + ct.checks.length + ' ==');
  ct.issues.forEach(function (i) { console.log((i.sev === 'error' ? '[error]' : '[warn] ') + ' [' + i.point + '] ' + i.detail); });
  ct.checks.forEach(function (s) { console.log('  ' + s); });
  console.log(ct.ok ? 'contract OK' : 'contract 未通过（看上面 [error]）');
  return ct.ok ? 0 : 1;
}

// ---------- verify ----------
// loadprof.cjs / compose2.cjs 是本机辅助脚本，不在本公开仓库内；缺失时按「跳过」处理并显式打印。
function runElectron(script) {
  var file = path.join(__dirname, script);
  if (!fs.existsSync(file)) return { code: null, out: '', missing: true, file: file };
  var r = spawnSync(ELECTRON, [file], { encoding: 'utf8', timeout: 300000, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), missing: false, file: file };
}
function cmdVerify(flags) {
  var json = flags.indexOf('--json') >= 0;
  var lp = runElectron('loadprof.cjs');
  var cm = runElectron('compose2.cjs');
  var layers = /layers[:\s]+(\d+)/.exec(lp.out);
  var skipped = /skipped:\s*(\[[^\]]*\])/.exec(lp.out);
  var entries = /entries[:\s]+(\d+)/.exec(cm.out);
  var warns = /warns[:\s]+(\d+)/.exec(cm.out);
  var ct = null;
  try {
    var prof = profilePkg();
    ct = couplingContract({ profileDir: PROFILE, deps: Object.keys(prof.dependencies || {}), watch: loadWatch() });
  } catch (e) {
    ct = { ok: false, issues: [{ sev: 'error', point: 'contract', detail: 'contract 运行失败: ' + e.message }], checks: [] };
  }
  var ctErrors = ct.issues.filter(function (i) { return i.sev === 'error'; });
  var ctWarns = ct.issues.filter(function (i) { return i.sev !== 'error'; });
  var res = {
    loadprof: { code: lp.code, layers: layers ? +layers[1] : null, skipped: skipped ? skipped[1] : null },
    compose2: { code: cm.code, entries: entries ? +entries[1] : null, warns: warns ? +warns[1] : null },
    contract: { ok: ct.ok, checks: ct.checks.length, errors: ctErrors, warns: ctWarns }
  };
  var skippedList = [];
  try { skippedList = JSON.parse(res.loadprof.skipped || '[]'); } catch (e) {}
  var lpOk = lp.missing ? true : (lp.code === 0 && res.loadprof.layers !== null && skippedList.length === 0);
  var cmOk = cm.missing ? true : (cm.code === 0 && res.compose2.warns === 0);
  res.partial = !!(lp.missing || cm.missing);
  res.ok = lpOk && cmOk && ct.ok;
  if (json) { console.log(JSON.stringify(res, null, 2)); return res.ok ? 0 : 1; }
  console.log('[loadprof] ' + (lp.missing ? '跳过（未随仓库提供 ' + path.basename(lp.file) + '）' : 'layers ' + (res.loadprof.layers === null ? '?' : res.loadprof.layers) + '  skipped ' + (res.loadprof.skipped || '?')));
  console.log('[compose2] ' + (cm.missing ? '跳过（未随仓库提供 ' + path.basename(cm.file) + '）' : 'entries ' + (res.compose2.entries === null ? '?' : res.compose2.entries) + '  warns ' + (res.compose2.warns === null ? '?' : res.compose2.warns)));
  console.log('[contract] 检查 ' + ct.checks.length + ' 项  error ' + ctErrors.length + '  warn ' + ctWarns.length + '  -> ' + (ct.ok ? 'OK' : '未通过'));
  ctErrors.forEach(function (i) { console.log('  [error] [' + i.point + '] ' + i.detail); });
  ctWarns.forEach(function (i) { console.log('  [warn] [' + i.point + '] ' + i.detail); });
  if (!res.ok) {
    console.log('校验未通过，原始输出尾部:');
    console.log(lp.out.slice(-1500));
    console.log(cm.out.slice(-2500));
  } else {
    console.log('离线校验 OK');
  }
  return res.ok ? 0 : 1;
}

// ---------- apply ----------
async function cmdApply(args, flags) {
  var dry = flags.indexOf('--dry-run') >= 0, noVerify = flags.indexOf('--no-verify') >= 0, force = flags.indexOf('--force') >= 0;
  if (!args.length) throw new Error('apply 需要至少一个 pkg@ver');
  var targets = args.map(parseTarget), watch = loadWatch();
  var plan = [];
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var rec = { name: t.name, version: t.version, installed: installedVersion(t.name), skip: false, reasons: [] };
    if (rec.installed === t.version && !force) { rec.skip = true; rec.reasons.push('已装同版本（--force 可强制重装）'); }
    var w = watch[t.name];
    if (w && w.noUpgrade) { rec.skip = true; rec.reasons.push('卡片标记不可升级: ' + w.reason); }
    try {
      var meta = await registryMeta(t.name);
      var v = (meta.versions || {})[t.version];
      if (!v) { rec.skip = true; rec.reasons.push('注册表没有该版本'); }
      else {
        var peer = (v.peerDependencies || {})['@deepseek-ai/dsh'];
        if (peer && satisfies(hostVersion, peer) === false) { rec.skip = true; rec.reasons.push('peer 不兼容: ' + peer); }
        if (v.engines && v.engines.node && satisfies(hostNode, v.engines.node) === false) { rec.skip = true; rec.reasons.push('engines.node 不兼容: ' + v.engines.node); }
      }
    } catch (e) { rec.reasons.push('注册表查询失败(继续但无法预检): ' + e.message); }
    plan.push(rec);
  }
  var todo = plan.filter(function (r) { return !r.skip; });
  plan.forEach(function (r) { console.log((r.skip ? '[skip] ' : '[plan] ') + r.name + '@' + (r.installed || '?') + ' -> ' + r.version + (r.reasons.length ? '  (' + r.reasons.join('; ') + ')' : '')); });
  if (!todo.length) { console.log('没有要执行的升级'); return 0; }

  /* 2026-10-20 用户规则：不逐项目留备份（只要结果，不要过程）。
   * 回滚不靠备份目录，靠卡片 rollback 里的精确版本重装（版本号已钉死在 plugins/*.json），
   * 所以这里不再 cp profile 五文件。 */

  var text = wsText(), changedWs = false;
  todo.forEach(function (r) {
    var next = mraeAdd(text, r.name, r.version);
    if (next !== text) { text = next; changedWs = true; console.log('[mrae] 放行 ' + r.name + '@' + r.version); }
  });
  var specs = todo.map(function (r) { return r.name + '@' + r.version; });
  var cmdline = [DSHCMD, 'plugin', '--profile', PROFILE_NAME, 'add'].concat(specs.map(function (s) { return "'" + s + "'"; })).join(' ');
  if (dry) {
    console.log('[dry-run] 将写入 pnpm-workspace.yaml minimumReleaseAgeExclude: ' + (changedWs ? '是' : '无需改动'));
    console.log('[dry-run] 将执行: ' + cmdline);
    return 0;
  }
  if (changedWs) fs.writeFileSync(path.join(PROFILE, 'pnpm-workspace.yaml'), text);
  console.log('[install] ' + cmdline);
  var inst = spawnSync('cmd.exe', ['/c', DSHCMD.replace(/\//g, '\\'), 'plugin', '--profile', PROFILE_NAME, 'add'].concat(specs), { stdio: 'inherit', cwd: DS, timeout: 600000 });
  if (inst.status !== 0) {
    console.log('[error] 安装失败：按 2026-10-20 规则不留备份，回滚按卡片 rollback 重装旧版即可');
    return 1;
  }
  todo.forEach(function (r) { r.now = installedVersion(r.name); console.log('[installed] ' + r.name + ' -> ' + (r.now || '?')); });

  var verify = null;
  if (!noVerify) { console.log('[verify] 跑离线校验...'); verify = cmdVerify([]); }
  todo.forEach(function (r) { updateCardAfterApply(r, verify); });

  console.log('');
  console.log('==== 升级摘要（卡片 + archive/history.md 已自动更新）====');
  console.log('日期: ' + new Date().toISOString());
  todo.forEach(function (r) { console.log('- ' + r.name + ': ' + (r.installed || '?') + ' -> ' + (r.now || r.version)); });
  console.log('离线校验: ' + (verify === null ? '跳过' : (verify === 0 ? '通过' : '未通过(见上)')));
  console.log('备份: 无（2026-10-20 规则：不逐项目留备份；回滚按卡片 rollback 重装旧版）');
  var watched = todo.map(function (r) { return watch[r.name]; }).filter(Boolean);
  if (watched.length) {
    console.log('');
    console.log('[升级后必做]');
    watched.forEach(function (w) { (w.afterUpgrade || []).forEach(function (s) { console.log('  - ' + s); }); });
  }
  console.log('');
  console.log('[下一步] 1) 补卡片: plugins/<pkg>.json 的 lastChange.what 写一句改了什么、current/verifyExtra 按需改（installed/lastVerified 已自动写）');
  console.log('          2) 重启: 交给看守排程（scripts/arm-restart.cjs --minutes 3）；手动双击 restart-dsh.cmd 仅兜底');
  console.log('          3) 重启后跑 upgrade.cjs verify（含 contract）+ 按卡片 verifyExtra 验收');
  return verify === null || verify === 0 ? 0 : 1;
}

// ---------- 卡片回写（apply 成功后） ----------
function updateCardAfterApply(r, verify) {
  var f = path.join(CARDS_DIR, r.name.replace(/\//g, "__") + ".json");
  var c = tryJread(f);
  if (!c) { console.log("[card] 没有卡片，跳过: " + r.name); return; }
  var now = new Date();
  c.installed = r.now || r.version;
  c.lastChange = { from: r.installed || null, to: c.installed, what: "（apply 自动记录；人工补一句这次改了什么）" };
  c.lastVerified = now.toISOString();
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
  console.log("[card] 已更新 " + path.basename(f) + "（installed / lastChange / lastVerified）");
  try {
    if (!fs.existsSync(path.dirname(ARCHIVE_FILE))) fs.mkdirSync(path.dirname(ARCHIVE_FILE), { recursive: true });
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    var line = "- " + now.getFullYear() + "-" + p2(now.getMonth() + 1) + "-" + p2(now.getDate()) + " " + p2(now.getHours()) + ":" + p2(now.getMinutes()) +
      " | " + r.name + " " + (r.installed || "?") + " → " + (r.now || r.version) +
      " | " + (verify === null ? "未跑 verify" : (verify === 0 ? "verify 通过" : "verify 未通过")) + "（apply 自动追加）";
    fs.appendFileSync(ARCHIVE_FILE, line + "\n");
    console.log("[history] 已追加 1 行");
  } catch (e) { console.log("[history] 追加失败: " + e.message); }
}

// ---------- inventory（由卡片生成插件清单） ----------
function couplingOf(c) {
  var cp = c.coupling || {}, out = [];
  if ((cp.patchFiles || []).length) out.push("patches×" + cp.patchFiles.length);
  if ((cp.profileRows || []).length) out.push("profile行 " + cp.profileRows.map(function (r) { return r.id; }).join(","));
  if (cp.strictConfigKeys) out.push("严格白名单");
  if ((cp.inject || []).length) out.push("inject " + cp.inject.join(","));
  return out.length ? out.join(" · ") : "无";
}
function cmdInventory(flags) {
  var md = flags.indexOf("--md") >= 0, json = flags.indexOf("--json") >= 0;
  var cards = loadCards();
  var rows = Object.keys(cards).map(function (p) {
    var c = cards[p], lc = c.lastChange;
    return {
      pkg: p, installed: c.installed, kind: c.kind || "third-party",
      change: lc ? ((lc.from || "?") + " → " + lc.to) : "—",
      coupling: couplingOf(c),
      lastVerified: c.lastVerified || "—",
      noUpgrade: !!c.noUpgrade
    };
  });
  rows.sort(function (a, b) { return a.pkg < b.pkg ? -1 : (a.pkg > b.pkg ? 1 : 0); });
  if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  if (md) {
    console.log("# 插件清单（生成物，禁止手改）");
    console.log("");
    console.log("生成: upgrade.cjs inventory --md　来源: plugins/*.json　生成时间: " + new Date().toISOString());
    console.log("");
    console.log("| 包 | 已装 | 类型 | 最近改动 | 本机耦合 | lastVerified |");
    console.log("| --- | --- | --- | --- | --- | --- |");
    rows.forEach(function (r) {
      console.log("| " + r.pkg + " | " + r.installed + " | " + r.kind + " | " + r.change + " | " + r.coupling + " | " + String(r.lastVerified).slice(0, 10) + " |");
    });
    return 0;
  }
  console.log(pad("包", 44) + pad("已装", 12) + pad("类型", 16) + pad("耦合", 34) + "最近改动");
  rows.forEach(function (r) {
    console.log(pad(r.pkg, 44) + pad(r.installed, 12) + pad(r.kind, 16) + pad(r.coupling, 34) + r.change + (r.noUpgrade ? "  [noUpgrade]" : ""));
  });
  console.log("共 " + rows.length + " 张卡，来源 " + CARDS_DIR);
  return 0;
}

// ---------- watch ----------
function cmdWatch() {
  var watch = loadWatch(), cards = loadCards();
  console.log('卡片目录: ' + CARDS_DIR + '（' + Object.keys(cards).length + ' 张卡）');
  Object.keys(watch).forEach(function (k) {
    var e = watch[k];
    console.log('');
    console.log('- ' + k + '@' + (e.installed || '?') + (e.noUpgrade ? '  [noUpgrade]' : '') + (e.patchFiles.length ? '  [本地补丁 ' + e.patchFiles.length + ']' : '') + (e.strictConfigKeys ? '  [严格白名单]' : ''));
    console.log('  原因: ' + e.reason);
    (e.afterUpgrade || []).forEach(function (s) { console.log('  验收: ' + s); });
  });
  return 0;
}

async function main() {
  var argv = process.argv.slice(2);
  var cmd = argv[0] || 'check';
  var flags = argv.filter(function (a) { return a.charAt(0) === '-'; });
  var args = argv.slice(1).filter(function (a) { return a.charAt(0) !== '-'; });
  var code = 0;
  if (cmd === 'check') code = await cmdCheck(flags);
  else if (cmd === 'analyze') code = await cmdAnalyze(args, flags);
  else if (cmd === 'apply') code = await cmdApply(args, flags);
  else if (cmd === 'verify') code = cmdVerify(flags);
  else if (cmd === 'contract') code = cmdContract(flags);
  else if (cmd === 'inventory') code = cmdInventory(flags);
  else if (cmd === 'watch') code = cmdWatch();
  else { console.log('用法: upgrade.cjs check|analyze <pkg>@<ver>|apply <pkg>@<ver> ...|verify|contract|inventory [--md]|watch  [--json|--md|--dry-run|--no-verify|--force]'); code = 2; }
  process.exitCode = code;
}
main().catch(function (e) { console.error('错误: ' + ((e && e.stack) ? e.stack : e)); process.exitCode = 1; });
