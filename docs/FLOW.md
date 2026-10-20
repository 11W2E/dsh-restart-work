# 流程设计（FLOW）

本文描述重启工作从「排程」到「注入结果」的完整链路，以及每一步失败时会发生什么。

## 1. 角色

| 角色 | 生命周期 | 职责 |
| --- | --- | --- |
| 调用方 | 任意进程 / agent 会话 | 写一条请求：何时重启、重启后注入什么 |
| 请求文件 | 磁盘上的 JSON | 唯一控制面；原子写完成后立刻生效 |
| 看守（supervisor.ps1） | 登录计划任务常驻，独立于 DSH 进程树 | 轮询请求、执行重启、等待新宿主、注入提示词、写结果 |
| restart.cmd | 由看守按需调用 | 结束宿主进程并重新启动（可由使用者替换） |
| 结果文件 / 日志 | 磁盘 | `inject-result.json` 给下一次会话的 agent 读；`watch.log` 给人排障 |

## 2. 时序

```
调用方                看守                    宿主(DSH)            会话 UI
  │ arm-restart.cjs
  │──写 restart-request.json──▶
  │                          │ 轮询（每 ~1s）
  │                          │ 到 restartAtMs
  │                          │──调用 restart.cmd──▶ (被杀)
  │                          │                       │
  │                          │◀──进程消失────────────┘
  │                          │ phase=waiting_up
  │                          │◀──进程重新出现─────────┘
  │                          │ 等 injectDelaySec
  │                          │──置前 + 截图 + OCR──▶
  │                          │──点击输入框 / Ctrl+A / Delete / 粘贴 / 回读校验 / 回车──▶
  │                          │ 写 inject-result.json
  │──下一次会话读结果─────────┘
```

## 3. 状态机

看守把状态写在 `pending/supervisor-state.json`，只有三个相位：

| 相位 | 含义 | 离开条件 |
| --- | --- | --- |
| `idle` | 空闲；有请求且到点也只从 idle 触发一次重启 | 到点且请求存在 → `restarting` |
| `restarting` | 已调用 restart.cmd，等宿主退出 | 宿主进程消失 → `waiting_up`；180 秒宿主 pid 未变 → 放弃请求回 `idle`（`restart-timeout`） |
| `waiting_up` | 宿主已退出或已重启，等注入时点 | 到 `injectAtMs` → 注入 → 归档请求回 `idle`；30 分钟宿主没起来 → `expired` |

**只在 `idle` 触发重启**是硬规则：`waiting_up` / `restarting` 阶段绝不再触发，否则会连环重启（宿主刚起来就被杀掉）。`restarting` 阶段另有两条兜底：restart.cmd 没杀掉宿主 → 180 秒超时放弃；宿主 pid 已经变了（重启很快，看守没抓到「消失」那一瞬）→ 直接判定重启完成、进入 `waiting_up`。

## 4. 注入算法

注入不靠 DSH 的任何接口，只用 Win32 UI 自动化 + 系统 OCR：

1. **找窗口**：`Get-Process -Name $Image` 里取带主窗口句柄的进程；窗口标题必须包含 `DeepSeek`，否则 `wrong-window`。
2. **置前**：`SetForegroundWindow` + `AttachThreadInput` 抢焦点；抢不到不放弃，改为「点一下窗口内部」激活。
3. **截图 + OCR**：截窗口存 `evidence-<id>-before.png`，用 `Windows.Media.Ocr` 识别文字。
4. **排除错误对话框**：OCR 文本里出现 `could not start` / `authentication failed` / `Web authentication` / `无法启动` / `身份验证失败` 等关键词时直接放弃（`dialog`），避免把提示词打进崩溃对话框。
5. **定位输入框**：OCR 里匹配占位文字（`发消息或创建任务` / `调用指令` / `输入消息` / `reply` 等）；找不到就用窗口底部按固定偏移的候选点兜底。
6. **粘贴并自校验**：候选点逐个尝试 —— 点击 → `Ctrl+A`、`Delete` 清空 → 剪贴板写入提示词 → `Ctrl+V` → `Ctrl+A`、`Ctrl+C` 回读剪贴板 → 与原文逐字比对。
   - 一致：`Right` 折叠选区 → 确认前台仍是目标窗口 → `Enter` 发送。
   - 不一致：`Esc` 取消，换下一个候选点。
7. **收尾**：恢复用户原剪贴板，存 `evidence-<id>-after.png`，写 `inject-result.json`。

## 5. 结果与失败分支

| `reason` | 触发条件 | 处理 |
| --- | --- | --- |
| `no-window` | 宿主进程在，但没有主窗口 | 等窗口出现后重试一次；仍无则手动点开 GUI |
| `wrong-window` | 主窗口标题不含 `DeepSeek` | 确认窗口名，必要时改 `-Image` |
| `dialog` | OCR 命中崩溃/认证失败关键词 | 先修宿主，别重试注入 |
| `focus-failed` | 抢不到前台，但之后「点击激活」兜底仍失败 | 解锁桌面、关掉置顶窗口；或手动注入 |
| `verify-failed` | 所有候选点粘贴后回读都不一致 | 看 before/after 截图确认输入框位置，必要时调整占位关键词 |
| `restart-timeout` | 180 秒内宿主 pid 没变 | 检查 restart.cmd 是否真的杀掉了 `DeepSeek Harness.exe` |
| `expired` | 30 分钟内宿主没起来 | 看 restart.cmd / 宿主崩溃日志 |

失败不会重试整个请求：结果文件写下后请求归档，重新预约即可。

## 6. 并发与互斥

- 全局互斥量 `Global\DSH_restart_work_<Image>`：同一台机器只允许一个看守实例，重复启动直接退出。
- 计划任务 `MultipleInstances IgnoreNew`：登录触发叠加时不会跑两份。
- 一次只处理一个请求：`restart-request.json` 存在期间 `arm-restart.cjs` 拒绝写入（退出码 3）。
- 看守**不能**由 DSH 自己启动：DSH 的 Job Object 会连同子进程一起结束；必须由计划任务/服务拉起。

## 7. 安全边界

- 不修改 DSH 安装目录、不注入进程、不 hook 网络；唯一接触点是「模拟键鼠 + 剪贴板」。
- 注入内容就是调用方给的文本；看守不生成、不解析、不回传会话内容。
- 截图只落在本地 `pending/` 下，随请求归档；不需要时删掉整个目录即可。
