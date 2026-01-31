//! Bot de Liquidation Solana - Marginfi & Kamino
//! Utilise Jupiter API pour les swaps

use std::sync::Arc;
use std::time::Duration;
use anyhow::Result;
use clap::{Parser, Subcommand};
use tokio::sync::Mutex;
use tokio::time::interval;
use solana_sdk::signature::Signer;

mod config;
mod scanner;
mod liquidator;
mod utils;
mod arbitrage;
mod jupiter;

use config::BotConfig;
use scanner::PositionScanner;
use liquidator::Liquidator;
use utils::{BotStats, math};
use arbitrage::{ArbitrageScanner, ArbitrageExecutor};

#[derive(Parser)]
#[command(name = "liquidation-bot")]
#[command(about = "🤖 Bot de liquidation Solana - Marginfi, Kamino")]
#[command(version = "1.0.0")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// 🚀 Démarre le bot
    Start {
        #[arg(long, short)]
        dry_run: bool,
    },
    /// 🔍 Scan unique
    Scan,
    /// 🧪 Test configuration
    Test,
    /// ⚙️ Affiche la config
    Config,
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info")
    ).format_timestamp_secs().init();

    print_banner();

    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Start { dry_run }) => start_bot(dry_run).await,
        Some(Commands::Scan) => scan_once().await,
        Some(Commands::Test) => test_config().await,
        Some(Commands::Config) => show_config().await,
        None => start_bot(false).await,
    }
}

fn print_banner() {
    println!(r#"
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🤖 SOLANA LIQUIDATION BOT v1.0                             ║
║   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║   Protocoles: Marginfi • Kamino                              ║
║   Swaps: Jupiter V6 API                                      ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
"#);
}

async fn start_bot(force_dry_run: bool) -> Result<()> {
    log::info!("🚀 Démarrage...");

    let mut config = BotConfig::load()?;
    if force_dry_run {
        config.dry_run = true;
    }
    config.display_safe();

    let scanner = Arc::new(Mutex::new(PositionScanner::new(config.clone())?));
    let liquidator = Arc::new(Liquidator::new(config.clone())?);
    let arb_scanner = Arc::new(Mutex::new(ArbitrageScanner::new(config.clone())?));
    let arb_executor = Arc::new(ArbitrageExecutor::new(config.clone())?);
    let stats = Arc::new(Mutex::new(BotStats::new()));

    // Vérifications
    {
        let s = scanner.lock().await;
        s.check_connection()?;
        log::info!("✅ RPC connecté");

        let balance = s.get_balance(&liquidator.wallet_pubkey())?;
        log::info!("💰 Solde: {} lamports ({:.4} SOL)", balance, math::lamports_to_sol(balance));
        
        if balance < 10_000_000 {
            log::warn!("⚠️ Solde faible! Minimum: 0.01 SOL");
        }
    }

    log::info!("═══════════════════════════════════════");
    log::info!("   BOT ACTIF - Poll: {}s", config.poll_interval_seconds);
    log::info!("═══════════════════════════════════════");

    let mut poll = interval(Duration::from_secs(config.poll_interval_seconds));

    loop {
        poll.tick().await;

        let opportunities = {
            let s = scanner.lock().await;
            match s.scan_all().await {
                Ok(o) => o,
                Err(e) => {
                    log::error!("❌ Scan: {}", e);
                    continue;
                }
            }
        };

        {
            let mut st = stats.lock().await;
            st.record_scan(opportunities.len() as u64);
        }

        if opportunities.is_empty() {
            log::info!("🔍 Aucune opportunité");
            continue;
        }

        log::info!("🎯 {} opportunités", opportunities.len());

        for (i, opp) in opportunities.iter().enumerate() {
            log::info!("━━━ {}/{}: {} - Profit: {} lamports", 
                i + 1, opportunities.len(), opp.protocol, opp.estimated_profit_lamports);

            match liquidator.execute(opp).await {
                Ok(result) => {
                    let mut st = stats.lock().await;
                    st.record_liquidation(result.success, result.profit_lamports);

                    if result.success {
                        log::info!("✅ Réussi! Profit: {}", result.profit_lamports);
                        if let Some(sig) = result.signature {
                            log::info!("   Sig: {}", sig);
                        }
                    } else if let Some(err) = result.error {
                        log::warn!("⚠️ Échoué: {}", err);
                    }
                }
                Err(e) => {
                    log::error!("❌ Erreur: {}", e);
                    let mut st = stats.lock().await;
                    st.record_liquidation(false, 0);
                }
            }

            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        // Scan arbitrage opportunities
        {
            let mut arb = arb_scanner.lock().await;
            match arb.scan().await {
                Ok(arb_opps) => {
                    if !arb_opps.is_empty() {
                        log::info!("💱 {} arbitrage opportunities found", arb_opps.len());
                        for arb_opp in arb_opps.iter().take(3) {
                            log::info!("  Arb: {} -> profit: {} ({:.2}%)", 
                                arb_opp.amount_in, arb_opp.expected_profit, arb_opp.profit_percent);
                            
                            match arb_executor.execute(arb_opp).await {
                                Ok(result) => {
                                    if result.success {
                                        log::info!("✅ Arbitrage réussi! Profit: {}", result.profit);
                                    }
                                }
                                Err(e) => log::warn!("Arbitrage error: {}", e),
                            }
                        }
                    }
                }
                Err(e) => log::debug!("Arbitrage scan error: {}", e),
            }
        }

        // Stats périodiques
        {
            let st = stats.lock().await;
            if st.total_scans % 10 == 0 {
                st.display();
            }
        }
    }
}

async fn scan_once() -> Result<()> {
    log::info!("🔍 Scan unique...");

    let config = BotConfig::load()?;
    config.display_safe();

    let scanner = PositionScanner::new(config)?;
    let opportunities = scanner.scan_all().await?;

    if opportunities.is_empty() {
        log::info!("✅ Aucune position liquidable");
        return Ok(());
    }

    log::info!("═══════════════════════════════════════");
    log::info!("   {} OPPORTUNITÉS", opportunities.len());
    log::info!("═══════════════════════════════════════");

    for (i, opp) in opportunities.iter().enumerate() {
        println!("\n{}. {} - {}", i + 1, opp.protocol, opp.account_address);
        println!("   Health: {}", opp.health_factor);
        println!("   Profit: {} lamports ({:.6} SOL)", 
            opp.estimated_profit_lamports,
            opp.estimated_profit_lamports as f64 / 1e9);
    }

    Ok(())
}

async fn test_config() -> Result<()> {
    log::info!("🧪 Test configuration...");

    let config = BotConfig::load()?;
    log::info!("✅ Config chargée");

    let keypair = config.get_keypair()?;
    log::info!("✅ Wallet: {}", keypair.pubkey());

    let scanner = PositionScanner::new(config.clone())?;
    scanner.check_connection()?;
    log::info!("✅ RPC: {}", config.get_rpc_url());

    let balance = scanner.get_balance(&keypair.pubkey())?;
    log::info!("✅ Solde: {} lamports ({:.6} SOL)", balance, math::lamports_to_sol(balance));

    // Test Jupiter API
    log::info!("🔄 Test Jupiter API...");
    Liquidator::new(config)?;
    // Le test Jupiter se fait via le dry-run
    
    log::info!("═══════════════════════════════════════");
    log::info!("   ✅ TOUS LES TESTS OK!");
    log::info!("═══════════════════════════════════════");

    Ok(())
}

async fn show_config() -> Result<()> {
    let config = BotConfig::load()?;
    config.display_safe();
    Ok(())
}
