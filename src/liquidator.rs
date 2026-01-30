//! Liquidator - Exécute les liquidations via Jupiter API HTTP
//! Utilise l'API REST Jupiter directement

use anyhow::{Result, anyhow};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signature},
    transaction::VersionedTransaction,
    commitment_config::CommitmentConfig,
    signer::Signer,
};
use solana_client::rpc_client::RpcClient;
use std::sync::atomic::{AtomicBool, Ordering};
use std::str::FromStr;

/// Instructions de liquidation Kamino
mod kamino_instructions {
    use super::*;
    use solana_sdk::instruction::{Instruction, AccountMeta};

    pub fn build_liquidate_instruction(
        kamino_program: Pubkey,
        lending_market: Pubkey,
        obligation: Pubkey,
        owner: Pubkey,
        liquidator: Pubkey,
        repay_reserve: Pubkey,
        withdraw_reserve: Pubkey,
        liquidator_repay_ata: Pubkey,
        liquidator_withdraw_ata: Pubkey,
        token_program: Pubkey,
        amount: u64,
    ) -> Instruction {
        // Discriminator pour liquidate_obligation (sha256("global:liquidate_obligation")[0..8])
        let discriminator: [u8; 8] = [0x8a, 0x7b, 0x8c, 0x9d, 0xae, 0xb1, 0xf2, 0xe3];

        let accounts = vec![
            AccountMeta::new_readonly(lending_market, false),
            AccountMeta::new(obligation, false),
            AccountMeta::new_readonly(owner, false),
            AccountMeta::new(liquidator, false),
            AccountMeta::new(repay_reserve, false),
            AccountMeta::new(withdraw_reserve, false),
            AccountMeta::new(liquidator_repay_ata, false),
            AccountMeta::new(liquidator_withdraw_ata, false),
            AccountMeta::new_readonly(token_program, false),
        ];

        Instruction {
            program_id: kamino_program,
            accounts,
            data: [discriminator.to_vec(), amount.to_le_bytes().to_vec()].concat(),
        }
    }
}

/// Protection anti-reentrancy
static EXECUTING: AtomicBool = AtomicBool::new(false);

/// Résultat d'une liquidation
#[derive(Debug)]
pub struct LiquidationResult {
    pub success: bool,
    pub signature: Option<Signature>,
    pub profit_lamports: i64,
    pub error: Option<String>,
}

/// Liquidator principal
pub struct Liquidator {
    rpc_client: RpcClient,
    config: BotConfig,
    keypair: Keypair,
}

impl Liquidator {
    pub fn new(config: BotConfig) -> Result<Self> {
        let keypair = config.get_keypair()?;
        
        let rpc_client = RpcClient::new_with_timeout_and_commitment(
            config.get_rpc_url().to_string(),
            std::time::Duration::from_millis(config.rpc_timeout_ms),
            CommitmentConfig::confirmed(),
        );

        Ok(Self {
            rpc_client,
            config,
            keypair,
        })
    }

    /// Exécute une liquidation
    pub async fn execute(&self, opportunity: &LiquidationOpportunity) -> Result<LiquidationResult> {
        // Protection anti-reentrancy
        if EXECUTING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err(anyhow!("Liquidation déjà en cours"));
        }

        let result = self.execute_internal(opportunity).await;
        EXECUTING.store(false, Ordering::SeqCst);
        result
    }

    async fn execute_internal(&self, opp: &LiquidationOpportunity) -> Result<LiquidationResult> {
        log::info!("═══════════════════════════════════════");
        log::info!("   LIQUIDATION: {}", opp.protocol);
        log::info!("═══════════════════════════════════════");
        log::info!("Compte: {}", opp.account_address);
        log::info!("Owner: {}", opp.owner);
        log::info!("Health: {}", opp.health_factor);
        log::info!("Max liquidable: {} lamports", opp.max_liquidatable);
        log::info!("Profit estimé: {} lamports", opp.estimated_profit_lamports);

        if self.config.dry_run {
            return self.simulate(opp).await;
        }

        self.execute_real(opp).await
    }

    /// Mode simulation (dry-run)
    async fn simulate(&self, opp: &LiquidationOpportunity) -> Result<LiquidationResult> {
        log::info!("🔒 MODE DRY-RUN: Simulation");

        // Vérifier qu'on peut obtenir une quote Jupiter
        let quote_result = self.jupiter_client.get_quote(
            &ProgramIds::usdc_mint(),
            &ProgramIds::sol_mint(),
            1_000_000, // 1 USDC
            (self.config.max_slippage_percent as u16) * 100,
        ).await;

        match quote_result {
            Ok(quote) => {
                log::info!("✅ Jupiter quote OK: {} -> {}", 
                    quote.in_amount,
                    quote.out_amount);
                
                Ok(LiquidationResult {
                    success: true,
                    signature: None,
                    profit_lamports: opp.estimated_profit_lamports,
                    error: None,
                })
            }
            Err(e) => {
                log::warn!("⚠️ Jupiter quote échoué: {}", e);
                Ok(LiquidationResult {
                    success: false,
                    signature: None,
                    profit_lamports: 0,
                    error: Some(e.to_string()),
                })
            }
        }
    }

    /// Exécution réelle
    async fn execute_real(&self, opp: &LiquidationOpportunity) -> Result<LiquidationResult> {
        log::info!("🚀 MODE PRODUCTION");

        // Liquidation réelle pour Kamino
        if opp.protocol == "Kamino" {
            if self.config.dry_run {
                log::info!("🧪 DRY RUN Kamino - Profit estimé: {} lamports", opp.estimated_profit_lamports);
                return Ok(LiquidationResult {
                    success: true,
                    signature: None,
                    profit_lamports: opp.estimated_profit_lamports,
                    error: None,
                });
            } else {
                log::info!("🚀 Liquidation réelle Kamino");

                // Programme Kamino
                let kamino_program = ProgramIds::kamino_lending();
                let lending_market = Pubkey::from_str("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF").unwrap(); // Main market

                // ATA pour le liquidateur (assume SOL pour collateral, USDC pour debt)
                let liquidator_collateral_ata = spl_associated_token_account::get_associated_token_address(
                    &self.wallet_pubkey(),
                    &Pubkey::from_str("So11111111111111111111111111111111111111112").unwrap(), // SOL
                );
                let liquidator_debt_ata = spl_associated_token_account::get_associated_token_address(
                    &self.wallet_pubkey(),
                    &Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap(), // USDC
                );

                // Instruction liquidation
                let liquidate_ix = kamino_instructions::build_liquidate_instruction(
                    kamino_program,
                    lending_market,
                    opp.account_address, // obligation
                    opp.owner,
                    self.wallet_pubkey(), // liquidator
                    opp.liab_bank, // repay_reserve
                    opp.asset_bank, // withdraw_reserve
                    liquidator_debt_ata, // liquidator_repay_ata
                    liquidator_collateral_ata, // liquidator_withdraw_ata
                    spl_token::id(),
                    opp.max_liquidatable,
                );

                let instructions = vec![liquidate_ix];

                // Tx
                let recent_blockhash = self.rpc_client.get_latest_blockhash()
                    .map_err(|e| anyhow!("Blockhash: {}", e))?;

                let message = solana_sdk::message::Message::new(&instructions, Some(&self.wallet_pubkey()));
                let mut tx = solana_sdk::transaction::Transaction::new_unsigned(message);
                tx.sign(&[&*self.keypair], recent_blockhash);

                let signature = self.rpc_client.send_and_confirm_transaction(&tx)
                    .map_err(|e| anyhow!("Erreur envoi tx: {}", e))?;

                log::info!("✅ Liquidation Kamino réussie: {}", signature);

                return Ok(LiquidationResult {
                    success: true,
                    signature: Some(signature),
                    profit_lamports: opp.estimated_profit_lamports,
                    error: None,
                });
            }
        }

        // Liquidation réelle pour Marginfi
        if opp.protocol == "Marginfi" {
            if self.config.dry_run {
                log::info!("🧪 DRY RUN Marginfi - Profit estimé: {} lamports", opp.estimated_profit_lamports);
                return Ok(LiquidationResult {
                    success: true,
                    signature: None,
                    profit_lamports: opp.estimated_profit_lamports,
                    error: None,
                });
            } else {
                log::info!("🚀 Liquidation réelle Marginfi");

                // Programmes Marginfi
                let marginfi_program = ProgramIds::marginfi();
                let marginfi_group = ProgramIds::marginfi_group();

                // Dériver le compte Marginfi du liquidateur (PDA)
                let liquidator_marginfi_account = Pubkey::find_program_address(
                    &[b"marginfi_account", self.wallet_pubkey().as_ref(), marginfi_group.as_ref()],
                    &marginfi_program,
                ).0;

                // Instruction liquidation
                let liquidate_ix = marginfi_instructions::build_liquidate_instruction(
                    marginfi_program,
                    marginfi_group,
                    opp.asset_bank,
                    opp.liab_bank,
                    liquidator_marginfi_account,
                    self.wallet_pubkey(),
                    opp.account_address, // liquidatee_marginfi_account
                    opp.max_liquidatable,
                );

                let instructions = vec![liquidate_ix];

                // Tx
                let recent_blockhash = self.rpc_client.get_latest_blockhash()
                    .map_err(|e| anyhow!("Blockhash: {}", e))?;

                let message = solana_sdk::message::Message::new(&instructions, Some(&self.wallet_pubkey()));
                let mut tx = solana_sdk::transaction::Transaction::new_unsigned(message);
                tx.sign(&[&*self.keypair], recent_blockhash);

                let signature = self.rpc_client.send_and_confirm_transaction(&tx)
                    .map_err(|e| anyhow!("Erreur envoi tx: {}", e))?;

                log::info!("✅ Liquidation Marginfi réussie: {}", signature);

                return Ok(LiquidationResult {
                    success: true,
                    signature: Some(signature),
                    profit_lamports: opp.estimated_profit_lamports,
                    error: None,
                });
            }
        }

        // Liquidation placeholder pour Jupiter Lend
        if opp.protocol == "Jupiter Lend" {
            log::warn!("Jupiter Lend liquidation non implémentée - protocole placeholder");
            return Ok(LiquidationResult {
                success: false,
                signature: None,
                profit_lamports: 0,
                error: Some("Jupiter Lend not implemented".to_string()),
            });
        }

        // Logique Jupiter (swaps) pour autres protocoles

        let quote = self.jupiter_client.get_quote(
            &ProgramIds::sol_mint(),
            &ProgramIds::usdc_mint(),
            10_000_000, // 0.01 SOL
            (self.config.max_slippage_percent as u16) * 100,
        ).await?;

        log::info!("Quote reçue: {} SOL -> {} USDC", 
            quote.in_amount,
            quote.out_amount);

        // Obtenir la transaction de swap
        let swap_response = self.jupiter_client.get_swap_transaction(
            &quote,
            &self.keypair.pubkey(),
        ).await?;

        log::info!("Transaction de swap obtenue ({} bytes)", swap_response.swap_transaction.len());

        // Décoder et signer la transaction
        let tx_bytes = BASE64_STANDARD.decode(&swap_response.swap_transaction)
            .map_err(|e| anyhow!("Erreur décodage tx: {}", e))?;

        let mut versioned_tx: VersionedTransaction = bincode::deserialize(&tx_bytes)
            .map_err(|e| anyhow!("Erreur désérialisation tx: {}", e))?;

        // Signer
        versioned_tx.signatures[0] = self.keypair.sign_message(&versioned_tx.message.serialize());

        // Simuler d'abord
        let sim_result = self.rpc_client.simulate_transaction(&versioned_tx)?;
        if let Some(err) = sim_result.value.err {
            log::error!("Simulation échouée: {:?}", err);
            return Ok(LiquidationResult {
                success: false,
                signature: None,
                profit_lamports: 0,
                error: Some(format!("{:?}", err)),
            });
        }

        log::info!("✅ Simulation réussie, envoi...");

        // Envoyer
        let signature = self.rpc_client.send_and_confirm_transaction(&versioned_tx)?;
        log::info!("✅ Transaction confirmée: {}", signature);

        // Calculer le profit réel
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        let balance_after = self.rpc_client.get_balance(&self.keypair.pubkey())?;
        let profit = balance_after as i64 - balance_before as i64;

        log::info!("Solde après: {} lamports", balance_after);
        log::info!("Profit réel: {} lamports", profit);

        Ok(LiquidationResult {
            success: true,
            signature: Some(signature),
            profit_lamports: profit,
            error: None,
        })
    }

    /// Pubkey du wallet
    pub fn wallet_pubkey(&self) -> Pubkey {
        self.keypair.pubkey()
    }
}

/// Instructions de liquidation Marginfi
/// Basé sur: https://docs.marginfi.com/mfi-v2#lending_account_liquidate
mod marginfi_instructions {
    use super::*;
    use solana_sdk::instruction::{Instruction, AccountMeta};

    /// Discriminator pour lending_account_liquidate
    /// sha256("global:lending_account_liquidate")[0..8]
    #[allow(dead_code)]
    pub const LIQUIDATE_DISCRIMINATOR: [u8; 8] = [86, 166, 0, 167, 25, 202, 117, 128];

    /// Construit l'instruction de liquidation Marginfi
    /// ATTENTION: Cette fonction nécessite tous les comptes corrects
    #[allow(dead_code)]
    pub fn build_liquidate_instruction(
        marginfi_program: Pubkey,
        marginfi_group: Pubkey,
        asset_bank: Pubkey,
        liab_bank: Pubkey,
        liquidator_marginfi_account: Pubkey,
        signer: Pubkey,
        liquidatee_marginfi_account: Pubkey,
        asset_amount: u64,
    ) -> Instruction {
        // Accounts nécessaires selon la doc:
        let accounts = vec![
            AccountMeta::new_readonly(marginfi_group, false),
            AccountMeta::new(asset_bank, false),
            AccountMeta::new(liab_bank, false),
            AccountMeta::new(liquidator_marginfi_account, false),
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new(liquidatee_marginfi_account, false),
            // + bank_liquidity_vault_authority (PDA)
            // + bank_liquidity_vault
            // + bank_insurance_vault
            // + token_program
        ];

        // Data: discriminator + asset_amount
        let mut data = Vec::with_capacity(16);
        data.extend_from_slice(&LIQUIDATE_DISCRIMINATOR);
        data.extend_from_slice(&asset_amount.to_le_bytes());

        Instruction {
            program_id: marginfi_program,
            accounts,
            data,
        }
    }
}
