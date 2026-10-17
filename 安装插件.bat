@echo off
chcp 936 >nul
cd /d "%~dp0"
echo ============================================
echo   dsh-reply-forge-v3 安装
echo ============================================
echo.
echo 本脚本只改 dsh 启动时读取的静态配置，并建立 node_modules 链接。
echo 它不会执行 pnpm install（跑 pnpm 会清空 node_modules）。
echo.
echo [提示] 请先完全退出 DSH 桌面端；改动要重启 DSH 才生效。
echo.
pause >nul
echo.

rem ---- 路径配置：一般不需要改 ----
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.dsh"
set "PROFILE_DIR=%DSH_HOME%\profiles\desktop"
rem --------------------------------

set "NODE="
where node >nul 2>&1 && set "NODE=node"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE (
  echo [错误] 未找到 node.exe，无法自动执行。请手动完成以下四步：
  echo   1. 编辑 %PROFILE_DIR%\package.json
  echo      dependencies 加入  "@local/dsh-reply-forge-v3": "link:<本仓库绝对路径>"
  echo      dsh.profile.bundles 末尾加入  "@local/dsh-reply-forge-v3"
  echo   2. 编辑 %PROFILE_DIR%\cordis.patch.yml，删除 id: dsh-reply-forge / dsh-reply-forge-v2 的整条条目
  echo   3. 若 bundles 里还有 "@local/dsh-reply-forge" 或 "@local/dsh-reply-forge-v2"，
  echo      把它们删掉（三代共用同一条操作条，同时开会挂多条）
  echo   4. 建立链接：
  echo      mklink /J "%PROFILE_DIR%\node_modules\@local\dsh-reply-forge-v3" "%~dp0."
  echo.
  pause
  exit /b 1
)

cmd /d /s /c "chcp 65001 >nul & "%NODE%" "%~dp0scripts\install.mjs" & chcp 936 >nul"
echo.
echo 完成后请重启 DSH 桌面端。
pause
