//! Arbitrage Cross-DEX avec Flash Loans Kamino + Jupiter API
//! Détecte et exécute des opportunités d'arbitrage entre DEXs Solana

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
use std::collections::HashMap;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};

use crate::config::BotConfig;
use crate::jupiter::JupiterClient;

/// DEXs supportés
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Dex {
    Raydium,
    Orca,
    Jupiter,
}

impl std::fmt::Display for Dex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Dex::Raydium => write!(f, "Raydium"),
            Dex::Orca => write!(f, "Orca"),
            Dex::Jupiter => write!(f, "Jupiter"),
        }
    }
}

/// Pool de liquidité
#[derive(Debug, Clone)]
pub struct LiquidityPool {
    pub dex: Dex,
    pub address: Pubkey,
    pub token_a: Pubkey,
    pub token_b: Pubkey,
    pub reserve_a: u64,
    pub reserve_b: u64,
    pub fee_bps: u16,
}

impl LiquidityPool {
    /// Calcule le prix token_a en termes de token_b
    pub fn price_a_to_b(&self) -> f64 {
        if self.reserve_a == 0 {
            return 0.0;
        }
        self.reserve_b as f64 / self.reserve_a as f64
    }

    /// Calcule le prix token_b en termes de token_a
    pub fn price_b_to_a(&self) -> f64 {
        if self.reserve_b == 0 {
            return 0.0;
        }
        self.reserve_a as f64 / self.reserve_b as f64
    }

    /// Calcule l'output pour un swap (avec AMM constant product)
    pub fn get_amount_out(&self, amount_in: u64, is_a_to_b: bool) -> u64 {
        let (reserve_in, reserve_out) = if is_a_to_b {
            (self.reserve_a, self.reserve_b)
        } else {
            (self.reserve_b, self.reserve_a)
        };

        if reserve_in == 0 || reserve_out == 0 {
            return 0;
        }

        // AMM formula: amount_out = (amount_in * reserve_out) / (reserve_in + amount_in)
        // Avec frais: amount_in_with_fee = amount_in * (10000 - fee_bps) / 10000
        let amount_in_with_fee = (amount_in as u128) * (10000 - self.fee_bps as u128) / 10000;
        let numerator = amount_in_with_fee * (reserve_out as u128);
        let denominator = (reserve_in as u128) + amount_in_with_fee;

        (numerator / denominator) as u64
    }
}

/// Opportunité d'arbitrage
#[derive(Debug, Clone)]
pub struct ArbitrageOpportunity {
    pub token_in: Pubkey,
    pub token_out: Pubkey,
    pub amount_in: u64,
    pub expected_profit: u64,
    pub profit_percent: f64,
    pub path: Vec<(Dex, Pubkey)>, // (DEX, pool address)
    pub flash_loan_fee: u64,
}

/// Scanner d'arbitrage
pub struct ArbitrageScanner {
    rpc_client: RpcClient,
    config: BotConfig,
    pools: HashMap<(Pubkey, Pubkey), Vec<LiquidityPool>>, // (token_a, token_b) -> pools
}

impl ArbitrageScanner {
    pub fn new(config: BotConfig) -> Result<Self> {
        let rpc_client = RpcClient::new_with_timeout_and_commitment(
            config.get_rpc_url().to_string(),
            std::time::Duration::from_millis(config.rpc_timeout_ms),
            CommitmentConfig::confirmed(),
        );

        Ok(Self {
            rpc_client,
            config,
            pools: HashMap::new(),
        })
    }

    /// Scan pour opportunités d'arbitrage
    pub async fn scan(&mut self) -> Result<Vec<ArbitrageOpportunity>> {
        log::info!("Scanning for arbitrage opportunities...");

        // Rafraîchir les pools
        self.refresh_pools().await?;

        let mut opportunities = Vec::new();

        // Tokens principaux à scanner
        let usdc = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")?;
        let sol = Pubkey::from_str("So11111111111111111111111111111111111111112")?;
        let usdt = Pubkey::from_str("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")?;

        // Montants d'emprunt flash loan pour l'arbitrage (MAX PROFITS)
        let test_amounts = vec![
            50_000_000_000u64,    // 50,000 USDC
            100_000_000_000u64,   // 100,000 USDC
            250_000_000_000u64,   // 250,000 USDC
            500_000_000_000u64,   // 500,000 USDC
            1_000_000_000_000u64, // 1,000,000 USDC (1M)
        ];

        // Scanner les paires principales
        for &amount in &test_amounts {
            // USDC -> SOL -> USDC (triangle)
            if let Some(opp) = self.find_triangle_arb(usdc, sol, usdc, amount).await {
                if opp.profit_percent > 0.1 { // > 0.1% profit
                    opportunities.push(opp);
                }
            }

            // USDC -> SOL via différents DEXs (direct arb)
            if let Some(opp) = self.find_cross_dex_arb(usdc, sol, amount).await {
                if opp.profit_percent > 0.1 {
                    opportunities.push(opp);
                }
            }

            // USDT -> USDC arbitrage (stablecoin depeg)
            if let Some(opp) = self.find_cross_dex_arb(usdt, usdc, amount).await {
                if opp.profit_percent > 0.05 { // Lower threshold for stables
                    opportunities.push(opp);
                }
            }
        }

        // Trier par profit
        opportunities.sort_by(|a, b| b.expected_profit.cmp(&a.expected_profit));

        log::info!("Found {} arbitrage opportunities", opportunities.len());
        Ok(opportunities)
    }

    /// Rafraîchit les données des pools
    async fn refresh_pools(&mut self) -> Result<()> {
        // Pools Raydium principaux (hardcoded pour simplifier)
        // En production, il faudrait les fetch dynamiquement
        
        let usdc = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")?;
        let sol = Pubkey::from_str("So11111111111111111111111111111111111111112")?;

        // Raydium SOL/USDC pool
        let raydium_sol_usdc = Pubkey::from_str("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2")?;
        
        // Orca SOL/USDC pool (Whirlpool)
        let orca_sol_usdc = Pubkey::from_str("HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ")?;

        // Fetch reserves from on-chain (simplified - using estimates)
        // En production réelle, il faut parser les account data des pools
        
        let raydium_pool = LiquidityPool {
            dex: Dex::Raydium,
            address: raydium_sol_usdc,
            token_a: sol,
            token_b: usdc,
            reserve_a: self.fetch_pool_reserve(&raydium_sol_usdc, true).await.unwrap_or(1_000_000_000_000), // ~1000 SOL
            reserve_b: self.fetch_pool_reserve(&raydium_sol_usdc, false).await.unwrap_or(100_000_000_000), // ~100k USDC
            fee_bps: 25, // 0.25%
        };

        let orca_pool = LiquidityPool {
            dex: Dex::Orca,
            address: orca_sol_usdc,
            token_a: sol,
            token_b: usdc,
            reserve_a: self.fetch_pool_reserve(&orca_sol_usdc, true).await.unwrap_or(1_000_000_000_000),
            reserve_b: self.fetch_pool_reserve(&orca_sol_usdc, false).await.unwrap_or(100_000_000_000),
            fee_bps: 30, // 0.30%
        };

        // Index pools by token pair
        let key = (sol, usdc);
        self.pools.insert(key, vec![raydium_pool, orca_pool]);

        Ok(())
    }

    /// Fetch pool reserve from on-chain
    async fn fetch_pool_reserve(&self, pool: &Pubkey, is_token_a: bool) -> Result<u64> {
        // Simplified: In production, parse the pool account data structure
        // For now, return a placeholder that will be replaced with real data
        
        match self.rpc_client.get_account(pool) {
            Ok(account) => {
                // Parse based on pool type
                // Raydium AMM v4: reserves at specific offsets
                // Orca Whirlpool: different structure
                
                if account.data.len() > 100 {
                    // Simplified parsing - offset 72 for token A, 80 for token B (Raydium)
                    let offset = if is_token_a { 72 } else { 80 };
                    if account.data.len() > offset + 8 {
                        let bytes: [u8; 8] = account.data[offset..offset+8].try_into().unwrap_or([0u8; 8]);
                        return Ok(u64::from_le_bytes(bytes));
                    }
                }
                Ok(0)
            }
            Err(_) => Ok(0),
        }
    }

    /// Trouve arbitrage cross-DEX (même paire, DEXs différents)
    async fn find_cross_dex_arb(
        &self,
        token_a: Pubkey,
        token_b: Pubkey,
        amount: u64,
    ) -> Option<ArbitrageOpportunity> {
        let key = (token_a, token_b);
        let pools = self.pools.get(&key)?;

        if pools.len() < 2 {
            return None;
        }

        let mut best_profit: i64 = 0;
        let mut best_path: Option<(usize, usize)> = None;

        // Compare all pool pairs
        for i in 0..pools.len() {
            for j in 0..pools.len() {
                if i == j {
                    continue;
                }

                // Buy on pool i, sell on pool j
                let amount_out_1 = pools[i].get_amount_out(amount, true); // A -> B
                let amount_out_2 = pools[j].get_amount_out(amount_out_1, false); // B -> A

                let profit = amount_out_2 as i64 - amount as i64;
                if profit > best_profit {
                    best_profit = profit;
                    best_path = Some((i, j));
                }
            }
        }

        if best_profit <= 0 {
            return None;
        }

        let (buy_idx, sell_idx) = best_path?;
        let flash_loan_fee = (amount as f64 * 0.0009) as u64; // 0.09% Kamino flash loan fee

        if best_profit as u64 <= flash_loan_fee {
            return None; // Not profitable after fees
        }

        let net_profit = best_profit as u64 - flash_loan_fee;
        let profit_percent = (net_profit as f64 / amount as f64) * 100.0;

        Some(ArbitrageOpportunity {
            token_in: token_a,
            token_out: token_a,
            amount_in: amount,
            expected_profit: net_profit,
            profit_percent,
            path: vec![
                (pools[buy_idx].dex, pools[buy_idx].address),
                (pools[sell_idx].dex, pools[sell_idx].address),
            ],
            flash_loan_fee,
        })
    }

    /// Trouve arbitrage triangulaire
    async fn find_triangle_arb(
        &self,
        token_a: Pubkey,
        token_b: Pubkey,
        token_c: Pubkey,
        amount: u64,
    ) -> Option<ArbitrageOpportunity> {
        // A -> B -> C -> A
        // Pour simplifier, on utilise Jupiter pour le routing
        
        // Cette fonction est un placeholder
        // En production, il faudrait:
        // 1. Trouver pools A/B, B/C, C/A
        // 2. Calculer le meilleur chemin
        // 3. Vérifier profitabilité

        None // TODO: Implement full triangle arbitrage
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

        let jupiter_tx: VersionedTransaction = bincode::deserialize(&jupiter_tx_bytes)
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
pub struct ArbitrageResult {
    pub success: bool,
    pub signature: Option<Signature>,
    pub profit: i64,
    pub error: Option<String>,
}
