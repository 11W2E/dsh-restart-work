# 操作手册

面向日常使用与排障。流程原理见 [FLOW.md](FLOW.md)。

---

## 日常操作

### 干跑（最常用）

只看判定，不动任何文件：

```powershell
set ELECTRON_RUN_AS_NODE=1
"%USERPROFILE%\.dsh\electron\electron.exe" tools\weekly-upgrade.cjs --dry-run
```

输出写在 `reports/weekly-YYYYMMDD-dryrun.md` 与 `reports/last-dryrun.json`。适合周一先看「本周有哪些包、能不能自动装」，再决定是否真跑。

### 正式跑（装包 + 验收，但不重启）

```powershell
"%USERPROFILE%\.dsh\electron\electron.exe" tools\weekly-upgrade.cjs --restart-after 0
```

装完立刻 verify，只是不排重启。注意：**不重启则新插件不会生效**，验收只能覆盖「文件已就位」，覆盖不到「宿主加载后是否崩」。

### 限定范围

```powershell
:: 最多看 3 个包
... weekly-upgrade.cjs --max 3
:: 只处理指定包（跳过发现阶段，直接进 analyze）
... weekly-upgrade.cjs --pkg some-plugin@1.2.3 other-plugin@0.9.0
```

### 单包手动作业

```powershell
... tools\upgrade.cjs check
... tools\upgrade.cjs analyze some-plugin@1.2.3
... tools\upgrade.cjs apply  some-plugin@1.2.3 --profile desktop
... tools\upgrade.cjs verify --json
... tools\upgrade.cjs inventory
```

`analyze` 的输出是给人看的适配报告；`--json` 才是给编排用的。

### 手动排一次重启 + 注入

```powershell
... scripts\arm-restart.cjs --minutes 2 --inject-delay-sec 60 --prompt-file .\accept-prompt.txt
```

写入 `~/.dsh/dsh-power/pending/restart-request.json`。看守下一次轮询（≤2 秒）就会读到，按 `restartAtMs` 到点执行。

若已存在请求，退出码 `3` + stderr `pending request already exists` —— 这是「已排程」，不是错误。

### 取消排程

三种都行，任选其一：

```powershell
:: 1) 删请求文件
Remove-Item "$env:USERPROFILE\.dsh\dsh-power\pending\restart-request.json" -Force
:: 2) HTTP（宿主在跑时）
curl -X POST http://127.0.0.1:19387/dsh-power/api/disarm
:: 3) 删回落用的计划任务
schtasks /Delete /TN DSH_restart_after_update /F
```

看守处于 `restarting` / `waiting_up` 时 `disarm` 会被拒（`409 not-idle`）—— 重启已经在进行，取消没有意义。

### 设置两个间隔

改 `~/.dsh/dsh-power/supervisor-settings.json`（设置页写的就是它）：

```json
{ "restartDelayMinutes": 5, "injectDelaySec": 90, "updatedAt": "2026-10-20T10:00:00Z", "updatedBy": "settings-page" }
```

范围：分钟 `0–1440`，秒 `0–3600`。看守每轮重读，改完立即生效，**不需要重启看守**。

---

## 验收清单（12 项）

升级后跑 `tools/accept.cjs`，全部通过才算成功：

| # | 项 | 通过标准 |
| --- | --- | --- |
| 1 | verify: 宿主版本 | 与预期版本一致 |
| 2 | verify: 依赖与契约 | 无缺失依赖、无 engines 冲突 |
| 3 | verify: 插件清单一致性 | 清单与磁盘内容一致 |
| 4 | 监听端口 | 当前网卡上 `:19387` 按预期出现 |
| 5 | 回环端口 | `127.0.0.1:3081` 可达 |
| 6 | `/api/pair/status` | 返回 200 |
| 7 | `/api/session.list` | 返回 **401**（无凭据时被拒才对） |
| 8 | Hindsight 服务 | `:9077` 返回 healthy |
| 9 | `im-connect` 版本 | `1.0.9` |
| 10 | 崩溃日志 | 最近 30 分钟内无 `crash-*.log` |
| 11 | 升级版本一致性 | 与上一轮升级目标版本相同 |
| 12 | 插件卡 `verifyExtra` | 逐条通过 |

第 10 项的日志目录：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\`。

---

## 回滚

插件升级的回滚是「装回旧版本」，没有快照式回滚：

```powershell
... tools\upgrade.cjs apply some-plugin@<旧版本> --profile desktop
```

需要注意的点：

- **配置可能已被新版迁移。** 若插件在启动时改写了 profile 配置，装回旧版未必能恢复到升级前状态；重要环境升级前先备份 `~/.dsh/profiles/<name>/`。
- **回滚同样要重启。** 装回旧版后仍需 `arm-restart.cjs` 让宿主重新加载。
- **就地补丁可能残留。** 若旧版是「原样」而新版打过 patch，回滚后 `patches/` 里对 bundle 的改动需要确认已还原，否则宿主行为与版本号不符。

---

## 日志与状态文件

| 文件 | 内容 |
| --- | --- |
| `~/.dsh/dsh-power/watch.log` | 看守主日志：状态迁移、重启、cookie 清理、注入各步骤；> 256 KB 自动清空 |
| `~/.dsh/dsh-power/cleanup-cookies.log` | 清理器日志：删了几行、跳过原因 |
| `~/.dsh/dsh-power/restart.log` | `restart.cmd` 只写 begin / launched 两行；> 64 KB 或超 30 天自动清理 |
| `~/.dsh/dsh-power/pending/inject-result.json` | 最近一次注入裁决：success / reason / 时间戳 |
| `~/.dsh/dsh-power/pending/inject-results.ndjson` | 历次注入结果，一行一条 |
| `~/.dsh/dsh-power/pending/supervisor-state.json` | 看守相位与时间戳（排障第一现场） |
| `~/.dsh/dsh-power/pending/evidence-<id>-before.png` / `after.png` / `ocr.txt` | 注入前后截图与 OCR 全文 |
| `reports/weekly-YYYYMMDD.md` | 每周报告（人读） |
| `reports/last-weekly.json` / `last-dryrun.json` | 最近一次结果（机读） |

排障顺序：`inject-result.json`（结论）→ `watch.log`（过程）→ `evidence-*.png`（现场）→ `supervisor-state.json`（卡在哪个相位）。

---

## 故障排查

### 注入失败

先看 `inject-result.json` 的 `reason`：

| reason | 含义 | 处理 |
| --- | --- | --- |
| `dialog` | 屏幕上有错误/认证弹窗，坏词命中 | 看 `evidence-*-after.png`。认证失败多半是 cookie 清理没生效或宿主没起对 |
| `verify-failed` | 候选点都试过，剪贴板内容对不上 | UI 可能改版。看 `evidence-*-ocr.txt` 里有没有输入框占位文案，更新候选列表 |
| `no-window` | 到点找不到主窗口 | 宿主没起来或还在启动动画。看 `watch.log` 的 pid 变化与 `restart.log` |
| `restart-timeout` | 180 秒内宿主 pid 没变 | `restart.cmd` 没跑起来：计划任务被禁用、路径失效、权限不足 |
| `expired` | `waiting_up` 超过 30 分钟 | 宿主一直没起来。手动启动宿主后再手动注入 |

### 守护任务没在跑

```powershell
Get-ScheduledTask -TaskName DSH_supervisor | Get-ScheduledTaskInfo
schtasks /Query /TN DSH_supervisor /V /FO LIST
:: 看进程：看守是 powershell.exe，命令行里带 supervisor.ps1
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Select ProcessId,CommandLine
```

常见原因：

- **任务存在但从未触发** —— 触发器是「登录时」，需要重新登录或手动 `Start-ScheduledTask -TaskName DSH_supervisor`。
- **多实例被忽略** —— 参数里有 `-MultipleInstances IgnoreNew`，已有一个看守在跑时新实例直接退出，这是预期行为。用全局互斥 `Global\DSH_supervisor_<Image>` 也能判断。
- **参数与当前配置不匹配** —— `supervisor-control.mjs` 的 `ensureSupervisor()` 会比对任务参数，不匹配时重新注册；改过设置后调一次即可。

### cookie 头溢出（431）

症状：`restart.log` 显示已 launched，但宿主起来后立刻崩，日志里有 `desktop welcome: Web authentication failed`；抓包或 `watch.log` 里能看到 `431`。

原因与修法见 [FLOW.md](FLOW.md) 的「cookie 清理的位置」。手工救急：

```powershell
set ELECTRON_RUN_AS_NODE=1
"%USERPROFILE%\.dsh\electron\electron.exe" scripts\clean-auth-cookies.cjs --force
```

`--force` 跳过「DSH 是否已退出」的检查。`--dry-run` 只看要删几行。

### .ps1 乱码 / 语法炸

**`supervisor.ps1` 必须带 UTF-8 BOM。** PowerShell 5.1 读无 BOM 的 UTF-8 文件时按 ANSI（中文系统 = GBK）解码：中文注释变乱码是小事，真正的问题是某些中文字节序列会「吃掉」后面的换行，导致参数块被拼成一行、语法直接失败。

检查与修复：

```powershell
$b = [IO.File]::ReadAllBytes('scripts\supervisor.ps1')[0..2]
'{0:X2} {1:X2} {2:X2}' -f $b[0],$b[1],$b[2]   # 应为 EF BB BF
```

丢了 BOM 就用「UTF-8 with BOM」重新保存。**不要**用 `Set-Content -Encoding UTF8`（PS 5.1 会写成带 BOM，但 PS 7 写成无 BOM），跨版本行为不一致。

### 中文输出乱码

子进程（`schtasks`、`powershell.exe`）的输出是**控制台代码页字节**，不是 UTF-8。直接 `toString()` 会得到乱码，用正则匹配会误判。

正确做法（`supervisor-control.mjs` 的 `readTask()` 就是这么做的）：让子进程把结果以 UTF-8 转 base64 输出，父进程解码后再解析。详见脚本内的 `-EncodedCommand` 用法。

### 只关闭不打开（Job Object 脱树失败）

`restart.cmd` 的启动器有三档，按优先级回退：

1. **计划任务 `DSH_power_restart`** —— 首选。任务由 svchost 拉起，天然不在宿主 Job Object 内。
2. **WMI `Win32_Process.Create`** —— 次选，父进程是 `WmiPrvSE.exe`，也不在宿主 Job 内。
3. **detached `spawn`** —— 仅兜底。它**仍在**宿主 Job Object 内，宿主一死这个子进程一起被销毁，症状就是「只关闭不打开」。

如果三档都失效，检查：

- 计划任务是否被安全软件删了（`schtasks /Query /TN DSH_power_restart` 报找不到）
- 触发账户是否有「作为批处理作业登录」权限
- `restart.cmd` 里是否误给 `start` 加了输出重定向 —— 那会让 `start` 卡住等管道，且日志句柄被继承

### 计划任务启动（首次注册看守）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\supervisor.ps1 -Install
```

`-Install` 注册 `DSH_supervisor`：登录即启、`IgnoreNew` 多实例策略、无执行时限。注册后建议手动 `Start-ScheduledTask` 一次并确认 `watch.log` 有启动行。

---

## 安全边界

- **HTTP 路由复用宿主认证。** `/dsh-power/*` 全部走宿主的 `connection.requestRejection()`，与宿主 `/api` 同一套规则：loopback 直接放行；非 loopback 需过 Host 白名单 + cookie；拿不到 `connection` 时按 fail-closed 只放行 loopback。
- **裸 `curl` 得到 401 是正常现象**，不是服务坏了。`/api/session.list` 的 401 本身就是验收第 7 项 —— 未带凭据应当被拒。
- **仅 loopback 放行。** 这些接口能排重启、能写注入提示词，不对外网开放；不要为了「方便」把监听地址改成 `0.0.0.0`。
- **注入的提示词以当前用户桌面权限执行。** 看守能模拟键鼠、读屏幕、写剪贴板，等价于「有一个自动操作用户桌面的进程」。它的安全性完全取决于谁能写 `pending/restart-request.json` —— 这个目录应当只对当前用户可写。
- **凭据不进脚本。** 本仓库不含任何令牌、cookie 值或配对密钥；清理器只按 cookie 名匹配删除，不读取值。
