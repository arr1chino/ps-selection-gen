@echo off
chcp 65001 >nul
title 选区生图 - 安装到 Photoshop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-to-photoshop.ps1"
echo.
pause
