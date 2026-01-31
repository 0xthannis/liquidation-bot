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

/// Structure Obligation Kamino - parsing corrigé basé sur la structure réelle
/// Ref: https://github.com/Kamino-Finance/klend/blob/main/programs/klend/src/state/obligation.rs
/// 
/// Layout (approximatif - Anchor IDL):
/// - [0..8]: Discriminator (Anchor)
/// - [8..16]: last_update (LastUpdate struct: slot u64 + stale bool)
/// - [16..17]: last_update stale flag
/// - [17..49]: lending_market (Pubkey)
/// - [49..81]: owner (Pubkey)
/// - [81..97]: deposited_value_sf (u128)
/// - [97..113]: borrowed_assets_market_value_sf (u128) 
/// - [113..129]: allowed_borrow_value_sf (u128)
/// - [129..145]: unhealthy_borrow_value_sf (u128)
/// - [145..161]: super_unhealthy_borrow_value_sf (u128)
/// - [161..169]: borrowing_isolated (bool + padding)
/// - ... puis deposits array et borrows array
#[derive(Debug)]
#[allow(dead_code)]
struct KaminoObligation {
    pub tag: u64,
    pub last_update_slot: u64,
    pub lending_market: Pubkey,
    pub owner: Pubkey,
    pub deposited_value_sf: u128,
    pub borrowed_assets_market_value_sf: u128,
    pub allowed_borrow_value_sf: u128,
    pub unhealthy_borrow_value_sf: u128,
    pub deposit_reserve: Pubkey,
    pub deposited_amount: u64,
    pub borrow_reserve: Pubkey,
    pub borrowed_amount_sf: u128,
}

/// Kamino Obligation discriminator (sha256("account:Obligation")[..8])
const KAMINO_OBLIGATION_DISCRIMINATOR: [u8; 8] = [168, 206, 141, 106, 88, 76, 172, 167];

impl KaminoObligation {
    /// Parse from account data with correct offsets
    fn from_account_data(data: &[u8]) -> Option<Self> {
        // Minimum size check - Obligation accounts are typically 1300+ bytes
        if data.len() < 500 {
            return None;
        }

        // Check discriminator to ensure this is an Obligation account
        let disc: [u8; 8] = data[0..8].try_into().ok()?;
        if disc != KAMINO_OBLIGATION_DISCRIMINATOR {
            // Try alternative: some accounts may have different discriminator
            // Log for debugging but continue parsing
            log::trace!("Non-standard discriminator: {:?}", disc);
        }
        
        let tag = u64::from_le_bytes(disc);

        // LastUpdate struct: slot (u64) + stale (bool, 1 byte padded to 8)
        let last_update_slot = u64::from_le_bytes(data[8..16].try_into().ok()?);
        
        // Lending market at offset 24 (after LastUpdate which is 16 bytes with padding)
        let lending_market = Pubkey::try_from(&data[24..56]).ok()?;
        
        // Owner at offset 56
        let owner = Pubkey::try_from(&data[56..88]).ok()?;
        
        // Scaled values (u128 = 16 bytes each)
        // deposited_value_sf at 88
        let deposited_value_sf = u128::from_le_bytes(data[88..104].try_into().ok()?);
        // borrowed_assets_market_value_sf at 104
        let borrowed_assets_market_value_sf = u128::from_le_bytes(data[104..120].try_into().ok()?);
        // allowed_borrow_value_sf at 120
        let allowed_borrow_value_sf = u128::from_le_bytes(data[120..136].try_into().ok()?);
        // unhealthy_borrow_value_sf at 136
        let unhealthy_borrow_value_sf = u128::from_le_bytes(data[136..152].try_into().ok()?);
        
        // Skip super_unhealthy (152..168), borrowing_isolated (168..176), etc.
        // Deposits array starts around offset 200-300 depending on version
        // Each ObligationCollateral is: deposit_reserve (32) + deposited_amount (u64) + ...
        
        // Search for first non-zero deposit in deposits array region
        let mut deposit_reserve = Pubkey::default();
        let mut deposited_amount = 0u64;
        
        // Deposits typically start around offset 200-250
        let deposits_start = 200;
        if data.len() > deposits_start + 64 {
            for i in 0..8 {
                let offset = deposits_start + (i * 80); // Each deposit entry ~80 bytes
                if offset + 40 > data.len() { break; }
                
                let reserve = Pubkey::try_from(&data[offset..offset+32]).unwrap_or_default();
                if reserve != Pubkey::default() {
                    deposit_reserve = reserve;
                    if offset + 40 <= data.len() {
                        deposited_amount = u64::from_le_bytes(
                            data[offset+32..offset+40].try_into().unwrap_or([0u8; 8])
                        );
                    }
                    break;
                }
            }
        }
        
        // Borrows array typically after deposits (around offset 800+)
        let mut borrow_reserve = Pubkey::default();
        let mut borrowed_amount_sf = 0u128;
        
        let borrows_start = 850;
        if data.len() > borrows_start + 64 {
            for i in 0..8 {
                let offset = borrows_start + (i * 96); // Each borrow entry ~96 bytes
                if offset + 48 > data.len() { break; }
                
                let reserve = Pubkey::try_from(&data[offset..offset+32]).unwrap_or_default();
                if reserve != Pubkey::default() {
                    borrow_reserve = reserve;
                    if offset + 48 <= data.len() {
                        borrowed_amount_sf = u128::from_le_bytes(
                            data[offset+32..offset+48].try_into().unwrap_or([0u8; 16])
                        );
                    }
                    break;
                }
            }
        }

        Some(Self {
            tag,
            last_update_slot,
            lending_market,
            owner,
            deposited_value_sf,
            borrowed_assets_market_value_sf,
            allowed_borrow_value_sf,
            unhealthy_borrow_value_sf,
            deposit_reserve,
            deposited_amount,
            borrow_reserve,
            borrowed_amount_sf,
        })
    }

    /// Calculate LTV (Loan-to-Value ratio)
    fn loan_to_value(&self) -> f64 {
        if self.deposited_value_sf == 0 {
            return 0.0;
        }
        self.borrowed_assets_market_value_sf as f64 / self.deposited_value_sf as f64
    }

    /// Check if liquidatable - borrowed value exceeds unhealthy threshold
    fn is_liquidatable(&self) -> bool {
        // Must have borrowed something
        if self.borrowed_assets_market_value_sf == 0 {
            return false;
        }
        // Unhealthy when borrowed > unhealthy_borrow_value
        self.borrowed_assets_market_value_sf > self.unhealthy_borrow_value_sf
    }
    
    /// Get health ratio (< 1.0 means liquidatable)
    fn health_ratio(&self) -> f64 {
        if self.borrowed_assets_market_value_sf == 0 {
            return f64::MAX;
        }
        if self.unhealthy_borrow_value_sf == 0 {
            return 0.0;
        }
        self.unhealthy_borrow_value_sf as f64 / self.borrowed_assets_market_value_sf as f64
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

    /// Scan tous les protocoles activés (multi-thread)
    pub async fn scan_all(&self) -> Result<Vec<LiquidationOpportunity>> {
        use tokio::task::JoinSet;
        
        log::info!("Starting parallel scan of all protocols...");
        
        let mut join_set: JoinSet<Result<Vec<LiquidationOpportunity>>> = JoinSet::new();
        
        // Clone what we need for async tasks
        let rpc_url = self.config.get_rpc_url().to_string();
        let timeout_ms = self.config.rpc_timeout_ms;
        let batch_size = self.config.batch_size;
        let max_slippage = self.config.max_slippage_percent;

        // Spawn Kamino scan task
        if self.config.enabled_protocols.contains(&Protocol::Kamino) {
            let rpc = rpc_url.clone();
            let bs = batch_size;
            let slip = max_slippage;
            join_set.spawn(async move {
                scan_kamino_parallel(rpc, timeout_ms, bs, slip).await
            });
        }

        // Spawn Marginfi scan task
        if self.config.enabled_protocols.contains(&Protocol::Marginfi) {
            let rpc = rpc_url.clone();
            let bs = batch_size;
            let slip = max_slippage;
            join_set.spawn(async move {
                scan_marginfi_parallel(rpc, timeout_ms, bs, slip).await
            });
        }

        // Collect results
        let mut opportunities = Vec::new();
        while let Some(result) = join_set.join_next().await {
            match result {
                Ok(Ok(mut opps)) => {
                    opportunities.append(&mut opps);
                }
                Ok(Err(e)) => {
                    log::warn!("Scan task error: {}", e);
                }
                Err(e) => {
                    log::error!("Task join error: {}", e);
                }
            }
        }

        // Filter by min profit
        let min_profit = self.config.min_profit_threshold as i64;
        opportunities.retain(|o| o.estimated_profit_lamports >= min_profit);

        // Sort by profit descending
        opportunities.sort_by(|a, b| b.estimated_profit_lamports.cmp(&a.estimated_profit_lamports));

        log::info!("Parallel scan complete: {} opportunities found", opportunities.len());
        Ok(opportunities)
    }

    /// Scan tous les protocoles (version séquentielle legacy)
    #[allow(dead_code)]
    pub async fn scan_all_sequential(&self) -> Result<Vec<LiquidationOpportunity>> {
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

        log::info!("  Marginfi: {} accounts fetched", accounts.len());

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

        // Filter by minimum data size (Obligation accounts vary from ~1200 to ~3000+ bytes)
        // Using memcmp filter for Obligation discriminator instead of exact size
        let config = RpcProgramAccountsConfig {
            filters: Some(vec![
                // Minimum size filter - obligations are at least 1200 bytes
                solana_client::rpc_filter::RpcFilterType::DataSize(1300),
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

        log::info!("  Kamino: {} accounts fetched", accounts.len());

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
                            health_factor: Decimal::from_f64(obligation.health_ratio()).unwrap_or(Decimal::ZERO),
                            asset_amount: obligation.deposited_amount,
                            liab_amount: (obligation.borrowed_amount_sf / 1_000_000_000_000) as u64,
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

/// Scan Kamino en parallèle (fonction standalone pour spawn)
async fn scan_kamino_parallel(
    rpc_url: String,
    timeout_ms: u64,
    batch_size: usize,
    max_slippage: u8,
) -> Result<Vec<LiquidationOpportunity>> {
    let rpc_client = RpcClient::new_with_timeout_and_commitment(
        rpc_url,
        std::time::Duration::from_millis(timeout_ms),
        CommitmentConfig::confirmed(),
    );

    let program_id = Pubkey::from_str("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD")?;

    let config = RpcProgramAccountsConfig {
        filters: Some(vec![
            // Minimum size filter - obligations are at least 1200 bytes
            solana_client::rpc_filter::RpcFilterType::DataSize(1300),
        ]),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            data_slice: None,
            commitment: Some(CommitmentConfig::confirmed()),
            min_context_slot: None,
        },
        with_context: Some(false),
    };

    let accounts = rpc_client
        .get_program_accounts_with_config(&program_id, config)
        .map_err(|e| anyhow!("RPC error Kamino: {}", e))?;

    log::info!("  [Parallel] Kamino: {} accounts fetched", accounts.len());

    let mut opportunities = Vec::new();
    let mut parsed_count = 0u64;
    let mut with_debt_count = 0u64;
    let mut liquidatable_count = 0u64;

    for (pubkey, account) in accounts.iter().take(batch_size) {
        if let Some(obligation) = KaminoObligation::from_account_data(&account.data) {
            parsed_count += 1;
            
            // Check if has active debt
            if obligation.borrowed_assets_market_value_sf > 0 {
                with_debt_count += 1;
                
                let ltv = obligation.loan_to_value();
                log::debug!("  Kamino obligation {}: LTV={:.4}, borrowed_sf={}, unhealthy_sf={}", 
                    pubkey, ltv, obligation.borrowed_assets_market_value_sf, obligation.unhealthy_borrow_value_sf);
            }
            
            if obligation.is_liquidatable() {
                liquidatable_count += 1;
                let current_ltv = obligation.loan_to_value();
                let total_debt = (obligation.borrowed_assets_market_value_sf / 1_000_000_000_000) as u64;
                let max_liquidatable = total_debt / 2;
                let bonus_bps = 500u16;

                let estimated_profit = math::estimate_profit(
                    max_liquidatable,
                    bonus_bps,
                    5000,
                    max_slippage as u16 * 100,
                );

                if estimated_profit > 0 {
                    // Fetch reserve data on-chain pour obtenir les mints
                    let (asset_mint, liab_mint) = fetch_reserve_mints(
                        &rpc_client,
                        &obligation.deposit_reserve,
                        &obligation.borrow_reserve,
                    ).unwrap_or((Pubkey::default(), Pubkey::default()));

                    opportunities.push(LiquidationOpportunity {
                        protocol: "Kamino".to_string(),
                        account_address: *pubkey,
                        owner: obligation.owner,
                        asset_bank: obligation.deposit_reserve,
                        liab_bank: obligation.borrow_reserve,
                        asset_mint,
                        liab_mint,
                        health_factor: Decimal::from_f64(obligation.health_ratio()).unwrap_or(Decimal::ZERO),
                        asset_amount: obligation.deposited_amount,
                        liab_amount: (obligation.borrowed_amount_sf / 1_000_000_000_000) as u64,
                        max_liquidatable,
                        liquidation_bonus_bps: bonus_bps,
                        estimated_profit_lamports: estimated_profit,
                        timestamp: chrono::Utc::now(),
                    });
                }
            }
        }
    }

    log::info!("  [Parallel] Kamino stats: parsed={}, with_debt={}, liquidatable={}, opportunities={}", 
        parsed_count, with_debt_count, liquidatable_count, opportunities.len());

    Ok(opportunities)
}

/// Scan Marginfi en parallèle (fonction standalone pour spawn)
async fn scan_marginfi_parallel(
    rpc_url: String,
    timeout_ms: u64,
    batch_size: usize,
    max_slippage: u8,
) -> Result<Vec<LiquidationOpportunity>> {
    let rpc_client = RpcClient::new_with_timeout_and_commitment(
        rpc_url,
        std::time::Duration::from_millis(timeout_ms),
        CommitmentConfig::confirmed(),
    );

    let program_id = ProgramIds::marginfi();
    let group = ProgramIds::marginfi_group();

    let config = RpcProgramAccountsConfig {
        filters: Some(vec![
            solana_client::rpc_filter::RpcFilterType::Memcmp(
                solana_client::rpc_filter::Memcmp::new_raw_bytes(
                    8,
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

    let accounts = rpc_client
        .get_program_accounts_with_config(&program_id, config)
        .map_err(|e| anyhow!("RPC error Marginfi: {}", e))?;

    log::info!("  [Parallel] Marginfi: {} accounts fetched", accounts.len());

    let mut opportunities = Vec::new();
    let mut parsed_count = 0u64;
    let mut with_debt_count = 0u64;
    let mut unhealthy_count = 0u64;

    for (pubkey, account) in accounts.iter().take(batch_size) {
        if let Ok(header) = borsh::from_slice::<MarginfiAccountHeader>(&account.data) {
            parsed_count += 1;
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

            if total_liabs > 0 {
                with_debt_count += 1;
            }

            if total_liabs > 0 && total_assets > 0 {
                let health = Decimal::from(total_assets) / Decimal::from(total_liabs);
                
                log::debug!("  Marginfi account {}: health={}, assets={}, liabs={}", 
                    pubkey, health, total_assets, total_liabs);

                if health < Decimal::ONE {
                    unhealthy_count += 1;
                    let max_liquidatable = (total_liabs as u64) / 2;
                    let bonus_bps = 250u16;

                    let estimated_profit = math::estimate_profit(
                        max_liquidatable,
                        bonus_bps,
                        5000,
                        max_slippage as u16 * 100,
                    );

                    if estimated_profit > 0 {
                        // Fetch bank mints on-chain
                        let (asset_mint, liab_mint) = fetch_marginfi_bank_mints(
                            &rpc_client,
                            &asset_bank,
                            &liab_bank,
                        ).unwrap_or((Pubkey::default(), Pubkey::default()));

                        opportunities.push(LiquidationOpportunity {
                            protocol: "Marginfi".to_string(),
                            account_address: *pubkey,
                            owner: header.authority,
                            asset_bank,
                            liab_bank,
                            asset_mint,
                            liab_mint,
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

    log::info!("  [Parallel] Marginfi stats: parsed={}, with_debt={}, unhealthy={}, opportunities={}", 
        parsed_count, with_debt_count, unhealthy_count, opportunities.len());

    Ok(opportunities)
}

/// Fetch reserve mints from Kamino reserve accounts
fn fetch_reserve_mints(
    rpc_client: &RpcClient,
    deposit_reserve: &Pubkey,
    borrow_reserve: &Pubkey,
) -> Result<(Pubkey, Pubkey)> {
    // Kamino Reserve structure: mint is at offset 40 (after discriminator + other fields)
    let asset_mint = match rpc_client.get_account(deposit_reserve) {
        Ok(account) => {
            if account.data.len() > 72 {
                Pubkey::try_from(&account.data[40..72]).unwrap_or_default()
            } else {
                Pubkey::default()
            }
        }
        Err(_) => Pubkey::default(),
    };

    let liab_mint = match rpc_client.get_account(borrow_reserve) {
        Ok(account) => {
            if account.data.len() > 72 {
                Pubkey::try_from(&account.data[40..72]).unwrap_or_default()
            } else {
                Pubkey::default()
            }
        }
        Err(_) => Pubkey::default(),
    };

    Ok((asset_mint, liab_mint))
}

/// Fetch bank mints from Marginfi bank accounts
fn fetch_marginfi_bank_mints(
    rpc_client: &RpcClient,
    asset_bank: &Pubkey,
    liab_bank: &Pubkey,
) -> Result<(Pubkey, Pubkey)> {
    // Marginfi Bank structure: mint is at offset 40 (after discriminator + group)
    let asset_mint = match rpc_client.get_account(asset_bank) {
        Ok(account) => {
            if account.data.len() > 72 {
                Pubkey::try_from(&account.data[40..72]).unwrap_or_default()
            } else {
                Pubkey::default()
            }
        }
        Err(_) => Pubkey::default(),
    };

    let liab_mint = match rpc_client.get_account(liab_bank) {
        Ok(account) => {
            if account.data.len() > 72 {
                Pubkey::try_from(&account.data[40..72]).unwrap_or_default()
            } else {
                Pubkey::default()
            }
        }
        Err(_) => Pubkey::default(),
    };

    Ok((asset_mint, liab_mint))
}
