@echo off
setlocal
set "EXT_DIR=%~dp0"

echo.
echo Base44 Code Downloader - install
echo ================================
echo.
echo 1. In Chrome, turn on "Developer mode" (top right of chrome://extensions).
echo 2. Click "Load unpacked".
echo 3. Select this folder:
echo.
echo    %EXT_DIR%
echo.
echo Chrome's extensions page will open next.
echo.
pause

start "" chrome "chrome://extensions"

echo.
echo After Chrome opens, choose this folder:
echo %EXT_DIR%
echo.
pause
