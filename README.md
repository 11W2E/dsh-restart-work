# dsh-restart-work

DSH Desktop（DeepSeek Harness 桌面版）的**重启工作**：由宿主体外的常驻看守（supervisor）按请求重启宿主，在旧宿主退出后清理陈旧认证 cookie，等新宿主就绪后再自动把提示词注入输入框并发送。

一句话：**不需要人盯重启，也不需要人记得「重启完要发什么」。**

---

## 为什么需要它

DSH Desktop 换插件、换配置后必须重启宿主才生效，但重启这件事在本机有三个硬约束：

1. **宿主不能自己重启自己。** 桌面壳启动的子进程都在同一个 Windows Job Object 里，宿主一退出整个进程树陪葬，症状是「只关闭、不打开」。重启必须由不属于该进程树的进程发起。
2. **重启之后还有一步人工动作。** 验收脚本要在新宿主里跑（插件已加载、端口已就绪），这步留给人就等于每周一有个待办。
3. **旧认证 cookie 会累积。** 桌面壳每次启动用随机端口，认证 cookie 名为 `dsh-auth-<hash(authority)>`，同主机不同端口各一条、默认 30 天不回收。约 70 次重启后 Cookie 头超过 Node 默认 16 KB 上限，宿主回 431，桌面壳 welcome 校验失败，启动即崩。

本仓库把这三件事拼成一条无人值守的重启链路。

---

## 重启链路

```
调用方（任意脚本 / agent / 计划任务）
   │  arm-restart.cjs --minutes N --inject-delay-sec M --prompt-file p.txt
   ▼
~/.dsh/dsh-power/pending/restart-request.json     ← 重启请求（含 prompt、两个间隔）
   │
   ▼  计划任务 DSH_supervisor（登录即起，独立于宿主进程树）
supervisor.ps1  状态机 idle → restarting → waiting_up → idle
   │ 到点：restart.cmd（taskkill → start） → 旧宿主退出
   │
   ├─ clean-auth-cookies.cjs：宿主退出后删 127.0.0.1/localhost/[::1] 的 dsh-auth-*，保留 dsh_pair
   │
   ▼ 新宿主进程出现 + 窗口就绪
   │ 等 injectDelaySec（默认 60s，可设置）
   ▼
OCR 定位输入框坐标 → 点击 → 清空 → 粘贴提示词 → 校验回读 → Enter
   │
   ▼
pending/inject-result.json + inject-results.ndjson（成功/失败、坐标、重试次数、截图证据）
```

状态机只在 **idle** 时触发重启（避免重启过程中又被下一轮触发，形成连环重启）；`restarting` 超过 180 秒宿主仍未换 pid 则放弃请求并记为 `restart-timeout`。

---

## 组件

| 文件 | 作用 |
| --- | --- |
| `scripts/arm-restart.cjs` | 写重启请求；参数缺省取设置文件，默认 2 分钟 / 60 秒；已有未完成请求时退出码 3 |
| `scripts/supervisor.ps1` | 常驻看守：到点重启、等宿主退出后清 cookie、等新宿主就绪后注入；状态机与日志都在 `~/.dsh/dsh-power/` |
| `scripts/clean-auth-cookies.cjs` | 用 `node:sqlite` 打开 Chromium 的 `Network/Cookies`，删陈旧 `dsh-auth-*`，保留 `dsh_pair` |
| `scripts/supervisor-control.mjs` | 注册/检查计划任务、读状态、写设置、arm/disarm；供插件或其他 Node 代码 import |
| `scripts/weekly-upgrade.cjs` | 调用方示例：翻市场与 registry、判耦合、只装无耦合包、验收后排一次重启+注入 |
| `scripts/upgrade.cjs` | 单包 check / analyze / apply / verify / contract / inventory |

文档：

- `docs/FLOW.md` —— 完整链路设计（调度 → 执行 → 编排 → 重启与注入 → 验收），含时序图、状态机、失败分支表
- `docs/OPERATIONS.md` —— 日常操作、验收清单、回滚、日志位置、排障、安全边界

---

## 快速开始（只启用「重启工作」）

前置：Windows、已安装 DSH Desktop、有 Electron（作为 node 运行脚本）。

```powershell
# 1) 环境变量（不设则用推导默认值）
$env:DSH_ELECTRON="C:\path\to\electron.exe"      # 必填示例：用于跑 .cjs
$env:DSH_POWER_STATE_DIR="$env:USERPROFILE\.dsh\dsh-power"

# 2) 注册看守计划任务（登录即启动，独立于宿主进程树）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\supervisor.ps1 -TaskName DSH_supervisor # 首次也可用 supervisor-control.mjs 的 ensureSupervisor()

# 3) 排一次重启（3 分钟后重启，重启后 60 秒注入 p.txt）
node .\scripts\arm-restart.cjs --minutes 3 --inject-delay-sec 60 --prompt-file p.txt

# 4) 看结果
Get-Content "$env:USERPROFILE\.dsh\dsh-power\watch.log" -Tail 20
Get-Content "$env:USERPROFILE\.dsh\dsh-power\pending\inject-result.json"
```

注：`supervisor.ps1` 是长驻循环脚本，由计划任务托管；`node` 可用 Electron 的 `ELECTRON_RUN_AS_NODE=1`。

---

## 两个间隔

| 间隔 | 含义 | 默认 | 范围 |
| --- | --- | --- | --- |
| restartDelayMinutes | 从现在到重启的延迟 | 2 分钟 | 0–1440 |
| injectDelaySec | 新宿主进程出现后等多久注入 | 60 秒 | 0–3600 |

优先级：**内置默认 < 插件 config < 用户设置文件**（`~/.dsh/dsh-power/supervisor-settings.json`）。两个值都可被单次请求覆盖，调用方（agent / 脚本）可按场景自由指定，文档只给默认值。

---

## 与「每周自动更新」的关系

`scripts/weekly-upgrade.cjs` 是调用方示例，不是本仓库的主线：

```
检查更新 → 四点耦合判定（C1–C4）→ 只装 NO_ADAPT → verify → arm-restart 排程 → 重启后注入验收提示词 → 汇报
```

也就是说：**重启工作负责「怎么安全地重启并让它自己验收」，更新只是其中一个使用场景。** 任何需要「重启后自动做一件事」的流程都可以复用这条链路。

---

## 边界与限制

- 仅 Windows；看守与注入依赖 Win32 API（SetCursorPos / mouse_event / 剪贴板 / Windows.Media.Ocr）与 PowerShell 5.1+。
- OCR 注入要求宿主窗口可见、输入框在屏幕上可定位；锁屏、远程会话最小化、多显示器缩放异常时可能失败（失败会记 `inject-result.json`，不会静默）。
- 重启由 `restart.cmd` 执行（默认由 dsh-power 插件生成）；本仓库不发布该生成器，请按自己的安装方式提供。
- `scripts/` 中的脚本按「工作区 + 插件状态目录」组织；放进你的环境时改环境变量即可，无需改代码。
- 看守的 HTTP 控制路由复用宿主认证，裸 curl 返回 401 属正常；agent 侧走 CLI（`arm-restart.cjs`）。

---

## 安全

- cookie 清理只删 `host_key IN ('127.0.0.1','localhost','[::1]')` 且 `name LIKE 'dsh-auth-%'` 的行，保留配对 cookie 与其他站点。
- 看守只在自己的状态目录读写请求/状态/日志，不写宿主目录。
- 不包含任何主机名、IP、账号、cookie 值；路径全部来自环境变量或 `os.homedir()`。

---

## License

MIT，见 [LICENSE](LICENSE)。
