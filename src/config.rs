//! Configuration du bot de liquidation Solana
//! Gère le chargement depuis .env et la validation des paramètres

use std::env;
use std::str::FromStr;
use anyhow::{Result, anyhow};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use serde::{Deserialize, Serialize};

/// Configuration principale du bot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotConfig {
    pub rpc_url: String,
    pub helius_api_key: Option<String>,
    pub poll_interval_seconds: u64,
    pub min_profit_threshold: u64,
    pub max_slippage_percent: u8,
    pub dry_run: bool,
    pub batch_size: usize,
    pub rpc_timeout_ms: u64,
    #[serde(skip_serializing)]
    pub wallet_private_key: String,
    pub enabled_protocols: Vec<Protocol>,
    pub priority_assets: Vec<String>,
    pub max_oracle_age_seconds: u64,
    pub max_retries: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum Protocol {
    Kamino,
    Marginfi,
    JupiterLend,
}

impl std::fmt::Display for Protocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Protocol::Kamino => write!(f, "Kamino"),
            Protocol::Marginfi => write!(f, "Marginfi"),
            Protocol::JupiterLend => write!(f, "Jupiter Lend"),
        }
    }
}

impl FromStr for Protocol {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().trim() {
            "kamino" => Ok(Protocol::Kamino),
            "marginfi" => Ok(Protocol::Marginfi),
            "jupiter-lend" | "jupiterlend" | "jupiter" => Ok(Protocol::JupiterLend),
            _ => Err(anyhow!("Protocol non supporté: {}", s)),
        }
    }
}

/// Adresses des programmes Solana mainnet (VRAIS PROGRAM IDs)
pub struct ProgramIds;

impl ProgramIds {
    // Kamino Lending Program (klend) - MAINNET OFFICIEL
    pub fn kamino_lending() -> Pubkey {
        Pubkey::from_str("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD").unwrap()
    }
    
    // Marginfi V2 Program - MAINNET OFFICIEL
    pub fn marginfi() -> Pubkey {
        Pubkey::from_str("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVFxA").unwrap()
    }
    
    // Marginfi Group (main lending group)
    #[allow(dead_code)]
    pub fn marginfi_group() -> Pubkey {
        Pubkey::from_str("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8").unwrap()
    }
    
    // Jupiter Aggregator V6 - MAINNET OFFICIEL
    #[allow(dead_code)]
    pub fn jupiter_v6() -> Pubkey {
        Pubkey::from_str("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4").unwrap()
    }
    
    // Token Program
    #[allow(dead_code)]
    pub fn token_program() -> Pubkey {
        Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
    }
    
    // Associated Token Program
    #[allow(dead_code)]
    pub fn associated_token_program() -> Pubkey {
        Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap()
    }
    
    // System Program
    #[allow(dead_code)]
    pub fn system_program() -> Pubkey {
        Pubkey::from_str("11111111111111111111111111111111").unwrap()
    }
    
    // Common token mints
    pub fn sol_mint() -> Pubkey {
        Pubkey::from_str("So11111111111111111111111111111111111111112").unwrap()
    }
    
    pub fn usdc_mint() -> Pubkey {
        Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap()
    }
}

impl Default for BotConfig {
    fn default() -> Self {
        Self {
            rpc_url: "https://api.mainnet-beta.solana.com".to_string(),
            helius_api_key: None,
            poll_interval_seconds: 60,
            min_profit_threshold: 5000,
            max_slippage_percent: 3,
            dry_run: true, // SÉCURITÉ: toujours true par défaut
            batch_size: 1000,
            rpc_timeout_ms: 30000,
            wallet_private_key: String::new(),
            enabled_protocols: vec![Protocol::Kamino, Protocol::Marginfi, Protocol::JupiterLend],
            priority_assets: vec![
                "SOL".to_string(),
                "USDC".to_string(),
                "USDT".to_string(),
                "jitoSOL".to_string(),
            ],
            max_oracle_age_seconds: 300,
            max_retries: 3,
        }
    }
}

impl BotConfig {
    pub fn load() -> Result<Self> {
        dotenvy::dotenv().ok();
        let mut config = Self::default();

        // RPC URL - Helius prioritaire
        if let Ok(api_key) = env::var("HELIUS_API_KEY") {
            config.rpc_url = format!("https://mainnet.helius-rpc.com/?api-key={}", api_key);
            config.helius_api_key = Some(api_key);
        } else if let Ok(rpc_url) = env::var("HELIUS_RPC_URL") {
            config.rpc_url = rpc_url;
        }

        // Wallet - OBLIGATOIRE
        config.wallet_private_key = env::var("WALLET_PRIVATE_KEY")
            .map_err(|_| anyhow!("WALLET_PRIVATE_KEY requis dans .env"))?;

        // Paramètres optionnels
        if let Ok(v) = env::var("POLL_INTERVAL_SECONDS") {
            config.poll_interval_seconds = v.parse().unwrap_or(60);
        }
        if let Ok(v) = env::var("MIN_PROFIT_THRESHOLD") {
            config.min_profit_threshold = v.parse().unwrap_or(5000);
        }
        if let Ok(v) = env::var("MAX_SLIPPAGE_PERCENT") {
            config.max_slippage_percent = v.parse().unwrap_or(3);
        }
        if let Ok(v) = env::var("DRY_RUN") {
            config.dry_run = v.parse().unwrap_or(true);
        }
        if let Ok(v) = env::var("BATCH_SIZE") {
            config.batch_size = v.parse().unwrap_or(1000);
        }
        if let Ok(protocols) = env::var("ENABLED_PROTOCOLS") {
            config.enabled_protocols = protocols
                .split(',')
                .filter_map(|p| p.trim().parse().ok())
                .collect();
        }

        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if self.wallet_private_key.is_empty() {
            return Err(anyhow!("Wallet private key requis"));
        }
        if self.poll_interval_seconds < 1 {
            return Err(anyhow!("Poll interval minimum: 1 seconde"));
        }
        if self.max_slippage_percent > 10 {
            return Err(anyhow!("Slippage maximum: 10%"));
        }
        self.get_keypair()?;
        Ok(())
    }

    pub fn get_keypair(&self) -> Result<Keypair> {
        let decoded = bs58::decode(&self.wallet_private_key)
            .into_vec()
            .map_err(|e| anyhow!("Clé privée base58 invalide: {}", e))?;

        Keypair::from_bytes(&decoded)
            .map_err(|e| anyhow!("Keypair invalide: {}", e))
    }

    pub fn get_rpc_url(&self) -> &str {
        &self.rpc_url
    }

    pub fn display_safe(&self) {
        log::info!("══════════════════════════════════════");
        log::info!("   CONFIGURATION BOT LIQUIDATION");
        log::info!("══════════════════════════════════════");
        log::info!("RPC: {}", if self.helius_api_key.is_some() { "Helius (API Key)" } else { &self.rpc_url });
        log::info!("Poll: {} secondes", self.poll_interval_seconds);
        log::info!("Profit min: {} lamports ({:.6} SOL)", self.min_profit_threshold, self.min_profit_threshold as f64 / 1e9);
        log::info!("Slippage max: {}%", self.max_slippage_percent);
        log::info!("Mode: {}", if self.dry_run { "🔒 DRY-RUN (simulation)" } else { "🚀 PRODUCTION" });
        log::info!("Protocoles: {:?}", self.enabled_protocols);
        if let Ok(kp) = self.get_keypair() {
            log::info!("Wallet: {}", kp.pubkey());
        }
        log::info!("══════════════════════════════════════");
    }
}
