# ==============================================================
#  SOLANA LIQUIDATION BOT - INSTALLATION AUTOMATIQUE
#  Double-cliquez sur ce fichier pour tout installer et lancer
# ==============================================================

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "Solana Liquidation Bot - Setup"

Write-Host "===============================================================" -ForegroundColor Cyan
Write-Host "  SOLANA LIQUIDATION BOT - INSTALLATION AUTOMATIQUE" -ForegroundColor Cyan
Write-Host "===============================================================" -ForegroundColor Cyan
Write-Host ""

$projectPath = $PSScriptRoot

# --------------------------------------------------------------
# ETAPE 1 - Vérifier / installer Rust
# --------------------------------------------------------------
Write-Host "[1/4] Vérification de Rust..." -ForegroundColor Yellow

$rustInstalled = $false
try {
    $rustVersion = & cargo --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   Rust déjà installé: $rustVersion" -ForegroundColor Green
        $rustInstalled = $true
    }
} catch {
    $rustInstalled = $false
}

if (-not $rustInstalled) {
    Write-Host "   Installation de Rust..." -ForegroundColor Yellow
    $rustupUrl = "https://win.rustup.rs/x86_64"
    $rustupPath = Join-Path $env:TEMP "rustup-init.exe"

    try {
        Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupPath -UseBasicParsing
        Start-Process -FilePath $rustupPath -ArgumentList "-y" -Wait -NoNewWindow

        # Actualiser le PATH dans cette session
        $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = "$machinePath;$userPath"
        $env:Path += ";$env:USERPROFILE\.cargo\bin"

        Write-Host "   Rust installé avec succès" -ForegroundColor Green
    } catch {
        Write-Host "   ERREUR: Impossible d'installer Rust" -ForegroundColor Red
        Write-Host "   Installez-le manuellement depuis https://rustup.rs" -ForegroundColor Yellow
        Read-Host "Appuyez sur Entrée pour quitter"
        exit 1
    }
}

# --------------------------------------------------------------
# ETAPE 2 - Compilation
# --------------------------------------------------------------
Write-Host ""
Write-Host "[2/4] Compilation du projet (cela peut durer quelques minutes)..." -ForegroundColor Yellow

Set-Location $projectPath
$exePath = Join-Path $projectPath "target\release\liquidation-bot.exe"

if (Test-Path $exePath) {
    Write-Host "   Binaire déjà compilé" -ForegroundColor Green
} else {
    try {
        if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
            $env:Path += ";$env:USERPROFILE\.cargo\bin"
        }

        Write-Host "   Compilation en cours..." -ForegroundColor Yellow
        $build = Start-Process -FilePath "cargo" -ArgumentList "build", "--release" -Wait -PassThru -NoNewWindow
        if ($build.ExitCode -ne 0) {
            throw "Compilation échouée"
        }

        Write-Host "   Compilation réussie" -ForegroundColor Green
    } catch {
        Write-Host "   ERREUR: $_" -ForegroundColor Red
        Read-Host "Appuyez sur Entrée pour quitter"
        exit 1
    }
}

# --------------------------------------------------------------
# ETAPE 3 - Vérification configuration
# --------------------------------------------------------------
Write-Host ""
Write-Host "[3/4] Vérification de la configuration (.env)..." -ForegroundColor Yellow

$envFile = Join-Path $projectPath ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "   ERREUR: fichier .env absent" -ForegroundColor Red
    Write-Host "   Copiez .env.example vers .env puis remplissez vos clés" -ForegroundColor Yellow
    Read-Host "Appuyez sur Entrée pour quitter"
    exit 1
}

$envContent = Get-Content $envFile -Raw
if ($envContent -notmatch "WALLET_PRIVATE_KEY=\S+") {
    Write-Host "   ERREUR: WALLET_PRIVATE_KEY non défini dans .env" -ForegroundColor Red
    Read-Host "Appuyez sur Entrée pour quitter"
    exit 1
}

Write-Host "   Configuration OK" -ForegroundColor Green

# --------------------------------------------------------------
# ETAPE 4 - Lancement
# --------------------------------------------------------------
Write-Host ""
Write-Host "[4/4] Lancement du bot en mode dry-run" -ForegroundColor Yellow
Write-Host "   (passez DRY_RUN=false dans .env pour le mode production)" -ForegroundColor Yellow
Write-Host ""

& $exePath start --dry-run

Write-Host ""
Write-Host "Bot terminé." -ForegroundColor Yellow
Read-Host "Appuyez sur Entrée pour fermer"
