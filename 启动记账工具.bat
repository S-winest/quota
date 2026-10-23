@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Quota local server

if not exist "node_modules\vite\bin\vite.js" (
  echo.
  echo [x] node_modules not found.
  echo     Open a terminal in this folder and run:  pnpm install
  echo.
  pause
  exit /b 1
)

echo Building the app...
node "node_modules\vite\bin\vite.js" build --logLevel warn || goto :failed

echo.
echo   ================================================
echo     Quota  -  daily spendable
echo   ================================================
echo.
echo     Computer :  http://localhost:4173/
echo     Phone    :  http://YOUR-PC-IP:4173/   (same Wi-Fi)
echo.
echo     The "Network" line below is the phone URL.
echo     Keep this window open; press Ctrl+C to stop.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 1800; Start-Process 'http://localhost:4173/'"
node "node_modules\vite\bin\vite.js" preview --port 4173 --strictPort --host
goto :eof

:failed
echo.
echo Build failed. Check the messages above.
pause
