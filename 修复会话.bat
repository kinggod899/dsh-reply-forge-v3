@echo off
chcp 936 >nul
cd /d "%~dp0"
echo ============================================
echo   dsh-reply-forge-v3 受损会话修复工具
echo ============================================
echo.
echo   本工具修的是：v3.0 曾经写出的、缺少 ignorable 标记的
echo   reply-forge/patch 事件。那种事件会让宿主拒读整条会话
echo   日志（会话打不开）。修复 = 给这些事件补上标记。
echo.
echo   安全约定：
echo      1. 不带参数运行 = 只诊断，绝不改任何文件；
echo      2. 修复前必须完全退出 DSH；
echo      3. 每个文件先备份（.bak-repair-*，永不删除）；
echo      4. 修复后经宿主闸门复验，不过自动还原。
echo.

rem ---- 找 node（与其它 bat 同一套查找链；绝不跑 pnpm）----
set "NODE="
where node >nul 2>&1 && set "NODE=node"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE (
  echo [错误] 未找到 node.exe，请先安装 Node.js 或把它加进 PATH。
  echo.
  pause
  exit /b 1
)

if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.dsh"

if /i "%~1"=="apply" (
  echo [模式] 修复模式：会修改会话文件（先备份、复验、失败自动还原）
  echo [警告] 请确认 DSH 已完全退出，否则不要继续。
  echo        扫描后会要求输入 yes 确认，之后才会真正写入。
  echo.
  cmd /d /s /c "chcp 65001 >nul & "%NODE%" "%~dp0scripts\repair-sessions.mjs" --apply --all & chcp 936 >nul"
) else (
  echo [模式] 诊断模式：只读扫描，不修改任何文件。
  echo.
  cmd /d /s /c "chcp 65001 >nul & "%NODE%" "%~dp0scripts\repair-sessions.mjs" & chcp 936 >nul"
)

echo.
echo --------------------------------------------
echo 提示：显示没有受损会话 = 无需处理。
echo 需要修复：先完全退出 DSH，然后运行  修复会话.bat apply
echo 修复完请重启 DSH 验证：受影响会话应能正常打开。
echo --------------------------------------------
pause
