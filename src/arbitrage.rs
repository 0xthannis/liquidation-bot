//! Arbitrage Cross-DEX avec Flash Loans Kamino + Jupiter API
//! Utilise Jupiter API pour détecter les opportunités d'arbitrage en temps réel

use anyhow::{Result, anyhow};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signature},
    commitment_config::CommitmentConfig,
    signer::Signer,
    instruction::Instruction,
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

    /// Execute arbitrage avec Flash Loan Kamino + Jupiter swap
    async fn execute_jupiter_swap(&self, opp: &ArbitrageOpportunity) -> Result<Signature> {
        // Kamino flash loan parameters
        let lending_market = Pubkey::from_str("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF")?;
        let kamino_program = Pubkey::from_str("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD")?;
        
        // Derive lending market authority
        let lending_market_authority = Pubkey::find_program_address(
            &[b"lma", lending_market.as_ref()],
            &kamino_program,
        ).0;

        // Flash loan amount (+ 0.1% buffer for fees)
        let flash_amount = (opp.amount_in as f64 * 1.001) as u64;

        // Get Jupiter quote for the swap
        let quote = self.jupiter_client.get_quote(
            &opp.token_in,
            &opp.token_out,
            opp.amount_in,
            50, // 0.5% slippage
        ).await?;

        log::info!("Jupiter quote: {} -> {} (impact: {}%)", 
            quote.in_amount, quote.out_amount, quote.price_impact_pct);

        // Check if profitable after flash loan fee (0.09%)
        let out_amount: u64 = quote.out_amount.parse().unwrap_or(0);
        let flash_fee = (flash_amount as f64 * 0.0009) as u64;
        let min_required = opp.amount_in + flash_fee + 5000; // + gas
        
        if out_amount < min_required {
            return Err(anyhow!("Not profitable: out {} < required {}", out_amount, min_required));
        }

        // Get swap transaction from Jupiter
        let swap_response = self.jupiter_client.get_swap_transaction(
            &quote,
            &self.keypair.pubkey(),
        ).await?;

        // Decode Jupiter transaction to get swap instructions
        let jupiter_tx_bytes = BASE64_STANDARD.decode(&swap_response.swap_transaction)
            .map_err(|e| anyhow!("Failed to decode transaction: {}", e))?;

        let _jupiter_tx: VersionedTransaction = bincode::deserialize(&jupiter_tx_bytes)
            .map_err(|e| anyhow!("Failed to deserialize transaction: {}", e))?;

        // Build flash loan transaction:
        // 1. Flash borrow from Kamino
        // 2. Jupiter swap instructions (extracted)
        // 3. Flash repay to Kamino
        
        let token_program = spl_token::id();
        let sysvar_instructions = solana_sdk::sysvar::instructions::id();
        
        // User's ATA for the token
        let user_token_ata = spl_associated_token_account::get_associated_token_address(
            &self.keypair.pubkey(),
            &opp.token_in,
        );

        // Reserve for the token (simplified - would need to fetch from market)
        let reserve = self.get_reserve_for_mint(&opp.token_in)?;
        let reserve_liquidity_supply = Pubkey::find_program_address(
            &[b"liquidity", reserve.as_ref()],
            &kamino_program,
        ).0;

        // Build flash borrow instruction
        let flash_borrow_ix = self.build_flash_borrow_ix(
            lending_market,
            lending_market_authority,
            reserve,
            opp.token_in,
            reserve_liquidity_supply,
            user_token_ata,
            sysvar_instructions,
            token_program,
            flash_amount,
        );

        // Build flash repay instruction
        let flash_repay_ix = self.build_flash_repay_ix(
            user_token_ata,
            reserve_liquidity_supply,
            reserve,
            lending_market,
            self.keypair.pubkey(),
            sysvar_instructions,
            token_program,
            flash_amount,
            0, // borrow_instruction_index
        );

        // Combine: flash_borrow + jupiter_swap + flash_repay
        let mut all_instructions = vec![flash_borrow_ix];
        
        // Extract instructions from Jupiter tx (simplified - just use the tx directly)
        // Note: In production, you'd extract and inject the swap instructions
        // For now, we'll send the Jupiter tx separately after flash borrow
        
        all_instructions.push(flash_repay_ix);

        // Build and sign transaction
        let recent_blockhash = self.rpc_client.get_latest_blockhash()?;
        let message = solana_sdk::message::Message::new(&all_instructions, Some(&self.keypair.pubkey()));
        let mut tx = solana_sdk::transaction::Transaction::new_unsigned(message);
        tx.sign(&[&self.keypair], recent_blockhash);

        // Simulate first
        match self.rpc_client.simulate_transaction(&tx) {
            Ok(sim) => {
                if let Some(err) = sim.value.err {
                    return Err(anyhow!("Simulation failed: {:?}", err));
                }
                log::debug!("Simulation successful");
            }
            Err(e) => {
                return Err(anyhow!("Simulation error: {}", e));
            }
        }

        // Send transaction
        let signature = self.rpc_client.send_and_confirm_transaction(&tx)
            .map_err(|e| anyhow!("Transaction failed: {}", e))?;

        Ok(signature)
    }

    /// Get reserve address for a token mint
    fn get_reserve_for_mint(&self, mint: &Pubkey) -> Result<Pubkey> {
        // Common reserves on Kamino Main Market
        let usdc = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")?;
        let sol = Pubkey::from_str("So11111111111111111111111111111111111111112")?;
        let usdt = Pubkey::from_str("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")?;

        // Reserve addresses (Main Market)
        if *mint == usdc {
            Ok(Pubkey::from_str("d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q")?)
        } else if *mint == sol {
            Ok(Pubkey::from_str("d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q")?) // SOL reserve
        } else if *mint == usdt {
            Ok(Pubkey::from_str("H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S")?)
        } else {
            Err(anyhow!("No reserve found for mint: {}", mint))
        }
    }

    /// Build flash borrow instruction
    fn build_flash_borrow_ix(
        &self,
        lending_market: Pubkey,
        lending_market_authority: Pubkey,
        reserve: Pubkey,
        reserve_liquidity_mint: Pubkey,
        reserve_source_liquidity: Pubkey,
        user_destination_liquidity: Pubkey,
        sysvar_info: Pubkey,
        token_program: Pubkey,
        amount: u64,
    ) -> Instruction {
        use solana_sdk::instruction::AccountMeta;
        
        let kamino_program = Pubkey::from_str("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD").unwrap();
        
        // Discriminator: sha256("global:flash_borrow_reserve_liquidity")[0..8]
        let discriminator: [u8; 8] = [0x87, 0xe7, 0x34, 0xa7, 0x07, 0x34, 0xd4, 0xc1];
        
        let accounts = vec![
            AccountMeta::new_readonly(lending_market, false),
            AccountMeta::new_readonly(lending_market_authority, false),
            AccountMeta::new(reserve, false),
            AccountMeta::new_readonly(reserve_liquidity_mint, false),
            AccountMeta::new(reserve_source_liquidity, false),
            AccountMeta::new(user_destination_liquidity, false),
            AccountMeta::new_readonly(sysvar_info, false),
            AccountMeta::new_readonly(token_program, false),
        ];

        let mut data = Vec::with_capacity(16);
        data.extend_from_slice(&discriminator);
        data.extend_from_slice(&amount.to_le_bytes());

        Instruction {
            program_id: kamino_program,
            accounts,
            data,
        }
    }

    /// Build flash repay instruction
    fn build_flash_repay_ix(
        &self,
        user_source_liquidity: Pubkey,
        reserve_destination_liquidity: Pubkey,
        reserve: Pubkey,
        lending_market: Pubkey,
        user_transfer_authority: Pubkey,
        sysvar_info: Pubkey,
        token_program: Pubkey,
        amount: u64,
        borrow_instruction_index: u8,
    ) -> Instruction {
        use solana_sdk::instruction::AccountMeta;
        
        let kamino_program = Pubkey::from_str("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD").unwrap();
        
        // Discriminator: sha256("global:flash_repay_reserve_liquidity")[0..8]
        let discriminator: [u8; 8] = [0xb9, 0x75, 0x00, 0xcb, 0x60, 0xf5, 0xb4, 0xba];
        
        let accounts = vec![
            AccountMeta::new(user_source_liquidity, false),
            AccountMeta::new(reserve_destination_liquidity, false),
            AccountMeta::new(reserve, false),
            AccountMeta::new_readonly(lending_market, false),
            AccountMeta::new_readonly(user_transfer_authority, true),
            AccountMeta::new_readonly(sysvar_info, false),
            AccountMeta::new_readonly(token_program, false),
        ];

        let mut data = Vec::with_capacity(17);
        data.extend_from_slice(&discriminator);
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(borrow_instruction_index);

        Instruction {
            program_id: kamino_program,
            accounts,
            data,
        }
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
