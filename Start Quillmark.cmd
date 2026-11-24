@echo off
title Quillmark
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Quillmark needs Node.js. Install Node.js 24 LTS from https://nodejs.org, then open this file again.
  pause
  exit /b 1
)
node server.mjs
if errorlevel 1 pause
