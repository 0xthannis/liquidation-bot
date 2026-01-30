@echo off
chcp 65001 >nul
title Solana Liquidation Bot

echo ===============================================================
echo   SOLANA LIQUIDATION BOT - DEMARRAGE AUTOMATIQUE
echo ===============================================================
echo.

cd /d "%~dp0"

REM Lancer le script PowerShell principal
powershell -ExecutionPolicy Bypass -File "%~dp0SETUP_AND_RUN.ps1"

echo.
pause
