@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 24 or newer is required. Install Node.js, then run this script again.
  goto failed
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm was not found. Install Node.js 24 or newer with npm, then run this script again.
  goto failed
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if not defined NODE_MAJOR (
  echo Could not determine the installed Node.js version.
  goto failed
)
if %NODE_MAJOR% LSS 24 (
  echo Node.js 24 or newer is required. Found Node.js %NODE_MAJOR%.
  goto failed
)

if not exist "node_modules\nodemailer\package.json" (
  echo Installing API dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto failed
)

if not exist ".env" (
  echo Creating a new local .env with generated license and session secrets...
  node setup.mjs
  if errorlevel 1 goto failed
  echo Add SMTP, Shopier, and optional AI settings to .env when you need those features.
)

node --env-file=.env server.mjs
if errorlevel 1 goto failed
goto finished

:failed
echo.
echo The API could not start. Fix the message above, then run start.bat again.
pause
exit /b 1

:finished
echo.
echo The API process has stopped.
pause
