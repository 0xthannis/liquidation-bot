//! Utilitaires: structures, calculs, helpers
//! Basé sur les vraies structures de données des protocoles

use anyhow::{Result, anyhow};
use solana_sdk::pubkey::Pubkey;
use rust_decimal::Decimal;
use chrono::{DateTime, Utc};
use borsh::{BorshDeserialize, BorshSerialize};

/// Représente une opportunité de liquidation détectée
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct LiquidationOpportunity {
    pub protocol: String,
    pub account_address: Pubkey,
    pub owner: Pubkey,
    pub asset_bank: Pubkey,
    pub liab_bank: Pubkey,
    pub asset_mint: Pubkey,
    pub liab_mint: Pubkey,
    pub health_factor: Decimal,
    pub asset_amount: u64,
    pub liab_amount: u64,
    pub max_liquidatable: u64,
    pub liquidation_bonus_bps: u16,
    pub estimated_profit_lamports: i64,
    pub timestamp: DateTime<Utc>,
}

/// Structure de compte Marginfi (simplifiée basée sur la doc)
/// Source: https://github.com/mrgnlabs/marginfi-v2
#[derive(Debug, Clone, BorshDeserialize, BorshSerialize)]
pub struct MarginfiAccountHeader {
    pub discriminator: [u8; 8],
    pub group: Pubkey,
    pub authority: Pubkey,
    pub lending_account: LendingAccount,
}

#[derive(Debug, Clone, BorshDeserialize, BorshSerialize)]
pub struct LendingAccount {
    pub balances: [Balance; 16], // Max 16 positions
    pub _padding: [u64; 8],
}

#[derive(Debug, Clone, BorshDeserialize, BorshSerialize, Default)]
pub struct Balance {
    pub active: bool,
    pub bank_pk: Pubkey,
    pub asset_shares: WrappedI80F48,
    pub liability_shares: WrappedI80F48,
    pub emissions_outstanding: WrappedI80F48,
    pub last_update: u64,
    pub _padding: [u64; 1],
}

/// Wrapped I80F48 pour les calculs précis (16 bytes)
#[derive(Debug, Clone, Copy, Default, BorshDeserialize, BorshSerialize)]
pub struct WrappedI80F48 {
    pub value: [u8; 16],
}

impl WrappedI80F48 {
    pub fn to_decimal(&self) -> Decimal {
        // Conversion simplifiée: les 8 premiers bytes sont la partie entière
        let int_part = i64::from_le_bytes(self.value[0..8].try_into().unwrap_or([0u8; 8]));
        Decimal::from(int_part) / Decimal::from(1_000_000_000u64) // Normalisé
    }
    
    #[allow(dead_code)]
    pub fn is_positive(&self) -> bool {
        self.to_decimal() > Decimal::ZERO
    }
}

/// Structure Bank Marginfi (info sur une réserve)
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct BankInfo {
    pub address: Pubkey,
    pub mint: Pubkey,
    pub asset_share_value: Decimal,
    pub liability_share_value: Decimal,
    pub liquidation_bonus: u16, // en basis points
    pub liquidation_threshold: Decimal,
}

/// Statistiques du bot
#[derive(Debug, Default)]
#[allow(dead_code)]
pub struct BotStats {
    pub total_scans: u64,
    pub opportunities_found: u64,
    pub liquidations_attempted: u64,
    pub liquidations_success: u64,
    pub liquidations_failed: u64,
    pub total_profit_lamports: i64,
    pub start_time: Option<DateTime<Utc>>,
}

impl BotStats {
    pub fn new() -> Self {
        Self {
            start_time: Some(Utc::now()),
            ..Default::default()
        }
    }

    pub fn record_scan(&mut self, found: u64) {
        self.total_scans += 1;
        self.opportunities_found += found;
    }

    pub fn record_liquidation(&mut self, success: bool, profit: i64) {
        self.liquidations_attempted += 1;
        if success {
            self.liquidations_success += 1;
            self.total_profit_lamports += profit;
        } else {
            self.liquidations_failed += 1;
        }
    }

    pub fn display(&self) {
        log::info!("═══════════════════════════════════════");
        log::info!("           STATISTIQUES BOT            ");
        log::info!("═══════════════════════════════════════");
        log::info!("Scans: {}", self.total_scans);
        log::info!("Opportunités trouvées: {}", self.opportunities_found);
        log::info!("Liquidations tentées: {}", self.liquidations_attempted);
        log::info!("  ✓ Réussies: {}", self.liquidations_success);
        log::info!("  ✗ Échouées: {}", self.liquidations_failed);
        log::info!("Profit total: {} lamports ({:.6} SOL)", 
            self.total_profit_lamports,
            self.total_profit_lamports as f64 / 1e9);
        log::info!("═══════════════════════════════════════");
    }
}

/// Calculs mathématiques
pub mod math {
    use rust_decimal::Decimal;

    /// Health factor = weighted_assets / weighted_liabilities
    #[allow(dead_code)]
    pub fn calculate_health_factor(
        asset_value: Decimal,
        asset_weight: Decimal, // ex: 0.85 pour 85%
        liab_value: Decimal,
        liab_weight: Decimal,  // ex: 1.1 pour 110%
    ) -> Decimal {
        let weighted_assets = asset_value * asset_weight;
        let weighted_liabs = liab_value * liab_weight;
        
        if weighted_liabs.is_zero() {
            Decimal::MAX
        } else {
            weighted_assets / weighted_liabs
        }
    }

    /// Position liquidable si health < 1
    #[allow(dead_code)]
    pub fn is_liquidatable(health: Decimal) -> bool {
        health < Decimal::ONE
    }

    /// Profit estimé: (collateral * bonus) - frais
    pub fn estimate_profit(
        liab_amount: u64,
        liquidation_bonus_bps: u16,
        gas_fee: u64,
        swap_slippage_bps: u16,
    ) -> i64 {
        let bonus = liab_amount as i64 * liquidation_bonus_bps as i64 / 10000;
        let slippage_cost = liab_amount as i64 * swap_slippage_bps as i64 / 10000;
        
        bonus - gas_fee as i64 - slippage_cost
    }

    /// Lamports to SOL
    pub fn lamports_to_sol(lamports: u64) -> f64 {
        lamports as f64 / 1_000_000_000.0
    }
}

/// Rate limiter simple
pub struct RateLimiter {
    requests_per_second: u32,
    last_request: std::time::Instant,
    count: u32,
}

impl RateLimiter {
    pub fn new(rps: u32) -> Self {
        Self {
            requests_per_second: rps,
            last_request: std::time::Instant::now(),
            count: 0,
        }
    }

    pub async fn wait(&mut self) {
        if self.last_request.elapsed().as_secs() >= 1 {
            self.count = 0;
            self.last_request = std::time::Instant::now();
        }

        if self.count >= self.requests_per_second {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            self.count = 0;
            self.last_request = std::time::Instant::now();
        }

        self.count += 1;
    }
}

/// Retry avec backoff exponentiel
#[allow(dead_code)]
pub async fn retry_with_backoff<T, F, Fut>(
    mut operation: F,
    max_retries: u32,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut delay_ms = 500u64;
    
    for attempt in 1..=max_retries {
        match operation().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                if attempt == max_retries {
                    return Err(e);
                }
                log::warn!("Tentative {}/{} échouée: {}. Retry dans {}ms", 
                    attempt, max_retries, e, delay_ms);
                tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;
                delay_ms *= 2;
            }
        }
    }
    
    Err(anyhow!("Max retries atteint"))
}
