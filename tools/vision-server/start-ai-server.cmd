@echo off
rem Makes this PC the SmartSort AI server. Keep this window open;
rem close it to take the AI server offline (the website then falls back).
title SmartSort AI server
cd /d "%~dp0..\.."
node tools\vision-server\start.mjs
echo.
echo The SmartSort AI server has stopped.
timeout /t 15
