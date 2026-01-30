@echo off
title Solana Liquidation Bot - PRODUCTION

echo.
echo ===============================================================
echo.
echo "/!\ SOLANA LIQUIDATION BOT - MODE PRODUCTION"
echo.
echo "ATTENTION: CE MODE EXECUTE DE VRAIES TRANSACTIONS!"
echo.
echo ===============================================================
echo.

:: Vérifier si Rust est installé
where cargo >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERREUR] Rust n'est pas installe!
    echo.
    echo [INFO] Installez Rust depuis: https://rustup.rs/
    echo.
    pause
    exit /b 1
)

cd /d "%~dp0"

:: Compiler si nécessaire
if not exist "target\release\liquidation-bot.exe" (
    echo [COMPILATION] Compilation du bot...
    cargo build --release
    if %errorlevel% neq 0 (
        echo [ERREUR] Erreur de compilation!
        pause
        exit /b 1
    )
)

echo.
echo ===============================================================
echo.
echo [WARNING] AVERTISSEMENT MODE PRODUCTION
echo.
echo    Ce mode va executer de VRAIES transactions sur le mainnet!
echo    Assurez-vous d'avoir:
echo.
echo    [OK] Teste en mode dry-run (START_BOT.bat)
echo    [OK] Suffisamment de SOL pour les frais (0.01+ SOL)
echo    [OK] Verifie votre configuration (.env)
echo.
echo ===============================================================
echo.
echo Tapez "CONFIRMER" pour demarrer en mode production:
set /p confirm=

if /i not "%confirm%"=="CONFIRMER" (
    echo.
    echo [CANCEL] Annule. Utilisez START_BOT.bat pour le mode simulation.
    pause
    exit /b 0
)

echo.
echo [START] Démarrage en mode PRODUCTION...
echo.

:: Lancer le bot en mode production
target\release\liquidation-bot.exe start

echo.
echo [STOP] Le bot s'est arrêté.
pause
