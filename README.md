# 🤖 Solana Liquidation Bot - Production Ready

Bot de liquidation automatique pour Solana. Scanne et liquide les positions undercollateralized sur **Kamino**, **Marginfi** et **Jupiter Lend** via flash loans (capital zéro requis).

## 🚀 DÉMARRAGE RAPIDE (3 clics)

### Étape 1: Installation
**Double-cliquez sur `INSTALL.bat`**
- Installe Rust automatiquement si nécessaire
- Compile le bot

### Étape 2: Test (Mode Simulation)
**Double-cliquez sur `START_BOT.bat`**
- Lance le bot en mode dry-run (simulation)
- Aucune vraie transaction exécutée
- Vérifie que tout fonctionne

### Étape 3: Production (Argent Réel)
**Double-cliquez sur `START_PRODUCTION.bat`**
- ⚠️ Exécute de vraies liquidations
- Gagne de l'argent automatiquement

---

## ⚡ Fonctionnalités

- **Multi-protocoles**: Support Kamino, Marginfi, Jupiter Lend
- **Flash Loans**: Utilisation de flash loans Kamino pour un capital zéro
- **Oracles temps réel**: Intégration Pyth/Switchboard pour les prix
- **Optimisé pour le profit**: Calcul dynamique du profit avec slippage et frais
- **Polling intelligent**: Scan périodique configurable (1-2 minutes)
- **Mode dry-run**: Simulation sans risque avant déploiement
- **Monitoring complet**: Logs détaillés et statistiques en temps réel

## 🚀 Installation

### Prérequis
- Rust 1.70+
- Solana CLI 1.18+
- Wallet Solana avec SOL pour les frais

### Build
```bash
# Cloner le projet
git clone <repository-url>
cd solana-liquidation-bot

# Compiler en mode release
cargo build --release

# Ou lancer directement
cargo run --release --help
```

## ⚙️ Configuration

### 1. Variables d'environnement
Copiez `.env.example` vers `.env` et configurez:

```bash
cp .env.example .env
```

Variables requises:
- `WALLET_PRIVATE_KEY`: Clé privée du wallet (base58)
- `HELIUS_RPC_URL` ou `HELIUS_API_KEY`: Endpoint RPC Helius

### 2. Configuration avancée
```bash
# Intervalle de polling (secondes)
POLL_INTERVAL_SECONDS=60

# Seuil de profit minimum (lamports)
MIN_PROFIT_THRESHOLD=5000  # 0.000005 SOL

# Slippage maximum (%)
MAX_SLIPPAGE_PERCENT=3

# Mode simulation
DRY_RUN=true

# Protocoles activés
ENABLED_PROTOCOLS=Kamino,Marginfi,JupiterLend

# Actifs prioritaires
PRIORITY_ASSETS=SOL,USDC,USDT,jitoSOL,bonk
```

## 🎯 Utilisation

### Démarrer le bot
```bash
# Mode normal (mainnet)
cargo run --release -- start

# Mode simulation (recommandé pour tester)
cargo run --release -- start --dry-run

# Personnalisé
cargo run --release -- start \
  --dry-run \
  --interval 30 \
  --min-profit 10000 \
  --protocols Kamino,Marginfi
```

### Scan unique
```bash
# Scan sans exécuter
cargo run --release -- scan --verbose
```

### Test de configuration
```bash
# Vérifier la configuration et la connexion
cargo run --release -- test
```

### Afficher la configuration
```bash
cargo run --release -- config
```

## 📊 Stratégie de Liquidation

### 1. Détection des positions
- Scan périodique des comptes de chaque protocole
- Calcul du health factor: `collateral_value / debt_value`
- Filtrage: `health_factor < 1.0`

### 2. Calcul de rentabilité
```
profit = (collateral_received * (1 + bonus)) * (1 - slippage) 
        - debt_value - gas_fees - flash_loan_fees
```

### 3. Exécution atomique
1. Flash loan emprunt du montant requis
2. Remboursement de la dette de la victime
3. Réclamation du collateral avec bonus
4. Swap via Jupiter aggregator
5. Remboursement du flash loan + frais
6. Profit = solde restant

## 🔧 Architecture

```
src/
├── main.rs          # CLI et boucle principale
├── config.rs        # Gestion configuration
├── scanner.rs       # Détection positions liquidables
├── liquidator.rs    # Exécution liquidations
└── utils.rs         # Prix, calculs, utilitaires
```

### Flux de données
```
Polling → Scanner → Analyse → Liquidator → Flash Loan → Liquidation → Swap → Profit
```

## 🛡️ Sécurité

### Mesures intégrées
- **Validation des oracles**: Âge maximum des prix (5 minutes)
- **Simulation systématique**: Toutes les tx sont simulées avant envoi
- **Checks de liquidité**: Vérification des pools avant gros emprunts
- **Retry avec backoff**: Gestion des erreurs réseau
- **Mode dry-run**: Tests sans risque

### Bonnes pratiques
- Commencer en mode `dry-run=true`
- Tester sur testnet d'abord
- Surveiller les frais de gas
- Diversifier les protocoles

## 📈 Monitoring

### Logs en temps réel
```bash
# Niveau de détail
RUST_LOG=debug cargo run --release

# Logs structurés
RUST_LOG=info cargo run --release 2>&1 | tee bot.log
```

### Métriques importantes
- Nombre de scans effectués
- Liquidations réussies/échouées
- Profit total accumulé
- Health factor moyen des cibles

## 🚨 Alertes

Le bot génère des alertes pour:
- Liquidations > 0.1 SOL
- Erreurs RPC/network
- Solde wallet faible
- Prix oracles stale

## 🔄 Déploiement 24/7

### Systemd (Linux)
```bash
# Créer le service
sudo nano /etc/systemd/system/liquidation-bot.service

[Unit]
Description=Solana Liquidation Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/solana-liquidation-bot
ExecStart=/home/ubuntu/solana-liquidation-bot/target/release/liquidation-bot start
Restart=always
RestartSec=10
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target

# Activer
sudo systemctl enable liquidation-bot
sudo systemctl start liquidation-bot
```

### PM2
```bash
# Installer PM2
npm install -g pm2

# Démarrer
pm2 start target/release/liquidation-bot --name "liquidation-bot" -- start

# Monitor
pm2 monit

# Logs
pm2 logs liquidation-bot
```

## 🐛 Dépannage

### Erreurs communes
1. **"WALLET_PRIVATE_KEY requis"**
   - Vérifiez votre fichier `.env`
   - Assurez-vous que la clé est en base58

2. **"Erreur RPC"**
   - Vérifiez votre API key Helius
   - Essayez avec le RPC public mainnet

3. **"Solde insuffisant"**
   - Minimum 1 SOL recommandé pour les frais
   - Le bot utilise des flash loans (pas de capital requis)

4. **"Aucune position trouvée"**
   - Normal en périodes de faible volatilité
   - Vérifiez que les protocoles sont activés

### Debug avancé
```bash
# Mode debug complet
RUST_LOG=debug cargo run --release -- start --dry-run

# Vérifier la configuration
cargo run --release -- test

# Scan verbose
cargo run --release -- scan --verbose
```

## ⚠️ Avertissements

**RISQUES IMPORTANTS:**
- **TESTNET OBLIGATOIRE**: Testez exhaustivement avant mainnet
- **VOLATILITÉ**: Les conditions de marché peuvent changer rapidement
- **COMPÉTITION**: D'autres bots peuvent exécuter les liquidations
- **FRAIS**: Les frais de gas peuvent impacter la rentabilité

**RECOMMANDATIONS:**
- Commencez avec des seuils de profit élevés
- Surveillez attentivement les premiers jours
- Ayez un fonds d'urgence pour les frais
- Diversifiez les protocoles actifs

## 📝 License

MIT License - Voir le fichier LICENSE pour les détails.

## 🤝 Contributions

Contributions bienvenues! Veuillez:
1. Fork le projet
2. Créer une branche feature
3. Submit un PR avec description claire

## 📞 Support

Pour questions et support:
- Issues GitHub pour les bugs
- Discord pour les discussions
- Documentation détaillée dans le code

---

**⚠️ AVERTISSEMENT**: Ce bot est destiné aux utilisateurs expérimentés. Utilisez à vos propres risques. Testez toujours en mode dry-run avant le déploiement en production.
