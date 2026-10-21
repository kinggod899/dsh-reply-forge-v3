@echo off
chcp 936 >nul
cd /d "%~dp0"
echo ============================================
echo   dsh-reply-forge-v3 关闭
echo ============================================
echo.
echo 停用插件（把它从 bundles 列表摘掉）。
echo 链接和依赖会保留，所以再次启用不需要重新安装。
echo 不会执行 pnpm，也不会删除你的覆盖数据。
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
  echo [错误] 未找到 node.exe，无法自动执行。请手动完成以下两步：
  echo   1. 编辑 %PROFILE_DIR%\package.json
  echo      从 dsh.profile.bundles 里删除 "dsh-reply-forge-v3"
  echo   2. 编辑 %PROFILE_DIR%\cordis.patch.yml
  echo      删除 id: dsh-reply-forge-v3 的整条条目（若有）
  echo.
  pause
  exit /b 1
)

cmd /d /s /c "chcp 65001 >nul & "%NODE%" "%~dp0scripts\disable.mjs" & chcp 936 >nul"
echo.
echo 完成后请重启 DSH 桌面端。
pause
