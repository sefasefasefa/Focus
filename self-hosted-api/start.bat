@echo off
cd /d "%~dp0"
if not exist .env (
  echo Run: node setup.mjs
  pause
  exit /b 1
)
node --env-file=.env server.mjs
