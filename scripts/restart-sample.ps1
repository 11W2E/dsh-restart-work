<#
restart-sample.ps1 — 重启 DSH 桌面的示例脚本（看守到点会调用它）

用法：
  1) 复制成 <StateDir>\restart.ps1，按自己的安装路径改 -Exe
  2) 安装时指定：supervisor.ps1 -Install -RestartCmd "<StateDir>\restart.ps1"

为什么用 .ps1 而不是 .cmd：GitHub 上的 .cmd 文件默认是 LF 换行，cmd.exe 的
for/call 在 LF 下会解析失败（实测会静默不执行，宿主不死也不重启）。.ps1 没有这个问题。
#>
param(
  [string]$Image = 'DeepSeek Harness',
  [string]$Exe = 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
)

Get-Process -Name $Image -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_.Kill() } catch { }
}

# 最多等 10 秒，确认进程真的退出
for ($i = 0; $i -lt 20; $i++) {
  if (-not (Get-Process -Name $Image -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}

Start-Process -FilePath $Exe
