@echo off
chcp 65001 >nul
title MARIA Local Server
cd /d "%~dp0"
echo.
echo   === MARIA - LOCAL START ===
echo.
rem --- common Node install paths ---
set "PATH=%PATH%;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%LocalAppData%\Programs\nodejs;C:\node"
set "HAVENODE=0"
where node >nul 2>nul && set "HAVENODE=1"

if "%HAVENODE%"=="0" (
  echo   [!] Node.js not found. Trying automatic install with winget...
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs;%LocalAppData%\Programs\nodejs"
  where node >nul 2>nul && set "HAVENODE=1"
)

if "%HAVENODE%"=="0" (
  echo.
  echo   ------------------------------------------------------
  echo   Node.js is NOT installed on this PC.
  echo.
  echo   1^) Download this file and run it:
  echo      https://nodejs.org/dist/v26.13.0/node-v26.13.0-x64.msi
  echo   2^) Click Next, Next, Install, Finish
  echo   3^) Then run start.bat again
  echo   ------------------------------------------------------
  echo.
  pause
  exit /b 1
)

echo   [OK] Node version:
node -v
echo.

if not exist node_modules (
  echo   [...] Installing packages, first time only, about 1 minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [X] npm install failed. Check your internet connection.
    pause
    exit /b 1
  )
)

if not exist .env if exist .env.example copy .env.example .env >nul

set "MARIA_MODE=mock"
set "PAYMENT_PROVIDER=sandbox"
if "%MARIA_ADMIN_TOKEN%"=="" set "MARIA_ADMIN_TOKEN=dev-admin-token"
if "%PORT%"=="" set "PORT=4173"

echo   [OK] Starting MARIA...
echo.
echo   ==================================================
echo    Open in your browser:  http://localhost:%PORT%
echo    Dashboard:             http://localhost:%PORT%/dashboard
echo.
echo    Keep this window OPEN. Close it to stop MARIA.
echo   ==================================================
echo.
start "" http://localhost:%PORT%
node src/index.js

echo.
echo   Server stopped. Read the messages above, then press any key.
pause
