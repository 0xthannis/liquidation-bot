@echo off
chcp 65001 >nul
title 🤖 Solana Liquidation Bot

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║                                                               ║
echo ║   🤖 SOLANA LIQUIDATION BOT - DÉMARRAGE AUTOMATIQUE          ║
echo ║                                                               ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Vérifier si Rust est installé
where cargo >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ ERREUR: Rust n'est pas installé!
    echo.
    echo 👉 Installez Rust depuis: https://rustup.rs/
    echo.
    pause
    exit /b 1
)

echo ✅ Rust détecté
echo.

:: Se placer dans le bon dossier
cd /d "%~dp0"

:: Vérifier si le projet est déjà compilé
if exist "target\release\liquidation-bot.exe" (
    echo ✅ Bot déjà compilé
    echo.
    goto :run
)

:: Compiler le projet
echo 🔨 Compilation du bot (première fois - peut prendre 2-3 minutes)...
echo.
cargo build --release

if %errorlevel% neq 0 (
    echo.
    echo ❌ ERREUR de compilation! Vérifiez les messages ci-dessus.
    echo.
    pause
    exit /b 1
)

echo.
echo ✅ Compilation réussie!
echo.

:run
echo ══════════════════════════════════════════════════════════════
echo.
echo 🚀 DÉMARRAGE DU BOT EN MODE DRY-RUN (SIMULATION)
echo.
echo    Le bot va scanner les positions mais NE PAS exécuter
echo    de vraies transactions. C'est le mode sécurisé.
echo.
echo    Pour passer en mode PRODUCTION (vraies transactions):
echo    1. Éditez le fichier .env
echo    2. Changez DRY_RUN=true en DRY_RUN=false
echo.
echo ══════════════════════════════════════════════════════════════
echo.
echo Appuyez sur une touche pour démarrer...
pause >nul

:: Lancer le bot
target\release\liquidation-bot.exe start --dry-run

:: Si le bot s'arrête
echo.
echo ⚠️  Le bot s'est arrêté.
echo.
pause
