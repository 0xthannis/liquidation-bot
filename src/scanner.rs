//! Scanner de positions liquidables - Marginfi focus
//! Basé sur la documentation officielle: https://docs.marginfi.com/mfi-v2

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
use borsh::BorshDeserialize;
use kamino_lend::state::Obligation;

use crate::config::{BotConfig, Protocol, ProgramIds};
use crate::utils::{LiquidationOpportunity, MarginfiAccountHeader, RateLimiter, math};

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

        // Helius free tier: ~10 req/s
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
            log::info!("🔍 Scan: {}", protocol);
            
            match protocol {
                Protocol::Marginfi => {
                    match self.scan_marginfi().await {
                        Ok(opps) => {
                            log::info!("  → {} positions liquidables", opps.len());
                            opportunities.extend(opps);
                        }
                        Err(e) => log::error!("  ❌ Erreur: {}", e),
                    }
                }
                Protocol::Kamino => {
                    match self.scan_kamino().await {
                        Ok(opps) => {
                            if opps.is_empty() {
                                log::warn!("  → Kamino: scan désactivé (implémentation complète à venir)");
                            } else {
                                log::info!("  → {} positions liquidables", opps.len());
                                opportunities.extend(opps);
                            }
                        }
                        Err(e) => log::error!("  ❌ Erreur: {}", e),
                    }
                }
                Protocol::JupiterLend => {
                    match self.scan_jupiter_lend().await {
                        Ok(opps) => {
                            if opps.is_empty() {
                                log::warn!("  → Jupiter Lend: scan désactivé (implémentation complète à venir)");
                            } else {
                                log::info!("  → {} positions liquidables", opps.len());
                                opportunities.extend(opps);
                            }
                        }
                        Err(e) => log::error!("  ❌ Erreur: {}", e),
                    }
                }
            }

            // Pause entre protocoles
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        }

        // Trier par profit décroissant
        opportunities.sort_by(|a, b| b.estimated_profit_lamports.cmp(&a.estimated_profit_lamports));

        // Filtrer par profit minimum
        let filtered: Vec<_> = opportunities
            .into_iter()
            .filter(|o| o.estimated_profit_lamports >= self.config.min_profit_threshold as i64)
            .collect();

        Ok(filtered)
    }

    /// Scan Marginfi V2
    /// Doc: https://docs.marginfi.com/mfi-v2
    async fn scan_marginfi(&self) -> Result<Vec<LiquidationOpportunity>> {
        // Rate limit
        {
            let mut limiter = self.rate_limiter.lock().await;
            limiter.wait().await;
        }

        let program_id = ProgramIds::marginfi();
        
        // Discriminator pour MarginfiAccount (8 bytes)
        // Calculé via: sha256("account:MarginfiAccount")[0..8]
        let marginfi_account_discriminator: [u8; 8] = [67, 178, 130, 109, 126, 114, 28, 42];

        let config = RpcProgramAccountsConfig {
            filters: Some(vec![
                solana_client::rpc_filter::RpcFilterType::Memcmp(
                    solana_client::rpc_filter::Memcmp::new_raw_bytes(
                        0,
                        marginfi_account_discriminator.to_vec(),
                    )
                ),
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
            .map_err(|e| anyhow!("RPC error: {}", e))?;

        log::debug!("  Marginfi: {} comptes trouvés", accounts.len());

        let mut opportunities = Vec::new();

        for (pubkey, account) in accounts.iter().take(self.config.batch_size) {
            if let Some(opp) = self.parse_marginfi_account(*pubkey, &account.data) {
                opportunities.push(opp);
            }
        }

        Ok(opportunities)
    }

    /// Parse un compte Marginfi pour détecter si liquidable
    fn parse_marginfi_account(&self, pubkey: Pubkey, data: &[u8]) -> Option<LiquidationOpportunity> {
        // Taille minimale d'un MarginfiAccount
        if data.len() < 500 {
            return None;
        }

        // Désérialiser le header
        let header = match MarginfiAccountHeader::try_from_slice(data) {
            Ok(h) => h,
            Err(_) => return None,
        };

        // Calculer les totaux assets/liabilities
        let mut total_assets: Decimal = Decimal::ZERO;
        let mut total_liabs: Decimal = Decimal::ZERO;
        let mut asset_bank = Pubkey::default();
        let mut liab_bank = Pubkey::default();

        for balance in &header.lending_account.balances {
            if !balance.active {
                continue;
            }

            let asset_value = balance.asset_shares.to_decimal();
            let liab_value = balance.liability_shares.to_decimal();

            if asset_value > Decimal::ZERO {
                total_assets += asset_value;
                if asset_bank == Pubkey::default() {
                    asset_bank = balance.bank_pk;
                }
            }

            if liab_value > Decimal::ZERO {
                total_liabs += liab_value;
                if liab_bank == Pubkey::default() {
                    liab_bank = balance.bank_pk;
                }
            }
        }

        // Pas de dette = pas liquidable
        if total_liabs <= Decimal::ZERO {
            return None;
        }

        // Calculer le health factor simplifié
        // En réalité, il faut les poids de risque de chaque bank
        let health = math::calculate_health_factor(
            total_assets,
            Decimal::new(85, 2),  // 0.85 asset weight (conservateur)
            total_liabs,
            Decimal::new(110, 2), // 1.10 liab weight
        );

        // Seulement si liquidable
        if !math::is_liquidatable(health) {
            return None;
        }

        // Montant max liquidable (50% de la dette typiquement)
        let max_liquidatable = (total_liabs * Decimal::new(50, 2))
            .to_u64()
            .unwrap_or(0);

        // Estimer le profit (5% bonus typique Marginfi)
        let estimated_profit = math::estimate_profit(
            max_liquidatable,
            500, // 5% = 500 bps
            5000, // gas fee estimé
            self.config.max_slippage_percent as u16 * 100,
        );

        Some(LiquidationOpportunity {
            protocol: "Marginfi".to_string(),
            account_address: pubkey,
            owner: header.authority,
            asset_bank,
            liab_bank,
            asset_mint: Pubkey::default(), // À récupérer depuis la bank
            liab_mint: Pubkey::default(),
            health_factor: health,
            asset_amount: total_assets.to_u64().unwrap_or(0),
            liab_amount: total_liabs.to_u64().unwrap_or(0),
            max_liquidatable,
            liquidation_bonus_bps: 500,
            estimated_profit_lamports: estimated_profit,
            timestamp: chrono::Utc::now(),
        })
    }

    /// Scan Kamino (klend)
    async fn scan_kamino(&self) -> Result<Vec<LiquidationOpportunity>> {
        // Rate limit
        {
            let mut limiter = self.rate_limiter.lock().await;
            limiter.wait().await;
        }

        let program_id = Pubkey::from_str("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD").unwrap();

        let config = RpcProgramAccountsConfig {
            filters: Some(vec![
                solana_client::rpc_filter::RpcFilterType::DataSize(Obligation::LEN as u64),
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
            .map_err(|e| anyhow!("RPC error: {}", e))?;

        log::debug!("  Kamino: {} comptes trouvés", accounts.len());

        let mut opportunities = Vec::new();

        for (pubkey, account) in accounts.iter().take(100) {
            if let Ok(obligation) = Obligation::try_from_slice(&account.data) {
                // Calcul LTV via méthode
                let current_ltv = obligation.loan_to_value().to_percent().unwrap_or(0) as f64 / 100.0;
                // Threshold : utiliser unhealthy_borrow_value_sf / deposited_value_sf ou méthode si disponible
                let liq_threshold = (obligation.unhealthy_borrow_value_sf as f64) / (obligation.deposited_value_sf as f64 + 1.0); // Approximation
                let bonus_bps = 500; // Valeur par défaut, à ajuster depuis Reserve

                if current_ltv > liq_threshold {
                    // Total debt
                    let total_debt = obligation.borrowed_assets_market_value_sf as u64;
                    let max_liquidatable = ((total_debt as f64) * 0.5) as u64;

                    let estimated_profit = math::estimate_profit(
                        max_liquidatable,
                        bonus_bps,
                        5000,
                        self.config.max_slippage_percent as u16 * 100,
                    );

                    opportunities.push(LiquidationOpportunity {
                        protocol: "Kamino".to_string(),
                        account_address: *pubkey,
                        owner: obligation.owner,
                        asset_bank: obligation.deposits.iter().find(|d| d.deposited_amount > 0).map(|d| d.deposit_reserve).unwrap_or(Pubkey::default()),
                        liab_bank: obligation.borrows.iter().find(|b| b.borrowed_amount() > 0).map(|b| b.borrow_reserve).unwrap_or(Pubkey::default()),
                        asset_mint: Pubkey::default(),
                        liab_mint: Pubkey::default(),
                        health_factor: Decimal::from_f64((1.0 - current_ltv).max(0.0)).unwrap_or(Decimal::ZERO),
                        asset_amount: obligation.deposited_value_sf as u64,
                        liab_amount: total_debt,
                        max_liquidatable,
                        liquidation_bonus_bps: bonus_bps,
                        estimated_profit_lamports: estimated_profit,
                        timestamp: chrono::Utc::now(),
                    });
                }
            }
        }

        Ok(opportunities)
    }

    /// Scan Jupiter Lend (placeholder)
    async fn scan_jupiter_lend(&self) -> Result<Vec<LiquidationOpportunity>> {
        log::warn!(
            "Jupiter Lend n'est pas encore supporté: l'API prêt/aggrégateur n'est pas intégrée.\n  → Supprimez 'JupiterLend' de ENABLED_PROTOCOLS tant que cette intégration est en cours."
        );
        Ok(Vec::new())
    }
}
    /// Vérifie la connexion RPC
    pub fn check_connection(&self) -> Result<()> {
        self.rpc_client.get_health()
            .map_err(|e| anyhow!("RPC indisponible: {}", e))
    }

    /// Récupère le solde du wallet
    pub fn get_balance(&self, pubkey: &Pubkey) -> Result<u64> {
        self.rpc_client.get_balance(pubkey)
            .map_err(|e| anyhow!("Erreur balance: {}", e))
    }

    /// Récupère le blockhash récent
    #[allow(dead_code)]
    pub fn get_blockhash(&self) -> Result<solana_sdk::hash::Hash> {
        self.rpc_client.get_latest_blockhash()
            .map_err(|e| anyhow!("Erreur blockhash: {}", e))
    }
