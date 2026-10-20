# 操作与排障（OPERATIONS）

## 安装 / 升级

```powershell
$d = Join-Path $env:USERPROFILE '.dsh\restart-work'
New-Item -ItemType Directory -Force $d, (Join-Path $d 'pending') | Out-Null
# 放好 supervisor.ps1 / arm-restart.cjs / restart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "$d\supervisor.ps1" -Install -RestartCmd "$d\restart.ps1"
```

`-Install` 会注册（或覆盖）计划任务，任务名默认 `DSH_restart_work`，登录时自动启动，动作就是
`powershell.exe -File <supervisor.ps1> -Image "DeepSeek Harness" -TaskName DSH_restart_work -StateDir <StateDir> -RestartCmd <StateDir>\restart.ps1`。

重启脚本推荐用 `.ps1`（`Start-Restart` 会用 Windows PowerShell 直接执行）；若坚持用 `.cmd`，文件必须是 CRLF 换行，否则 cmd.exe 在 LF 下会静默不执行——表现为 `watch.log` 有 `restart: launching` 但宿主没被杀。

升级看守：替换 `supervisor.ps1`，然后 `Stop-ScheduledTask` + `Start-ScheduledTask`（或重跑 `-Install`）。

改状态目录：传 `-StateDir D:\dsh-restart`，`-Install` 会把新路径写进任务动作；`arm-restart.cjs` 侧用 `DSH_RESTART_STATE_DIR` 环境变量对齐。

## 排程一次重启

```powershell
# 2 分钟后重启，宿主起来 60 秒后注入
node arm-restart.cjs --minutes 2 --inject-delay-sec 60 --prompt-file C:\temp\prompt.txt

# 立刻重启（0 分钟），起来立刻注入（0 秒）
node arm-restart.cjs --minutes 0 --inject-delay-sec 0 --prompt "重启后跑一遍验收，3 行汇报。"
```

提示词建议写文件传 `--prompt-file`：Git Bash 之类的 shell 会改写 `--prompt` 里的 URL / 反斜杠。

## 取消排程

- 删掉 `<StateDir>\pending\restart-request.json` 即可（看守下一轮回到空闲）。
- 已经进入 `restarting`（restart.cmd 已调用）则无法取消，只能等它跑完。

## 只看注入、不重启（自测）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\restart-work\supervisor.ps1" -InjectNow -TestPrompt "self test"
```

会立刻在当前前台窗口尝试注入并写 `inject-test.json`。用来确认 OCR 语言包、坐标、剪贴板权限是否正常。

## 看日志

`<StateDir>\watch.log`（只追加，按时间顺序），典型片段：

```
supervisor start pid=1234 image=DeepSeek Harness pending=C:\Users\me\.dsh\restart-work\pending
request 20261020134631 armed, restartAtMs=1760951311000
restart: request 20261020134631 due (22:12:45)
restart: launching C:\Users\me\.dsh\restart-work\restart.cmd
host exited; request 20261020134631 -> wait host up
host up pid=5678; inject at +60s
inject: start request 20261020134631
inject: 20261020134631 sent at point 960,833
inject: ok=True reason= detail=point 960,833 attempt 1
```

`pending/inject-result.json` 是给下一次会话的 agent 读的裁决依据；`evidence-*.png` 是现场截图。

## 排障表

| 现象 | 先看 | 处理 |
| --- | --- | --- |
| 到点没重启 | `watch.log` 有没有 `request ... armed` / `due` | 任务是否在跑：`Get-ScheduledTask -TaskName DSH_restart_work`；请求文件是否被提前删掉 |
| `restart-timeout` | restart.cmd 的 taskkill 是否真的杀掉了进程 | 用任务管理器确认映像名是否就是 `DeepSeek Harness.exe` |
| 宿主起来但没注入 | `phase` 是否卡在 `restarting` | 看是不是 180 秒兜底前就超时；确认新宿主确实是新 pid |
| `focus-failed` | 是否锁屏 / RDP 断开 / 有置顶窗口 | 解锁桌面后重新预约 |
| `wrong-window` | 窗口标题 | 宿主窗口标题必须含 `DeepSeek`，或改 `-Image` 参数 |
| `dialog` | 截图里的对话框 | 宿主启动就失败，先修宿主（插件/配置/认证），别重试注入 |
| `verify-failed` | `evidence-*-before.png` | 输入框占位文字变了：改 `Invoke-Inject` 里的候选关键词，或调整底部偏移候选点 |
| `expired` | restart.cmd 与宿主崩溃日志 | 宿主 30 分钟没起来 |
| 装任务报权限错 | 是否管理员启动的 shell | 计划任务注册到当前用户即可，不需要管理员；被策略禁止时改用「任务计划程序」GUI 导入 |
| 看守起不来 / 立刻退出 | `watch.log` 是否已有实例 | 全局互斥量在，一台机器只跑一个；先停旧任务 |

## 注意

- 看守必须由计划任务（或服务）拉起；从 DSH 里 spawn 会被 Job Object 连带杀掉。
- 注入期间会短暂占用鼠标、键盘与剪贴板（约 3–5 秒），结束后恢复剪贴板。
- 截屏与 OCR 都在本机完成，不上传任何内容。
