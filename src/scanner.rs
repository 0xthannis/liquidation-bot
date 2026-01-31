//! Scanner de positions liquidables - Kamino & Marginfi
//! Implémentation sans dépendance externe kamino_lend pour éviter conflits Pubkey

use anyhow::{Result, anyhow};
use solana_sdk::pubkey::Pubkey;
use solana_client::rpc_client::RpcClient;
use solana_client::rpc_config::{RpcProgramAccountsConfig, RpcAccountInfoConfig};
use solana_account_decoder::UiAccountEncoding;
use solana_sdk::commitment_config::CommitmentConfig;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use std::sync::Arc;
use tokio::sync::Mutex;
use std::str::FromStr;

use crate::config::{BotConfig, Protocol, ProgramIds};
use crate::utils::{LiquidationOpportunity, MarginfiAccountHeader, RateLimiter, math};

/// Structure Obligation Kamino simplifiée (désérialisation manuelle)
/// Basée sur: https://github.com/Kamino-Finance/klend/blob/main/programs/klend/src/state/obligation.rs
#[derive(Debug)]
struct KaminoObligation {
    /// Discriminator (8 bytes)
    pub tag: u64,
    /// Last update slot
    pub last_update: u64,
    /// Lending market address
    pub lending_market: Pubkey,
    /// Owner of the obligation
    pub owner: Pubkey,
    /// Deposited value (scaled)
    pub deposited_value_sf: u128,
    /// Borrowed value (scaled)  
    pub borrowed_assets_market_value_sf: u128,
    /// Allowed borrow value
    pub allowed_borrow_value_sf: u128,
    /// Unhealthy borrow value
    pub unhealthy_borrow_value_sf: u128,
    /// Deposits (first one only for simplicity)
    pub deposit_reserve: Pubkey,
    pub deposited_amount: u64,
    /// Borrows (first one only for simplicity)
    pub borrow_reserve: Pubkey,
    pub borrowed_amount: u64,
}

impl KaminoObligation {
    /// Parse from account data (simplified)
    fn from_account_data(data: &[u8]) -> Option<Self> {
        if data.len() < 200 {
            return None;
        }

        // Parse discriminator
        let tag = u64::from_le_bytes(data[0..8].try_into().ok()?);
        
        // Skip if not an Obligation account (check discriminator)
        // Kamino Obligation discriminator: varies, we check size instead
        
        let last_update = u64::from_le_bytes(data[8..16].try_into().ok()?);
        
        // Lending market at offset 16
        let lending_market = Pubkey::try_from(&data[16..48]).ok()?;
        
        // Owner at offset 48
        let owner = Pubkey::try_from(&data[48..80]).ok()?;
        
        // Values at various offsets (these are u128 scaled values)
        let deposited_value_sf = u128::from_le_bytes(data[80..96].try_into().ok()?);
        let borrowed_assets_market_value_sf = u128::from_le_bytes(data[96..112].try_into().ok()?);
        let allowed_borrow_value_sf = u128::from_le_bytes(data[112..128].try_into().ok()?);
        let unhealthy_borrow_value_sf = u128::from_le_bytes(data[128..144].try_into().ok()?);
        
        // Deposits array starts around offset 200+ (simplified: get first reserve)
        let deposit_reserve = if data.len() > 232 {
            Pubkey::try_from(&data[200..232]).unwrap_or_default()
        } else {
            Pubkey::default()
        };
        
        let deposited_amount = if data.len() > 240 {
            u64::from_le_bytes(data[232..240].try_into().unwrap_or([0u8; 8]))
        } else {
            0
        };
        
        // Borrows array (simplified)
        let borrow_reserve = if data.len() > 360 {
            Pubkey::try_from(&data[328..360]).unwrap_or_default()
        } else {
            Pubkey::default()
        };
        
        let borrowed_amount = if data.len() > 368 {
            u64::from_le_bytes(data[360..368].try_into().unwrap_or([0u8; 8]))
        } else {
            0
        };

        Some(Self {
            tag,
            last_update,
            lending_market,
            owner,
            deposited_value_sf,
            borrowed_assets_market_value_sf,
            allowed_borrow_value_sf,
            unhealthy_borrow_value_sf,
            deposit_reserve,
            deposited_amount,
            borrow_reserve,
            borrowed_amount,
        })
    }

    /// Calculate LTV (Loan-to-Value ratio)
    fn loan_to_value(&self) -> f64 {
        if self.deposited_value_sf == 0 {
            return 0.0;
        }
        self.borrowed_assets_market_value_sf as f64 / self.deposited_value_sf as f64
    }

    /// Check if liquidatable
    fn is_liquidatable(&self) -> bool {
        self.borrowed_assets_market_value_sf > self.unhealthy_borrow_value_sf 
            && self.borrowed_assets_market_value_sf > 0
    }
}

/// Scanner principal
pub struct PositionScanner {
    rpc_client: RpcClient,
    config: BotConfig,
    rate_limiter: Arc<Mutex<RateLimiter>>,
}

impl PositionScanner {
    pub fn new(config: BotConfig) -> Result<Self> {
        let rpc_client = RpcClient::new_with_timeout_and_commitment(
            config.get_rpc_url().to_string(),
            std::time::Duration::from_millis(config.rpc_timeout_ms),
            CommitmentConfig::confirmed(),
        );

        let rate_limiter = Arc::new(Mutex::new(RateLimiter::new(8)));

        Ok(Self {
            rpc_client,
            config,
            rate_limiter,
        })
    }

    /// Scan tous les protocoles activés
    pub async fn scan_all(&self) -> Result<Vec<LiquidationOpportunity>> {
        let mut opportunities = Vec::new();

        for protocol in &self.config.enabled_protocols {
            self.rate_limiter.lock().await.wait().await;

            match protocol {
                Protocol::Kamino => {
                    log::info!("Scanning Kamino...");
                    match self.scan_kamino().await {
                        Ok(mut opps) => {
                            log::info!("  Found {} Kamino opportunities", opps.len());
                            opportunities.append(&mut opps);
                        }
                        Err(e) => log::warn!("  Kamino scan error: {}", e),
                    }
                }
                Protocol::Marginfi => {
                    log::info!("Scanning Marginfi...");
                    match self.scan_marginfi().await {
                        Ok(mut opps) => {
                            log::info!("  Found {} Marginfi opportunities", opps.len());
                            opportunities.append(&mut opps);
                        }
                        Err(e) => log::warn!("  Marginfi scan error: {}", e),
                    }
                }
                Protocol::JupiterLend => {
                    log::debug!("Jupiter Lend not yet supported");
                }
            }
        }

        // Filter by min profit
        let min_profit = self.config.min_profit_threshold as i64;
        opportunities.retain(|o| o.estimated_profit_lamports >= min_profit);

        // Sort by profit descending
        opportunities.sort_by(|a, b| b.estimated_profit_lamports.cmp(&a.estimated_profit_lamports));

        Ok(opportunities)
    }

    /// Scan Marginfi positions
    async fn scan_marginfi(&self) -> Result<Vec<LiquidationOpportunity>> {
        let program_id = ProgramIds::marginfi();
        let group = ProgramIds::marginfi_group();

        let config = RpcProgramAccountsConfig {
            filters: Some(vec![
                solana_client::rpc_filter::RpcFilterType::Memcmp(
                    solana_client::rpc_filter::Memcmp::new_raw_bytes(
                        8, // offset after discriminator
                        group.to_bytes().to_vec(),
                    )
                ),
                solana_client::rpc_filter::RpcFilterType::DataSize(2304),
            ]),
            account_config: RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64),
                data_slice: None,
                commitment: Some(CommitmentConfig::confirmed()),
                min_context_slot: None,
            },
            with_context: Some(false),
        };

        let accounts = self.rpc_client
            .get_program_accounts_with_config(&program_id, config)
            .map_err(|e| anyhow!("RPC error Marginfi: {}", e))?;

        log::debug!("  Marginfi: {} accounts found", accounts.len());

        let mut opportunities = Vec::new();

        for (pubkey, account) in accounts.iter().take(self.config.batch_size) {
            if let Ok(header) = borsh::from_slice::<MarginfiAccountHeader>(&account.data) {
                // Calculate health from balances
                let mut total_assets: i128 = 0;
                let mut total_liabs: i128 = 0;
                let mut asset_bank = Pubkey::default();
                let mut liab_bank = Pubkey::default();

                for balance in &header.lending_account.balances {
                    if balance.active {
                        let assets = balance.asset_shares.to_decimal();
                        let liabs = balance.liability_shares.to_decimal();

                        if assets > Decimal::ZERO {
                            total_assets += (assets * Decimal::from(1_000_000_000i64)).to_i128().unwrap_or(0);
                            if asset_bank == Pubkey::default() {
                                asset_bank = balance.bank_pk;
                            }
                        }
                        if liabs > Decimal::ZERO {
                            total_liabs += (liabs * Decimal::from(1_000_000_000i64)).to_i128().unwrap_or(0);
                            if liab_bank == Pubkey::default() {
                                liab_bank = balance.bank_pk;
                            }
                        }
                    }
                }

                if total_liabs > 0 && total_assets > 0 {
                    let health = Decimal::from(total_assets) / Decimal::from(total_liabs);

                    if health < Decimal::ONE {
                        let max_liquidatable = (total_liabs as u64) / 2;
                        let bonus_bps = 250u16;

                        let estimated_profit = math::estimate_profit(
                            max_liquidatable,
                            bonus_bps,
                            5000,
                            self.config.max_slippage_percent as u16 * 100,
                        );

                        if estimated_profit > 0 {
                            opportunities.push(LiquidationOpportunity {
                                protocol: "Marginfi".to_string(),
                                account_address: *pubkey,
                                owner: header.authority,
                                asset_bank,
                                liab_bank,
                                asset_mint: Pubkey::default(),
                                liab_mint: Pubkey::default(),
                                health_factor: health,
                                asset_amount: total_assets as u64,
                                liab_amount: total_liabs as u64,
                                max_liquidatable,
                                liquidation_bonus_bps: bonus_bps,
                                estimated_profit_lamports: estimated_profit,
                                timestamp: chrono::Utc::now(),
                            });
                        }
                    }
                }
            }
        }

        Ok(opportunities)
    }

    /// Scan Kamino positions
    async fn scan_kamino(&self) -> Result<Vec<LiquidationOpportunity>> {
        let program_id = Pubkey::from_str("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD")?;

        // Filter by data size (Obligation accounts are ~1500+ bytes)
        let config = RpcProgramAccountsConfig {
            filters: Some(vec![
                solana_client::rpc_filter::RpcFilterType::DataSize(1500),
            ]),
            account_config: RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64),
                data_slice: None,
                commitment: Some(CommitmentConfig::confirmed()),
                min_context_slot: None,
            },
            with_context: Some(false),
        };

        let accounts = self.rpc_client
            .get_program_accounts_with_config(&program_id, config)
            .map_err(|e| anyhow!("RPC error Kamino: {}", e))?;

        log::debug!("  Kamino: {} accounts found", accounts.len());

        let mut opportunities = Vec::new();

        for (pubkey, account) in accounts.iter().take(self.config.batch_size) {
            if let Some(obligation) = KaminoObligation::from_account_data(&account.data) {
                if obligation.is_liquidatable() {
                    let current_ltv = obligation.loan_to_value();
                    let total_debt = (obligation.borrowed_assets_market_value_sf / 1_000_000_000_000) as u64;
                    let max_liquidatable = total_debt / 2;
                    let bonus_bps = 500u16;

                    let estimated_profit = math::estimate_profit(
                        max_liquidatable,
                        bonus_bps,
                        5000,
                        self.config.max_slippage_percent as u16 * 100,
                    );

                    if estimated_profit > 0 {
                        opportunities.push(LiquidationOpportunity {
                            protocol: "Kamino".to_string(),
                            account_address: *pubkey,
                            owner: obligation.owner,
                            asset_bank: obligation.deposit_reserve,
                            liab_bank: obligation.borrow_reserve,
                            asset_mint: Pubkey::default(),
                            liab_mint: Pubkey::default(),
                            health_factor: Decimal::from_f64(1.0 - current_ltv).unwrap_or(Decimal::ZERO),
                            asset_amount: obligation.deposited_amount,
                            liab_amount: obligation.borrowed_amount,
                            max_liquidatable,
                            liquidation_bonus_bps: bonus_bps,
                            estimated_profit_lamports: estimated_profit,
                            timestamp: chrono::Utc::now(),
                        });
                    }
                }
            }
        }

        Ok(opportunities)
    }

    /// Vérifie la connexion RPC
    pub fn check_connection(&self) -> Result<()> {
        self.rpc_client.get_health()
            .map_err(|e| anyhow!("RPC unavailable: {}", e))
    }

    /// Récupère le solde du wallet
    pub fn get_balance(&self, pubkey: &Pubkey) -> Result<u64> {
        self.rpc_client.get_balance(pubkey)
            .map_err(|e| anyhow!("Balance error: {}", e))
    }

    /// Récupère le blockhash récent
    #[allow(dead_code)]
    pub fn get_blockhash(&self) -> Result<solana_sdk::hash::Hash> {
        self.rpc_client.get_latest_blockhash()
            .map_err(|e| anyhow!("Blockhash error: {}", e))
    }
}
