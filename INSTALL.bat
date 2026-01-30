@echo off
chcp 65001 >nul
title 🔧 Installation Solana Liquidation Bot

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║                                                               ║
echo ║   🔧 INSTALLATION DU BOT DE LIQUIDATION SOLANA               ║
echo ║                                                               ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Vérifier si Rust est installé
where cargo >nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ Rust est déjà installé!
    cargo --version
    echo.
    goto :compile
)

echo ❌ Rust n'est pas installé.
echo.
echo 👉 Installation automatique de Rust...
echo.

:: Télécharger et exécuter rustup
echo Téléchargement de Rustup...
powershell -Command "& {Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile '%TEMP%\rustup-init.exe'}"

if not exist "%TEMP%\rustup-init.exe" (
    echo ❌ Échec du téléchargement de Rustup
    echo.
    echo 👉 Installez manuellement depuis: https://rustup.rs/
    echo.
    pause
    exit /b 1
)

echo.
echo Lancement de l'installation Rust...
echo.
echo ⚠️  SUIVEZ LES INSTRUCTIONS DANS LA NOUVELLE FENÊTRE
echo    Appuyez sur ENTRÉE pour accepter les options par défaut
echo.
"%TEMP%\rustup-init.exe" -y

if %errorlevel% neq 0 (
    echo.
    echo ❌ Échec de l'installation de Rust
    pause
    exit /b 1
)

echo.
echo ✅ Rust installé avec succès!
echo.
echo ⚠️  IMPORTANT: Fermez cette fenêtre et relancez INSTALL.bat
echo.
pause
exit /b 0

:compile
echo ══════════════════════════════════════════════════════════════
echo.
echo 🔨 Compilation du bot (2-5 minutes la première fois)...
echo.

cd /d "%~dp0"
cargo build --release

if %errorlevel% neq 0 (
    echo.
    echo ❌ Erreur de compilation!
    echo.
    pause
    exit /b 1
)

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║                                                               ║
echo ║   ✅ INSTALLATION TERMINÉE!                                  ║
echo ║                                                               ║
echo ║   Pour démarrer le bot:                                      ║
echo ║   • Double-cliquez sur START_BOT.bat (mode simulation)       ║
echo ║   • Ou START_PRODUCTION.bat (mode réel)                      ║
echo ║                                                               ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.
pause
