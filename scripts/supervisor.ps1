<#
supervisor.ps1 — DSH 桌面版「重启工作」看守（独立进程，由登录计划任务常驻）

职责：
  1) 轮询 pending/restart-request.json，到 restartAtMs 时调用 restart.cmd 重启宿主
  2) 宿主退出后等它重新起来
  3) 起来后等 injectDelaySec 秒（请求里指定，缺省 60），读屏定位输入框、粘贴提示词、回车发送
  4) 全程写 watch.log 与 pending/inject-result.json，供下一次会话的 agent 读裁决

请求文件（同目录 arm-restart.cjs 或任意脚本写）：
  <StateDir>/pending/restart-request.json = { id, createdAtMs, restartAtMs, minutes, injectDelaySec, prompt, note }

默认目录（%USERPROFILE%\.dsh\restart-work）：
  pending/restart-request.json   信号文件，写完即生效
  pending/supervisor-state.json  看守状态机（不要手改）
  pending/inject-result.json     最近一次注入结果
  pending/done/                  已归档请求
  watch.log                      仅追加日志
  restart.cmd                    真正的重启脚本（杀宿主再启动，可自己换）
#>
param(
  [string]$Image = 'DeepSeek Harness',
  [string]$TaskName = 'DSH_restart_work',
  [string]$StateDir = (Join-Path $env:USERPROFILE '.dsh\restart-work'),
  [string]$RestartCmd = '',
  [string]$Log = '',
  [string]$PendingDir = '',
  [int]$PostUpDelaySec = 60,
  [int]$ExpireMin = 30,
  [switch]$Install,
  [switch]$InjectNow,
  [string]$TestPrompt = ''
)

if (-not $PendingDir) { $PendingDir = Join-Path $StateDir 'pending' }
if (-not $Log) { $Log = Join-Path $StateDir 'watch.log' }
if (-not $RestartCmd) { $RestartCmd = Join-Path $StateDir 'restart.cmd' }
if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
if (-not (Test-Path -LiteralPath $PendingDir)) { New-Item -ItemType Directory -Path $PendingDir -Force | Out-Null }

$ErrorActionPreference = 'SilentlyContinue'
$script:PSExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script:RequestPath = Join-Path $PendingDir 'restart-request.json'
$script:StatePath = Join-Path $PendingDir 'supervisor-state.json'
$script:ResultPath = Join-Path $PendingDir 'inject-result.json'
$script:ResultsPath = Join-Path $PendingDir 'inject-results.ndjson'
$script:State = $null
$script:LastPid = 0
$script:OcrReady = $false
$script:OcrEngine = $null
$script:AsTask = $null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Nat {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@

function Write-WatchLog([string]$msg) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
  try {
    $dir = Split-Path -Parent $Log
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $fi = Get-Item -LiteralPath $Log -ErrorAction SilentlyContinue
    if ($fi -and $fi.Length -gt 256KB) { Remove-Item -LiteralPath $Log -Force }
    Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
  } catch { }
}

function Test-HostRunning {
  return [bool](@(Get-Process -Name $Image -ErrorAction SilentlyContinue).Count)
}

function Get-DshWindow {
  $procs = @(Get-Process -Name $Image -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  if ($procs.Count -eq 0) { return $null }
  $best = $null; $bestArea = -1
  foreach ($p in $procs) {
    $r = New-Object Nat+RECT
    if ([Nat]::GetWindowRect($p.MainWindowHandle, [ref]$r)) {
      $area = ([long]($r.R - $r.L)) * ([long]($r.B - $r.T))
      if ($area -gt $bestArea) {
        $bestArea = $area
        $best = [pscustomobject]@{ Pid = $p.Id; Hwnd = $p.MainWindowHandle; Rect = $r; Title = $p.MainWindowTitle }
      }
    }
  }
  return $best
}

function Save-WindowShot($win, [string]$path) {
  try {
    Add-Type -AssemblyName System.Drawing
    $r = $win.Rect
    $w = [Math]::Max(1, $r.R - $r.L); $h = [Math]::Max(1, $r.B - $r.T)
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    return $true
  } catch { return $false }
}

function Initialize-Ocr {
  if ($script:OcrReady) { return $true }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    $script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1') })[0]
    $script:OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    $script:OcrReady = ($null -ne $script:OcrEngine -and $null -ne $script:AsTask)
  } catch { $script:OcrReady = $false }
  return $script:OcrReady
}

function Await-Op($op, $resultType) {
  $m = $script:AsTask.MakeGenericMethod($resultType)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}

function Get-OcrLines([string]$png) {
  if (-not (Initialize-Ocr)) { return $null }
  try {
    $file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
    $stream = Await-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-Op ($script:OcrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) {
      $x0 = 1e9; $y0 = 1e9; $x1 = -1; $y1 = -1
      foreach ($wd in $line.Words) {
        $bx = $wd.BoundingRect.X; $by = $wd.BoundingRect.Y; $bw = $wd.BoundingRect.Width; $bh = $wd.BoundingRect.Height
        if ($bx -lt $x0) { $x0 = $bx }
        if ($by -lt $y0) { $y0 = $by }
        if (($bx + $bw) -gt $x1) { $x1 = $bx + $bw }
        if (($by + $bh) -gt $y1) { $y1 = $by + $bh }
      }
      $lines += [pscustomobject]@{ Text = $line.Text; X0 = [int]$x0; Y0 = [int]$y0; X1 = [int]$x1; Y1 = [int]$y1 }
    }
    return $lines
  } catch { return $null }
}

function Send-Click([int]$x, [int]$y) {
  [Nat]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 60
  [Nat]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [Nat]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-Key([int]$vk) {
  [Nat]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [Nat]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
}

function Send-CtrlKey([int]$vk) {
  [Nat]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 20
  [Nat]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  [Nat]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
  [Nat]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
}

function Focus-Window($win) {
  $hwnd = [IntPtr]$win.Hwnd
  for ($i = 0; $i -lt 4; $i++) {
    Send-Key 0x12
    [Nat]::ShowWindowAsync($hwnd, 9) | Out-Null
    [Nat]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0043) | Out-Null
    $fg = [Nat]::GetForegroundWindow()
    $fpid = [uint32]0
    $fthread = [Nat]::GetWindowThreadProcessId($fg, [ref]$fpid)
    $mythread = [Nat]::GetCurrentThreadId()
    [Nat]::AttachThreadInput($fthread, $mythread, $true) | Out-Null
    [Nat]::SetForegroundWindow($hwnd) | Out-Null
    [Nat]::AttachThreadInput($fthread, $mythread, $false) | Out-Null
    Start-Sleep -Milliseconds 300
    if ([Nat]::GetForegroundWindow() -eq $hwnd) { return $true }
  }
  return $false
}

function Restore-TopMost($win) {
  try { [Nat]::SetWindowPos([IntPtr]$win.Hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0043) | Out-Null } catch { }
}

function Invoke-Inject([string]$prompt, [string]$id) {
  $res = [ordered]@{ id = $id; at = (Get-Date).ToString('o'); ok = $false; reason = ''; detail = ''; focused = $false; tried = 0; evidence = @() }
  $win = Get-DshWindow
  if (-not $win) { $res.reason = 'no-window'; return [pscustomobject]$res }
  $res.pid = $win.Pid
  $res.hwnd = [long]$win.Hwnd
  if (-not $win.Title -or -not ($win.Title -match 'DeepSeek')) { $res.reason = 'wrong-window'; $res.detail = $win.Title; return [pscustomobject]$res }
  $res.focused = Focus-Window $win
  if (-not $res.focused) { Write-WatchLog 'inject: foreground focus failed; will activate by clicking inside window' }
  Start-Sleep -Milliseconds 300

  $shot1 = Join-Path $PendingDir ('evidence-' + $id + '-before.png')
  if (Save-WindowShot $win $shot1) { $res.evidence += $shot1 }
  $lines = Get-OcrLines $shot1
  if ($lines -and $lines.Count -gt 0) {
    $ocrTxt = Join-Path $PendingDir ('evidence-' + $id + '-ocr.txt')
    try { ($lines | ForEach-Object { $_.Text }) -join [Environment]::NewLine | Set-Content -LiteralPath $ocrTxt -Encoding UTF8 } catch { }
    $joined = ($lines | ForEach-Object { $_.Text }) -join ' '
    $bad = @('could not start', 'authentication failed', 'Web authentication', 'Diagnostic report', 'is unavailable', '无法启动', '身份验证失败', '不可用')
    foreach ($k in $bad) {
      if ($joined -match [regex]::Escape($k)) {
        $res.reason = 'dialog'; $res.detail = $k
        Write-WatchLog ('inject: abort, dialog keyword [' + $k + ']')
        Restore-TopMost $win
        return [pscustomobject]$res
      }
    }
  }

  $cands = @()
  if ($lines) {
    $ph = @('发消息或创建任务', '调用指令', '文件或对话', '输入消息', 'reply')
    foreach ($l in $lines) {
      foreach ($k in $ph) {
        if ($l.Text -match [regex]::Escape($k)) {
          $cands += , @([int](($l.X0 + $l.X1) / 2), [int](($l.Y0 + $l.Y1) / 2))
          break
        }
      }
    }
  }
  $r = $win.Rect
  $cx = [int](($r.L + $r.R) / 2)
  foreach ($off in @(101, 140, 160)) { $cands += , @($cx, ($r.B - $off)) }

  $seen = @{}; $list = @()
  foreach ($c in $cands) {
    $k = '' + $c[0] + ',' + $c[1]
    if (-not $seen.ContainsKey($k)) { $seen[$k] = 1; $list += , $c }
  }

  $orig = ''
  try { $orig = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { }
  $ok = $false
  foreach ($c in $list) {
    $res.tried = $res.tried + 1
    Send-Click $c[0] $c[1]
    Start-Sleep -Milliseconds 250
    if (-not ([Nat]::GetForegroundWindow() -eq [IntPtr]$win.Hwnd)) {
      Focus-Window $win | Out-Null
      Start-Sleep -Milliseconds 200
    }
    Send-CtrlKey 0x41   # Ctrl+A
    Start-Sleep -Milliseconds 120
    Send-Key 0x2E       # Delete 清空（避免残留草稿干扰比对）
    Start-Sleep -Milliseconds 120
    Set-Clipboard -Value $prompt -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 120
    Send-CtrlKey 0x56   # Ctrl+V
    Start-Sleep -Milliseconds 500
    Send-CtrlKey 0x41   # Ctrl+A
    Start-Sleep -Milliseconds 150
    Send-CtrlKey 0x43   # Ctrl+C
    Start-Sleep -Milliseconds 300
    $got = ''
    try { $got = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { }
    if ($null -eq $got) { $got = '' }
    if ($prompt.Trim().Length -gt 0 -and $got.Trim() -eq $prompt.Trim()) {
      Send-Key 0x27     # Right：把全选折叠到末尾
      Start-Sleep -Milliseconds 150
      if (-not ([Nat]::GetForegroundWindow() -eq [IntPtr]$win.Hwnd)) {
        Send-Click $c[0] $c[1]
        Start-Sleep -Milliseconds 200
        Focus-Window $win | Out-Null
        Start-Sleep -Milliseconds 200
      }
      if (-not ([Nat]::GetForegroundWindow() -eq [IntPtr]$win.Hwnd)) {
        Send-Key 0x1B
        continue
      }
      Send-Key 0x0D     # Enter 发送
      Start-Sleep -Milliseconds 600
      Write-WatchLog ('inject: ' + $id + ' sent at point ' + $c[0] + ',' + $c[1])
      $ok = $true
      $res.detail = 'point ' + $c[0] + ',' + $c[1] + ' attempt ' + $res.tried
      break
    } else {
      Send-Key 0x1B     # Esc 取消
      Start-Sleep -Milliseconds 150
    }
  }
  try { if ($orig) { Set-Clipboard -Value $orig -ErrorAction SilentlyContinue } } catch { }
  Restore-TopMost $win
  $shot2 = Join-Path $PendingDir ('evidence-' + $id + '-after.png')
  if (Save-WindowShot $win $shot2) { $res.evidence += $shot2 }
  $res.ok = $ok
  if (-not $ok) { $res.reason = 'verify-failed'; $res.detail = 'tried ' + $res.tried + ' points' }
  return [pscustomobject]$res
}

function Start-Restart {
  Write-WatchLog ('restart: launching ' + $RestartCmd)
  try { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $RestartCmd + '"') -WindowStyle Hidden | Out-Null } catch { Write-WatchLog 'restart: launch failed' }
}

function Read-Json($path) {
  try {
    if (Test-Path -LiteralPath $path) {
      $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
      if ($raw -and $raw.Trim()) { return ($raw | ConvertFrom-Json) }
    }
  } catch { }
  return $null
}

function Get-InjectDelaySec($req) {
  # 注入延迟由请求里的 injectDelaySec 决定（agent 自己定）；缺省才用参数里的 PostUpDelaySec。
  if ($req -and ($req.PSObject.Properties.Name -contains 'injectDelaySec') -and $null -ne $req.injectDelaySec) {
    $v = 0
    if ([int]::TryParse([string]$req.injectDelaySec, [ref]$v) -and $v -ge 0 -and $v -le 3600) { return $v }
  }
  return [int]$PostUpDelaySec
}

function Write-Json($path, $obj) {
  try {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $json = $obj | ConvertTo-Json -Depth 8
    $tmp = $path + '.tmp'
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $path -Force
  } catch { }
}

function Read-State {
  $s = [ordered]@{ phase = 'idle'; id = $null; goneAtMs = 0; injectAtMs = 0; restartAtMs = 0; oldPid = 0 }
  $o = Read-Json $script:StatePath
  if ($o) { foreach ($k in @($s.Keys)) { if ($o.PSObject.Properties.Name -contains $k) { $s[$k] = $o.$k } } }
  return $s
}

function Save-State { Write-Json $script:StatePath $script:State }

function Archive-Request([string]$id) {
  if (-not (Test-Path -LiteralPath $script:RequestPath)) { return }
  $done = Join-Path $PendingDir 'done'
  try { if (-not (Test-Path -LiteralPath $done)) { New-Item -ItemType Directory -Path $done -Force | Out-Null } } catch { }
  $dst = Join-Path $done ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $id + '.json')
  try { Move-Item -LiteralPath $script:RequestPath -Destination $dst -Force } catch { }
}

# ---------------- 单次注入自测（不重启、不动请求文件） ----------------
if ($InjectNow) {
  if (-not (Test-Path -LiteralPath $PendingDir)) { New-Item -ItemType Directory -Path $PendingDir -Force | Out-Null }
  $p = $TestPrompt
  if (-not $p) { $p = 'dsh-supervisor self test' }
  $r = Invoke-Inject $p ('test-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Write-Json (Join-Path $PendingDir 'inject-test.json') $r
  Write-Output ($r | ConvertTo-Json -Depth 8)
  exit 0
}

# ---------------- 安装计划任务 ----------------
if ($Install) {
  $arg = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Image "' + $Image + '" -TaskName "' + $TaskName + '" -StateDir "' + $StateDir + '" -RestartCmd "' + $RestartCmd + '"'
  $action = New-ScheduledTaskAction -Execute $script:PSExe -Argument $arg
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'DSH 重启工作：按请求重启宿主 + 重启后自动注入提示词' -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  $t = Get-ScheduledTask -TaskName $TaskName
  Write-WatchLog ('installed task ' + $TaskName + ' state=' + $t.State)
  Write-Output ('task=' + $TaskName + ' state=' + $t.State)
  exit 0
}

# ---------------- 常驻 ----------------
$mutexName = 'Global\DSH_supervisor_' + ($Image -replace '[^A-Za-z0-9]', '_')
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $mutex.WaitOne(0)) {
  Write-WatchLog ('another supervisor already running (' + $mutexName + '), exit')
  exit 0
}

if (-not (Test-Path -LiteralPath $PendingDir)) { New-Item -ItemType Directory -Path $PendingDir -Force | Out-Null }
Write-WatchLog ('supervisor start pid=' + $PID + ' image=' + $Image + ' pending=' + $PendingDir)
$script:State = Read-State
$prev = Test-HostRunning
$armedLogged = $false
while ($true) {
  Start-Sleep -Seconds 2
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $running = Test-HostRunning
  $req = Read-Json $script:RequestPath

  # 1) 到点重启（只在 idle 触发一次；waiting_up/restarting 绝不再触发，否则连环重启）
  if ($running -and $req -and $script:State.phase -eq 'idle' -and $req.restartAtMs -and ([long]$req.restartAtMs) -le $now) {
    $curWin = Get-DshWindow
    $oldPid = 0
    if ($curWin) { $oldPid = [long]$curWin.Pid }
    $dueLocal = ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$req.restartAtMs)).LocalDateTime
    Write-WatchLog ('restart: request ' + $req.id + ' due (' + $dueLocal.ToString('HH:mm:ss') + ')')
    Start-Restart
    $script:State = [ordered]@{ phase = 'restarting'; id = $req.id; goneAtMs = 0; injectAtMs = 0; restartAtMs = [long]$req.restartAtMs; oldPid = $oldPid }
    Save-State
  }

  # 1b) 重启超时兜底：restart.cmd 没把宿主杀掉（pid 没变）就放弃本次请求，避免永远卡在 restarting
  if ($script:State.phase -eq 'restarting' -and $req -and [long]$script:State.restartAtMs -gt 0 -and ($now - [long]$script:State.restartAtMs) -gt 180000) {
    $w = Get-DshWindow
    if ($running -and $w -and [long]$script:State.oldPid -gt 0 -and [long]$w.Pid -eq [long]$script:State.oldPid) {
      Write-WatchLog ('restart: timeout 180s, host pid ' + $script:State.oldPid + ' still alive; abandon request ' + $req.id)
      $res = [pscustomobject]@{ id = $req.id; at = (Get-Date).ToString('o'); ok = $false; reason = 'restart-timeout'; detail = 'host did not exit in 180s'; evidence = @() }
      Write-Json $script:ResultPath $res
      Archive-Request $req.id
      $script:State = [ordered]@{ phase = 'idle' }; Save-State
    }
  }

  # 2) 宿主退出
  if ($prev -and -not $running) {
    Start-Sleep -Seconds 2
    if (-not (Test-HostRunning)) {
      if ($req) {
        Write-WatchLog ('host exited; request ' + $req.id + ' -> wait host up')
        $script:State = [ordered]@{ phase = 'waiting_up'; id = $req.id; goneAtMs = [long]$now; injectAtMs = 0; restartAtMs = 0 }
      } else {
        $script:State = [ordered]@{ phase = 'idle' }
      }
      Save-State
      $prev = $false
      continue
    }
  }

  # 3) 宿主出现 -> 排注入（含 restarting 阶段漏检退出时的兜底：pid 变了就算重启完成）
  if ((-not $prev) -and $running) {
    if ($script:State.phase -eq 'waiting_up' -and $req) {
      $w = Get-DshWindow
      if ($w) { $script:LastPid = $w.Pid }
      $delaySec = Get-InjectDelaySec $req
      $script:State.injectAtMs = [long]($now + ([long]$delaySec * 1000))
      Save-State
      Write-WatchLog ('host up pid=' + $script:LastPid + '; inject at +' + $delaySec + 's')
    }
  }
  if ($script:State.phase -eq 'restarting' -and $req -and $running) {
    $w = Get-DshWindow
    if ($w -and [long]$script:State.oldPid -gt 0 -and [long]$w.Pid -ne [long]$script:State.oldPid) {
      $script:LastPid = $w.Pid
      $delaySec = Get-InjectDelaySec $req
      $script:State = [ordered]@{ phase = 'waiting_up'; id = $req.id; goneAtMs = [long]$now; injectAtMs = [long]($now + ([long]$delaySec * 1000)); restartAtMs = 0 }
      Save-State
      Write-WatchLog ('restart: new host pid=' + $script:LastPid + ' (fallback); inject at +' + $delaySec + 's')
    }
  }

  # 4) 注入
  if ($script:State.phase -eq 'waiting_up') {
    if (-not $req) {
      Write-WatchLog 'request vanished; back to idle'
      $script:State = [ordered]@{ phase = 'idle' }; Save-State
    } elseif ([long]$script:State.injectAtMs -gt 0 -and $now -ge [long]$script:State.injectAtMs) {
      if (-not $running) {
        $script:State.injectAtMs = 0; Save-State
      } else {
        $w = Get-DshWindow
        if (-not $w) {
          $script:State.injectAtMs = [long]($now + 3000); Save-State
          Write-WatchLog 'inject: window not ready, retry in 3s'
        } else {
          Write-WatchLog ('inject: start request ' + $req.id)
          $res = Invoke-Inject $req.prompt $req.id
          Write-Json $script:ResultPath $res
          try { ($res | ConvertTo-Json -Depth 8 -Compress) | Add-Content -LiteralPath $script:ResultsPath -Encoding UTF8 } catch { }
          Write-WatchLog ('inject: ok=' + $res.ok + ' reason=' + $res.reason + ' detail=' + $res.detail)
          Archive-Request $req.id
          $script:State = [ordered]@{ phase = 'idle' }; Save-State
        }
      }
    }
    if ($script:State.phase -eq 'waiting_up' -and $req -and [long]$script:State.goneAtMs -gt 0 -and ($now - [long]$script:State.goneAtMs) -gt ([long]$ExpireMin * 60000)) {
      Write-WatchLog ('request ' + $req.id + ' expired')
      $res = [pscustomobject]@{ id = $req.id; at = (Get-Date).ToString('o'); ok = $false; reason = 'expired'; detail = 'host not up in ' + $ExpireMin + ' min'; evidence = @() }
      Write-Json $script:ResultPath $res
      Archive-Request $req.id
      $script:State = [ordered]@{ phase = 'idle' }; Save-State
    }
  }

  # 5) 空闲但请求还在（未到点）
  if (-not $req) { $armedLogged = $false }
  elseif ($script:State.phase -eq 'idle' -and -not $armedLogged) {
    Write-WatchLog ('request ' + $req.id + ' armed, restartAtMs=' + $req.restartAtMs)
    $armedLogged = $true
  }

  $prev = $running
}
