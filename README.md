# dsh-restart-work

让 **DeepSeek Harness 桌面版** 能「预约重启」：任意脚本或 agent 写下一条请求 —— *N 分钟后重启宿主，重启后自动把这段提示词发进会话* —— 之后不需要任何人点鼠标。

## 为什么需要它

- DSH 桌面版是 Electron 应用，插件跑在宿主进程里。宿主被关闭/重启时，插件**没有机会执行收尾逻辑**（Windows 上通常是直接结束进程），所以「关闭后做点什么」只能交给宿主之外的进程。
- 插件升级、配置变更都要重启宿主才生效；重启完还得有人跑到会话里做验收。
- 这个仓库提供一个**独立常驻看守**（登录计划任务拉起，活在 DSH 进程树之外）：它按请求重启宿主，并在宿主重新起来后把验收提示词注入会话。

## 链路

```
调用方（agent / 升级脚本 / 手动）
      │  node arm-restart.cjs --minutes 2 --inject-delay-sec 60 --prompt-file prompt.txt
      ▼
<StateDir>/pending/restart-request.json      ← 请求文件（原子写，写完即生效）
      │
      ▼  看守（计划任务 DSH_restart_work，常驻）
  到点 → 调 <StateDir>/restart.cmd          ← 结束宿主进程并重新启动（脚本可替换）
      │
      ▼  等宿主进程消失 → 等它重新出现
  +injectDelaySec 秒
      │
      ▼  Win32 UI 自动化：找窗口 → 找会话输入框（OCR）→ 点击 → 粘贴 → 回车
<StateDir>/pending/inject-result.json        ← 结果（ok / 失败原因 / 截图证据）
```

## 目录结构

默认 StateDir = `%USERPROFILE%\.dsh\restart-work`（可用环境变量 `DSH_RESTART_STATE_DIR` 覆盖）。

| 路径 | 作用 |
| --- | --- |
| `scripts/supervisor.ps1` | 看守本体：轮询请求、调 restart.cmd、等宿主、注入提示词、写日志与结果 |
| `scripts/arm-restart.cjs` | 写请求的 CLI（Node 即可，无需依赖） |
| `scripts/restart-sample.cmd` | restart.cmd 示例：taskkill + 等待退出 + 重新启动 |
| `pending/restart-request.json` | 待处理请求（一个看守同时只处理一条） |
| `pending/supervisor-state.json` | 看守自己的状态机，不要手改 |
| `pending/inject-result.json` | 最近一次注入结果 |
| `pending/done/` | 处理完的请求归档 |
| `watch.log` | 只追加的运行日志（排障先看这里） |
| `restart.cmd` | 真正的重启脚本，默认路径在 StateDir 下 |

## 快速开始

1. 建目录并放文件（三份脚本放一起即可）：

   ```powershell
   $d = Join-Path $env:USERPROFILE '.dsh\restart-work'
   New-Item -ItemType Directory -Force $d, (Join-Path $d 'pending') | Out-Null
   # 把 scripts/supervisor.ps1、scripts/arm-restart.cjs 复制到 $d
   # 把 scripts/restart-sample.cmd 复制成 $d\restart.cmd，改成你自己的 DSH 安装路径
   ```

2. 装计划任务（登录时自动启动，退出登录前一直在）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\restart-work\supervisor.ps1" -Install
   ```

   默认任务名 `DSH_restart_work`，动作指向同一份 `supervisor.ps1`，状态目录同上。

3. 预约一次重启：

   ```powershell
   node "$env:USERPROFILE\.dsh\restart-work\arm-restart.cjs" --minutes 2 --inject-delay-sec 60 --prompt-file C:\temp\prompt.txt
   ```

   两分钟后看守会重启 DSH；宿主起来 60 秒后，提示词被粘贴进会话输入框并回车发送。

4. 看结果：`pending/inject-result.json` 与 `watch.log`。

## 两个间隔

| 间隔 | 参数 | 默认 | 范围 | 谁决定 |
| --- | --- | --- | --- | --- |
| 多久后重启 | `--minutes`（请求字段 `minutes` / `restartAtMs`） | 2 分钟 | 0–1440 | 调用方，每次请求现定 |
| 重启后多久注入 | `--inject-delay-sec`（请求字段 `injectDelaySec`） | 60 秒 | 0–3600 | 调用方，每次请求现定 |

没有隐藏的全局配置：两个值都写在请求文件里，请求与行为一一对应。`supervisor.ps1` 的 `-PostUpDelaySec` 只在请求没写该字段时兜底。

## 请求文件格式

`pending/restart-request.json`：

```json
{
  "id": "20261020134631",
  "createdAtMs": 1760951191000,
  "restartAtMs": 1760951311000,
  "minutes": 2,
  "injectDelaySec": 60,
  "prompt": "重启后请跑一遍验收脚本，用 3 行汇报结果。",
  "note": "plugin-upgrade"
}
```

- 只认 `restartAtMs`（毫秒时间戳）决定何时重启。
- `injectDelaySec` 缺省时用看守的 `-PostUpDelaySec`（默认 60）。
- 已有未处理请求时，`arm-restart.cjs` 退出码 3，不会覆盖。

## 结果怎么读

`pending/inject-result.json`：

```json
{ "id": "20261020134631", "ok": true, "reason": "", "detail": "point 960,833 attempt 1",
  "at": "2026-10-20T14:50:42.1234567+08:00", "evidence": ["...-before.png", "...-after.png", "...-ocr.txt"] }
```

`ok=false` 时 `reason` 取值：`focus-failed` / `verify-failed` / `inject-abort` / `restart-timeout` / `expired`。各原因含义与处理见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 边界与安全

- **Windows 10/11**。注入依赖 Win32 UI 自动化（找窗口、置前、移动指针点击、剪贴板、SendInput），必须有可交互的桌面会话；锁屏、断开的远程桌面下不保证成功。
- 看守必须由**计划任务或服务**拉起。不要从 DSH 里 spawn 它：DSH 的 Job Object 会把子进程一起杀掉。
- 不修改 DSH 的代码、不注入进程、不读会话内容；只是把一段你给的文本粘贴进输入框再回车。
- OCR 用系统语言包（`Windows.Media.Ocr`）。没有可用语言包时注入会失败并在日志里说明。
- 请求文件是唯一的控制面：想取消就删掉它（看守会回到空闲）。

## 卸载

```powershell
Stop-ScheduledTask -TaskName DSH_restart_work
Unregister-ScheduledTask -TaskName DSH_restart_work -Confirm:$false
Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE '.dsh\restart-work')
```

## License

MIT
