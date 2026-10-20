@echo off
rem restart-sample.cmd — 重启 DSH 桌面的示例脚本（看守到点会调用它）
rem
rem 用法：复制成 <StateDir>\restart.cmd，按自己的安装路径改 DSH_EXE；
rem       或提前设置环境变量 DSH_EXE 指向 "DeepSeek Harness.exe"。
setlocal
if "%DSH_EXE%"=="" set "DSH_EXE=C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe"

rem 1) 结束宿主（DSH 桌面版自己也是 taskkill 硬杀，不会走插件 dispose）
taskkill /F /IM "DeepSeek Harness.exe" >nul 2>&1
rem 2) 等进程真的退出，最多 10 秒
for /l %%i in (1,1,10) do (
  tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /I "DeepSeek Harness.exe" >nul
  if errorlevel 1 goto start
  timeout /t 1 /nobreak >nul
)
:start
rem 3) 启动
start "" "%DSH_EXE%"
