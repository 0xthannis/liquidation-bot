//! Arbitrage Cross-DEX avec Flash Loans Kamino + Jupiter API
//! Utilise Jupiter API pour détecter les opportunités d'arbitrage en temps réel

use anyhow::{Result, anyhow};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signature},
    commitment_config::CommitmentConfig,
    signer::Signer,
    transaction::VersionedTransaction,
};
use solana_client::rpc_client::RpcClient;
use std::str::FromStr;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};

use crate::config::BotConfig;
use crate::jupiter::JupiterClient;

/// Opportunité d'arbitrage détectée via Jupiter
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ArbitrageOpportunity {
    pub token_in: Pubkey,
    pub token_out: Pubkey,
    pub amount_in: u64,
    pub expected_profit: u64,
    pub profit_percent: f64,
    pub path: Vec<(String, Pubkey)>, // (DEX label, pool address)
    pub flash_loan_fee: u64,
}

/// Scanner d'arbitrage utilisant Jupiter API
pub struct ArbitrageScanner {
    config: BotConfig,
    jupiter_client: JupiterClient,
}

impl ArbitrageScanner {
    pub fn new(config: BotConfig) -> Result<Self> {
        let jupiter_client = JupiterClient::new();

        Ok(Self {
            config,
            jupiter_client,
        })
    }

    /// Scan pour opportunités d'arbitrage via Jupiter API (temps réel)
    pub async fn scan(&mut self) -> Result<Vec<ArbitrageOpportunity>> {
        log::info!("🔍 Scanning arbitrage via Jupiter API...");

        let mut opportunities = Vec::new();

        // Tokens principaux
        let usdc = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")?;
        let sol = Pubkey::from_str("So11111111111111111111111111111111111111112")?;
        let usdt = Pubkey::from_str("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")?;
        let bonk = Pubkey::from_str("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")?;
        let jito = Pubkey::from_str("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn")?;

        // Montants à tester (en lamports/base units)
        let test_amounts_sol = vec![
            1_000_000_000u64,     // 1 SOL
            10_000_000_000u64,    // 10 SOL
            100_000_000_000u64,   // 100 SOL
        ];
        
        let test_amounts_usdc = vec![
            100_000_000u64,       // 100 USDC (6 decimals)
            1_000_000_000u64,     // 1,000 USDC
            10_000_000_000u64,    // 10,000 USDC
        ];

        // Scan SOL -> Token -> SOL (round-trip arbitrage)
        for &amount in &test_amounts_sol {
            // SOL -> USDC -> SOL
            if let Some(opp) = self.check_roundtrip_arb(sol, usdc, amount).await {
                if opp.profit_percent > 0.05 {
                    log::info!("  💰 Found SOL->USDC->SOL arb: {:.3}% profit", opp.profit_percent);
                    opportunities.push(opp);
                }
            }
            
            // SOL -> jitoSOL -> SOL (LST arb)
            if let Some(opp) = self.check_roundtrip_arb(sol, jito, amount).await {
                if opp.profit_percent > 0.02 {
                    log::info!("  💰 Found SOL->jitoSOL->SOL arb: {:.3}% profit", opp.profit_percent);
                    opportunities.push(opp);
                }
            }
            
            // SOL -> BONK -> SOL (meme coin volatility)
            if let Some(opp) = self.check_roundtrip_arb(sol, bonk, amount).await {
                if opp.profit_percent > 0.1 {
                    log::info!("  💰 Found SOL->BONK->SOL arb: {:.3}% profit", opp.profit_percent);
                    opportunities.push(opp);
                }
            }
        }

        // Scan USDC -> Token -> USDC
        for &amount in &test_amounts_usdc {
            // USDC -> USDT -> USDC (stablecoin depeg)
            if let Some(opp) = self.check_roundtrip_arb(usdc, usdt, amount).await {
                if opp.profit_percent > 0.01 { // Lower threshold for stables
                    log::info!("  💰 Found USDC->USDT->USDC arb: {:.3}% profit", opp.profit_percent);
                    opportunities.push(opp);
                }
            }
            
            // USDC -> SOL -> USDC
            if let Some(opp) = self.check_roundtrip_arb(usdc, sol, amount).await {
                if opp.profit_percent > 0.05 {
                    log::info!("  💰 Found USDC->SOL->USDC arb: {:.3}% profit", opp.profit_percent);
                    opportunities.push(opp);
                }
            }
        }

        // Trier par profit
        opportunities.sort_by(|a, b| b.expected_profit.cmp(&a.expected_profit));

        log::info!("📊 Arbitrage scan complete: {} opportunities", opportunities.len());
        Ok(opportunities)
    }

    /// Check round-trip arbitrage: A -> B -> A via Jupiter
    async fn check_roundtrip_arb(
        &self,
        token_a: Pubkey,
        token_b: Pubkey,
        amount: u64,
    ) -> Option<ArbitrageOpportunity> {
        // Step 1: Get quote A -> B
        let quote_ab = match self.jupiter_client.get_quote(&token_a, &token_b, amount, 50).await {
            Ok(q) => q,
            Err(e) => {
                log::debug!("Quote A->B failed: {}", e);
                return None;
            }
        };

        let amount_b: u64 = quote_ab.out_amount.parse().unwrap_or(0);
        if amount_b == 0 {
            return None;
        }

        // Step 2: Get quote B -> A (return trip)
        let quote_ba = match self.jupiter_client.get_quote(&token_b, &token_a, amount_b, 50).await {
            Ok(q) => q,
            Err(e) => {
                log::debug!("Quote B->A failed: {}", e);
                return None;
            }
        };

        let amount_returned: u64 = quote_ba.out_amount.parse().unwrap_or(0);
        if amount_returned == 0 {
            return None;
        }

        // Calculate profit
        let flash_loan_fee = (amount as f64 * 0.0009) as u64; // 0.09% Kamino flash loan fee
        let gas_estimate = 10_000u64; // ~0.00001 SOL
        let total_costs = flash_loan_fee + gas_estimate;

        if amount_returned <= amount + total_costs {
            return None; // Not profitable
        }

        let gross_profit = amount_returned - amount;
        let net_profit = gross_profit - total_costs;
        let profit_percent = (net_profit as f64 / amount as f64) * 100.0;

        // Extract route info from Jupiter
        let path: Vec<(String, Pubkey)> = quote_ab.route_plan.iter()
            .filter_map(|r| {
                let label = r.swap_info.label.clone().unwrap_or_else(|| "Unknown".to_string());
                Pubkey::from_str(&r.swap_info.amm_key).ok().map(|pk| (label, pk))
            })
            .collect();

        Some(ArbitrageOpportunity {
            token_in: token_a,
            token_out: token_a,
            amount_in: amount,
            expected_profit: net_profit,
            profit_percent,
            path,
            flash_loan_fee,
        })
    }
}

/// Exécuteur d'arbitrage avec Jupiter API
pub struct ArbitrageExecutor {
    rpc_client: RpcClient,
    jupiter_client: JupiterClient,
    keypair: Keypair,
    config: BotConfig,
}

impl ArbitrageExecutor {
    pub fn new(config: BotConfig) -> Result<Self> {
        let keypair = config.get_keypair()?;
        let rpc_client = RpcClient::new_with_timeout_and_commitment(
            config.get_rpc_url().to_string(),
            std::time::Duration::from_millis(config.rpc_timeout_ms),
            CommitmentConfig::confirmed(),
        );
        let jupiter_client = JupiterClient::new();

        Ok(Self {
            rpc_client,
            jupiter_client,
            keypair,
            config,
        })
    }

    /// Exécute un arbitrage via Jupiter API (meilleur routing automatique)
    pub async fn execute(&self, opp: &ArbitrageOpportunity) -> Result<ArbitrageResult> {
        log::info!("Executing arbitrage via Jupiter: {} -> profit: {} ({:.2}%)", 
            opp.amount_in, opp.expected_profit, opp.profit_percent);

        if self.config.dry_run {
            log::info!("DRY RUN: Would execute arbitrage for {} lamports profit", opp.expected_profit);
            return Ok(ArbitrageResult {
                success: true,
                signature: None,
                profit: opp.expected_profit as i64,
                error: None,
            });
        }

        // Use Jupiter for the swap (it handles routing automatically)
        let result = self.execute_jupiter_swap(opp).await;
        
        match result {
            Ok(sig) => {
                log::info!("Arbitrage executed via Jupiter: {}", sig);
                Ok(ArbitrageResult {
                    success: true,
                    signature: Some(sig),
                    profit: opp.expected_profit as i64,
                    error: None,
                })
            }
            Err(e) => {
                log::warn!("Arbitrage failed: {}", e);
                Ok(ArbitrageResult {
                    success: false,
                    signature: None,
                    profit: 0,
                    error: Some(e.to_string()),
                })
            }
        }
    }

    /// Execute arbitrage via Jupiter swap directly (sans flash loan pour simplifier)
    /// Note: Pour un vrai arbitrage avec flash loan, il faudrait extraire les instructions
    /// Jupiter et les injecter dans une transaction atomique avec flash_borrow/flash_repay
    async fn execute_jupiter_swap(&self, opp: &ArbitrageOpportunity) -> Result<Signature> {
        // ÉTAPE 1: Obtenir quote aller (token_in -> token_out)
        let quote_forward = self.jupiter_client.get_quote(
            &opp.token_in,
            &opp.token_out,
            opp.amount_in,
            50, // 0.5% slippage
        ).await?;

        log::info!("Jupiter quote forward: {} -> {} (impact: {}%)", 
            quote_forward.in_amount, quote_forward.out_amount, quote_forward.price_impact_pct);

        let amount_mid: u64 = quote_forward.out_amount.parse().unwrap_or(0);
        if amount_mid == 0 {
            return Err(anyhow!("Invalid forward quote"));
        }

        // ÉTAPE 2: Obtenir quote retour (token_out -> token_in)
        let quote_return = self.jupiter_client.get_quote(
            &opp.token_out,
            &opp.token_in,
            amount_mid,
            50, // 0.5% slippage
        ).await?;

        log::info!("Jupiter quote return: {} -> {} (impact: {}%)", 
            quote_return.in_amount, quote_return.out_amount, quote_return.price_impact_pct);

        let amount_final: u64 = quote_return.out_amount.parse().unwrap_or(0);
        
        // Vérifier profitabilité finale
        let gas_estimate = 15_000u64; // ~0.000015 SOL pour 2 swaps
        if amount_final <= opp.amount_in + gas_estimate {
            return Err(anyhow!("Not profitable after round-trip: in={}, out={}", opp.amount_in, amount_final));
        }

        let profit = amount_final - opp.amount_in - gas_estimate;
        log::info!("Expected profit: {} ({:.4}%)", profit, (profit as f64 / opp.amount_in as f64) * 100.0);

        // ÉTAPE 3: Exécuter le premier swap (forward)
        let swap_response_1 = self.jupiter_client.get_swap_transaction(
            &quote_forward,
            &self.keypair.pubkey(),
        ).await?;

        let tx_bytes_1 = BASE64_STANDARD.decode(&swap_response_1.swap_transaction)
            .map_err(|e| anyhow!("Failed to decode swap tx 1: {}", e))?;

        let jupiter_tx_1: VersionedTransaction = bincode::deserialize(&tx_bytes_1)
            .map_err(|e| anyhow!("Failed to deserialize swap tx 1: {}", e))?;

        // Signer et envoyer le premier swap
        // Créer une transaction signée
        let signed_tx_1 = VersionedTransaction::try_new(
            jupiter_tx_1.message,
            &[&self.keypair],
        ).map_err(|e| anyhow!("Failed to sign tx 1: {}", e))?;

        // Simuler d'abord
        match self.rpc_client.simulate_transaction(&signed_tx_1) {
            Ok(sim) => {
                if let Some(err) = sim.value.err {
                    return Err(anyhow!("Swap 1 simulation failed: {:?}", err));
                }
                log::info!("Swap 1 simulation OK");
            }
            Err(e) => return Err(anyhow!("Swap 1 simulation error: {}", e)),
        }

        // Envoyer le premier swap
        let sig_1 = self.rpc_client.send_and_confirm_transaction_with_spinner(&signed_tx_1)
            .map_err(|e| anyhow!("Swap 1 failed: {}", e))?;
        
        log::info!("Swap 1 executed: {}", sig_1);

        // Petit délai pour confirmation
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        // ÉTAPE 4: Obtenir nouveau quote retour (avec montant réel reçu)
        let quote_return_fresh = self.jupiter_client.get_quote(
            &opp.token_out,
            &opp.token_in,
            amount_mid,
            100, // 1% slippage pour le retour (plus de marge)
        ).await?;

        let swap_response_2 = self.jupiter_client.get_swap_transaction(
            &quote_return_fresh,
            &self.keypair.pubkey(),
        ).await?;

        let tx_bytes_2 = BASE64_STANDARD.decode(&swap_response_2.swap_transaction)
            .map_err(|e| anyhow!("Failed to decode swap tx 2: {}", e))?;

        let jupiter_tx_2: VersionedTransaction = bincode::deserialize(&tx_bytes_2)
            .map_err(|e| anyhow!("Failed to deserialize swap tx 2: {}", e))?;

        let signed_tx_2 = VersionedTransaction::try_new(
            jupiter_tx_2.message,
            &[&self.keypair],
        ).map_err(|e| anyhow!("Failed to sign tx 2: {}", e))?;

        // Simuler
        match self.rpc_client.simulate_transaction(&signed_tx_2) {
            Ok(sim) => {
                if let Some(err) = sim.value.err {
                    return Err(anyhow!("Swap 2 simulation failed: {:?}", err));
                }
                log::info!("Swap 2 simulation OK");
            }
            Err(e) => return Err(anyhow!("Swap 2 simulation error: {}", e)),
        }

        // Envoyer le deuxième swap
        let sig_2 = self.rpc_client.send_and_confirm_transaction_with_spinner(&signed_tx_2)
            .map_err(|e| anyhow!("Swap 2 failed: {}", e))?;
        
        log::info!("Swap 2 executed: {}", sig_2);
        log::info!("✅ Arbitrage complete! Signatures: {} -> {}", sig_1, sig_2);

        Ok(sig_2)
    }
}

/// Résultat d'arbitrage
#[derive(Debug)]
#[allow(dead_code)]
pub struct ArbitrageResult {
    pub success: bool,
    pub signature: Option<Signature>,
    pub profit: i64,
    pub error: Option<String>,
}
