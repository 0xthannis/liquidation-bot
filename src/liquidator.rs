//! Liquidator - Exécute les liquidations avec Flash Loans Kamino
//! Basé sur la documentation officielle: https://docs.kamino.finance/

use anyhow::{Result, anyhow};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signature},
    commitment_config::CommitmentConfig,
    signer::Signer,
    instruction::{Instruction, AccountMeta},
};
use solana_client::rpc_client::RpcClient;
use std::sync::atomic::{AtomicBool, Ordering};
use std::str::FromStr;

use crate::config::{BotConfig, ProgramIds};
use crate::utils::LiquidationOpportunity;

/// Instructions Kamino Lending (KLend)
/// Discriminators calculés via sha256("global:<instruction_name>")[0..8]
mod kamino_instructions {
    use super::*;

    /// Programme Kamino Lending
    pub const KAMINO_PROGRAM: &str = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
    
    /// Discriminator pour flash_borrow_reserve_liquidity
    /// sha256("global:flash_borrow_reserve_liquidity")[0..8]
    pub const FLASH_BORROW_DISCRIMINATOR: [u8; 8] = [0x87, 0xe7, 0x34, 0xa7, 0x07, 0x34, 0xd4, 0xc1];
    
    /// Discriminator pour flash_repay_reserve_liquidity
    /// sha256("global:flash_repay_reserve_liquidity")[0..8]
    pub const FLASH_REPAY_DISCRIMINATOR: [u8; 8] = [0xb9, 0x75, 0x00, 0xcb, 0x60, 0xf5, 0xb4, 0xba];
    
    /// Discriminator pour liquidate_obligation_and_redeem_reserve_collateral
    /// sha256("global:liquidate_obligation_and_redeem_reserve_collateral")[0..8]
    pub const LIQUIDATE_DISCRIMINATOR: [u8; 8] = [0xb1, 0x47, 0x9a, 0xbc, 0xe2, 0x85, 0x4a, 0x37];

    /// Construit l'instruction flash_borrow_reserve_liquidity
    /// Emprunte des tokens sans collateral, à rembourser dans la même tx
    pub fn build_flash_borrow_ix(
        lending_market: Pubkey,
        lending_market_authority: Pubkey,
        reserve: Pubkey,
        reserve_liquidity_mint: Pubkey,
        reserve_source_liquidity: Pubkey,
        user_destination_liquidity: Pubkey,
        referrer_token_state: Option<Pubkey>,
        referrer_account: Option<Pubkey>,
        sysvar_info: Pubkey,
        token_program: Pubkey,
        amount: u64,
    ) -> Instruction {
        let kamino_program = Pubkey::from_str(KAMINO_PROGRAM).unwrap();
        
        let mut accounts = vec![
            AccountMeta::new_readonly(lending_market, false),
            AccountMeta::new_readonly(lending_market_authority, false),
            AccountMeta::new(reserve, false),
            AccountMeta::new_readonly(reserve_liquidity_mint, false),
            AccountMeta::new(reserve_source_liquidity, false),
            AccountMeta::new(user_destination_liquidity, false),
        ];
        
        // Referrer accounts (optional)
        if let Some(ref_state) = referrer_token_state {
            accounts.push(AccountMeta::new(ref_state, false));
        }
        if let Some(ref_acc) = referrer_account {
            accounts.push(AccountMeta::new(ref_acc, false));
        }
        
        accounts.push(AccountMeta::new_readonly(sysvar_info, false));
        accounts.push(AccountMeta::new_readonly(token_program, false));

        let mut data = Vec::with_capacity(16);
        data.extend_from_slice(&FLASH_BORROW_DISCRIMINATOR);
        data.extend_from_slice(&amount.to_le_bytes());

        Instruction {
            program_id: kamino_program,
            accounts,
            data,
        }
    }

    /// Construit l'instruction flash_repay_reserve_liquidity
    /// Rembourse le flash loan + frais (0.09%)
    pub fn build_flash_repay_ix(
        user_source_liquidity: Pubkey,
        reserve_destination_liquidity: Pubkey,
        reserve_liquidity_fee_receiver: Pubkey,
        referrer_token_state: Option<Pubkey>,
        referrer_account: Option<Pubkey>,
        reserve: Pubkey,
        lending_market: Pubkey,
        user_transfer_authority: Pubkey,
        sysvar_info: Pubkey,
        token_program: Pubkey,
        amount: u64,
        borrow_instruction_index: u8,
    ) -> Instruction {
        let kamino_program = Pubkey::from_str(KAMINO_PROGRAM).unwrap();
        
        let mut accounts = vec![
            AccountMeta::new(user_source_liquidity, false),
            AccountMeta::new(reserve_destination_liquidity, false),
            AccountMeta::new(reserve_liquidity_fee_receiver, false),
        ];
        
        if let Some(ref_state) = referrer_token_state {
            accounts.push(AccountMeta::new(ref_state, false));
        }
        if let Some(ref_acc) = referrer_account {
            accounts.push(AccountMeta::new(ref_acc, false));
        }
        
        accounts.extend_from_slice(&[
            AccountMeta::new(reserve, false),
            AccountMeta::new_readonly(lending_market, false),
            AccountMeta::new_readonly(user_transfer_authority, true),
            AccountMeta::new_readonly(sysvar_info, false),
            AccountMeta::new_readonly(token_program, false),
        ]);

        let mut data = Vec::with_capacity(17);
        data.extend_from_slice(&FLASH_REPAY_DISCRIMINATOR);
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(borrow_instruction_index);

        Instruction {
            program_id: kamino_program,
            accounts,
            data,
        }
    }

    /// Construit l'instruction liquidate_obligation_and_redeem_reserve_collateral
    /// Liquide une position et récupère le collateral
    pub fn build_liquidate_ix(
        liquidator: Pubkey,
        obligation: Pubkey,
        lending_market: Pubkey,
        lending_market_authority: Pubkey,
        repay_reserve: Pubkey,
        repay_reserve_liquidity_mint: Pubkey,
        repay_reserve_liquidity_supply: Pubkey,
        withdraw_reserve: Pubkey,
        withdraw_reserve_collateral_mint: Pubkey,
        withdraw_reserve_collateral_supply: Pubkey,
        withdraw_reserve_liquidity_supply: Pubkey,
        withdraw_reserve_liquidity_fee_receiver: Pubkey,
        user_source_liquidity: Pubkey,
        user_destination_collateral: Pubkey,
        user_destination_liquidity: Pubkey,
        token_program: Pubkey,
        sysvar_info: Pubkey,
        liquidity_amount: u64,
        min_acceptable_received_collateral_amount: u64,
        max_allowed_ltv_override_percent: u64,
    ) -> Instruction {
        let kamino_program = Pubkey::from_str(KAMINO_PROGRAM).unwrap();
        
        let accounts = vec![
            AccountMeta::new(liquidator, true),
            AccountMeta::new(obligation, false),
            AccountMeta::new_readonly(lending_market, false),
            AccountMeta::new_readonly(lending_market_authority, false),
            AccountMeta::new(repay_reserve, false),
            AccountMeta::new_readonly(repay_reserve_liquidity_mint, false),
            AccountMeta::new(repay_reserve_liquidity_supply, false),
            AccountMeta::new(withdraw_reserve, false),
            AccountMeta::new_readonly(withdraw_reserve_collateral_mint, false),
            AccountMeta::new(withdraw_reserve_collateral_supply, false),
            AccountMeta::new(withdraw_reserve_liquidity_supply, false),
            AccountMeta::new(withdraw_reserve_liquidity_fee_receiver, false),
            AccountMeta::new(user_source_liquidity, false),
            AccountMeta::new(user_destination_collateral, false),
            AccountMeta::new(user_destination_liquidity, false),
            AccountMeta::new_readonly(token_program, false),
            AccountMeta::new_readonly(sysvar_info, false),
        ];

        let mut data = Vec::with_capacity(32);
        data.extend_from_slice(&LIQUIDATE_DISCRIMINATOR);
        data.extend_from_slice(&liquidity_amount.to_le_bytes());
        data.extend_from_slice(&min_acceptable_received_collateral_amount.to_le_bytes());
        data.extend_from_slice(&max_allowed_ltv_override_percent.to_le_bytes());

        Instruction {
            program_id: kamino_program,
            accounts,
            data,
        }
    }

    /// Dérive le Lending Market Authority PDA
    pub fn derive_lending_market_authority(lending_market: &Pubkey) -> Pubkey {
        let kamino_program = Pubkey::from_str(KAMINO_PROGRAM).unwrap();
        Pubkey::find_program_address(
            &[b"lma", lending_market.as_ref()],
            &kamino_program,
        ).0
    }
}

/// Instructions Marginfi
mod marginfi_instructions {
    use super::*;

    /// Programme Marginfi v2
    pub const MARGINFI_PROGRAM: &str = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
    
    /// Discriminator pour lending_account_liquidate
    /// sha256("global:lending_account_liquidate")[0..8]
    pub const LIQUIDATE_DISCRIMINATOR: [u8; 8] = [86, 166, 0, 167, 25, 202, 117, 128];

    /// Construit l'instruction de liquidation Marginfi
    pub fn build_liquidate_ix(
        marginfi_group: Pubkey,
        asset_bank: Pubkey,
        liab_bank: Pubkey,
        liquidator_marginfi_account: Pubkey,
        signer: Pubkey,
        liquidatee_marginfi_account: Pubkey,
        bank_liquidity_vault_authority: Pubkey,
        bank_liquidity_vault: Pubkey,
        bank_insurance_vault: Pubkey,
        token_program: Pubkey,
        asset_amount: u64,
    ) -> Instruction {
        let marginfi_program = Pubkey::from_str(MARGINFI_PROGRAM).unwrap();
        
        let accounts = vec![
            AccountMeta::new_readonly(marginfi_group, false),
            AccountMeta::new(asset_bank, false),
            AccountMeta::new(liab_bank, false),
            AccountMeta::new(liquidator_marginfi_account, false),
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new(liquidatee_marginfi_account, false),
            AccountMeta::new_readonly(bank_liquidity_vault_authority, false),
            AccountMeta::new(bank_liquidity_vault, false),
            AccountMeta::new(bank_insurance_vault, false),
            AccountMeta::new_readonly(token_program, false),
        ];

        let mut data = Vec::with_capacity(16);
        data.extend_from_slice(&LIQUIDATE_DISCRIMINATOR);
        data.extend_from_slice(&asset_amount.to_le_bytes());

        Instruction {
            program_id: marginfi_program,
            accounts,
            data,
        }
    }

    /// Dérive le compte Marginfi d'un utilisateur (PDA)
    pub fn derive_marginfi_account(user: &Pubkey, group: &Pubkey) -> Pubkey {
        let marginfi_program = Pubkey::from_str(MARGINFI_PROGRAM).unwrap();
        Pubkey::find_program_address(
            &[b"marginfi_account", user.as_ref(), group.as_ref()],
            &marginfi_program,
        ).0
    }

    /// Dérive le vault authority d'une bank
    pub fn derive_bank_vault_authority(bank: &Pubkey) -> Pubkey {
        let marginfi_program = Pubkey::from_str(MARGINFI_PROGRAM).unwrap();
        Pubkey::find_program_address(
            &[b"liquidity_vault_auth", bank.as_ref()],
            &marginfi_program,
        ).0
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
        if EXECUTING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err(anyhow!("Liquidation already in progress"));
        }

        let result = self.execute_internal(opportunity).await;
        EXECUTING.store(false, Ordering::SeqCst);
        result
    }

    async fn execute_internal(&self, opp: &LiquidationOpportunity) -> Result<LiquidationResult> {
        log::info!("═══════════════════════════════════════");
        log::info!("   LIQUIDATION: {}", opp.protocol);
        log::info!("═══════════════════════════════════════");
        log::info!("Account: {}", opp.account_address);
        log::info!("Owner: {}", opp.owner);
        log::info!("Health: {}", opp.health_factor);
        log::info!("Max liquidatable: {} lamports", opp.max_liquidatable);
        log::info!("Estimated profit: {} lamports", opp.estimated_profit_lamports);

        if self.config.dry_run {
            return self.simulate(opp).await;
        }

        self.execute_real(opp).await
    }

    /// Mode simulation (dry-run)
    async fn simulate(&self, opp: &LiquidationOpportunity) -> Result<LiquidationResult> {
        log::info!("DRY-RUN MODE: Simulation only");

        Ok(LiquidationResult {
            success: true,
            signature: None,
            profit_lamports: opp.estimated_profit_lamports,
            error: None,
        })
    }

    /// Exécution réelle avec flash loans Kamino
    async fn execute_real(&self, opp: &LiquidationOpportunity) -> Result<LiquidationResult> {
        log::info!("PRODUCTION MODE: Executing liquidation");

        let balance_before = self.rpc_client.get_balance(&self.keypair.pubkey())?;

        let result = match opp.protocol.as_str() {
            "Kamino" => self.execute_kamino_liquidation(opp).await,
            "Marginfi" => self.execute_marginfi_liquidation(opp).await,
            _ => {
                log::warn!("Unsupported protocol: {}", opp.protocol);
                Ok(LiquidationResult {
                    success: false,
                    signature: None,
                    profit_lamports: 0,
                    error: Some(format!("Unsupported protocol: {}", opp.protocol)),
                })
            }
        };

        // Calculate real profit
        if let Ok(ref liq_result) = result {
            if liq_result.success {
                let balance_after = self.rpc_client.get_balance(&self.keypair.pubkey())?;
                let real_profit = balance_after as i64 - balance_before as i64;
                log::info!("Real profit: {} lamports ({:.6} SOL)", real_profit, real_profit as f64 / 1e9);
            }
        }

        result
    }

    /// Liquidation Kamino avec Flash Loan
    async fn execute_kamino_liquidation(&self, opp: &LiquidationOpportunity) -> Result<LiquidationResult> {
        log::info!("Executing Kamino liquidation with flash loan");

        // Kamino Main Market
        let lending_market = Pubkey::from_str("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF")?;
        let lending_market_authority = kamino_instructions::derive_lending_market_authority(&lending_market);

        // Token program
        let token_program = spl_token::id();
        let sysvar_instructions = solana_sdk::sysvar::instructions::id();

        // Derive ATAs for liquidator
        let liquidator_repay_ata = spl_associated_token_account::get_associated_token_address(
            &self.keypair.pubkey(),
            &opp.liab_mint,
        );
        let liquidator_collateral_ata = spl_associated_token_account::get_associated_token_address(
            &self.keypair.pubkey(),
            &opp.asset_mint,
        );

        // Reserve liquidity vaults (derived from reserve accounts)
        // Note: In production, these should be fetched from on-chain reserve data
        let repay_reserve_liquidity_supply = self.derive_reserve_liquidity_supply(&opp.liab_bank)?;
        let withdraw_reserve_liquidity_supply = self.derive_reserve_liquidity_supply(&opp.asset_bank)?;
        let withdraw_reserve_collateral_supply = self.derive_reserve_collateral_supply(&opp.asset_bank)?;
        let withdraw_reserve_fee_receiver = self.derive_reserve_fee_receiver(&opp.asset_bank)?;

        // Flash loan amount = debt to repay + 0.1% buffer for fees
        let flash_loan_amount = (opp.liab_amount as f64 * 1.001) as u64;

        // Build instructions:
        // 1. Flash Borrow (get tokens to repay debt)
        let flash_borrow_ix = kamino_instructions::build_flash_borrow_ix(
            lending_market,
            lending_market_authority,
            opp.liab_bank, // reserve
            opp.liab_mint,
            repay_reserve_liquidity_supply,
            liquidator_repay_ata,
            None, // no referrer
            None,
            sysvar_instructions,
            token_program,
            flash_loan_amount,
        );

        // 2. Liquidate obligation (repay debt, get collateral)
        let liquidate_ix = kamino_instructions::build_liquidate_ix(
            self.keypair.pubkey(),
            opp.account_address, // obligation
            lending_market,
            lending_market_authority,
            opp.liab_bank, // repay_reserve
            opp.liab_mint,
            repay_reserve_liquidity_supply,
            opp.asset_bank, // withdraw_reserve
            opp.asset_mint,
            withdraw_reserve_collateral_supply,
            withdraw_reserve_liquidity_supply,
            withdraw_reserve_fee_receiver,
            liquidator_repay_ata,
            liquidator_collateral_ata,
            liquidator_collateral_ata, // destination liquidity (same as collateral for redeem)
            token_program,
            sysvar_instructions,
            opp.liab_amount, // liquidity_amount
            1, // min_acceptable_received (1 = accept any)
            0, // max_allowed_ltv_override (0 = no override)
        );

        // 3. Flash Repay (repay flash loan with proceeds)
        let flash_repay_ix = kamino_instructions::build_flash_repay_ix(
            liquidator_repay_ata,
            repay_reserve_liquidity_supply,
            withdraw_reserve_fee_receiver,
            None,
            None,
            opp.liab_bank,
            lending_market,
            self.keypair.pubkey(),
            sysvar_instructions,
            token_program,
            flash_loan_amount,
            0, // borrow_instruction_index = 0 (first instruction)
        );

        let instructions = vec![flash_borrow_ix, liquidate_ix, flash_repay_ix];

        // Simulate first
        let recent_blockhash = self.rpc_client.get_latest_blockhash()?;
        let message = solana_sdk::message::Message::new(&instructions, Some(&self.keypair.pubkey()));
        let mut tx = solana_sdk::transaction::Transaction::new_unsigned(message);
        tx.sign(&[&self.keypair], recent_blockhash);

        // Simulate transaction
        match self.rpc_client.simulate_transaction(&tx) {
            Ok(sim_result) => {
                if let Some(err) = sim_result.value.err {
                    log::error!("Simulation failed: {:?}", err);
                    return Ok(LiquidationResult {
                        success: false,
                        signature: None,
                        profit_lamports: 0,
                        error: Some(format!("Simulation failed: {:?}", err)),
                    });
                }
                log::info!("Simulation successful, sending transaction...");
            }
            Err(e) => {
                log::error!("Simulation error: {}", e);
                return Ok(LiquidationResult {
                    success: false,
                    signature: None,
                    profit_lamports: 0,
                    error: Some(format!("Simulation error: {}", e)),
                });
            }
        }

        // Send transaction
        match self.rpc_client.send_and_confirm_transaction(&tx) {
            Ok(signature) => {
                log::info!("Kamino liquidation successful: {}", signature);
                Ok(LiquidationResult {
                    success: true,
                    signature: Some(signature),
                    profit_lamports: opp.estimated_profit_lamports,
                    error: None,
                })
            }
            Err(e) => {
                log::error!("Transaction failed: {}", e);
                Ok(LiquidationResult {
                    success: false,
                    signature: None,
                    profit_lamports: 0,
                    error: Some(format!("Transaction failed: {}", e)),
                })
            }
        }
    }

    /// Liquidation Marginfi
    async fn execute_marginfi_liquidation(&self, opp: &LiquidationOpportunity) -> Result<LiquidationResult> {
        log::info!("Executing Marginfi liquidation");

        let marginfi_group = ProgramIds::marginfi_group();
        let token_program = spl_token::id();

        // Derive accounts
        let liquidator_marginfi_account = marginfi_instructions::derive_marginfi_account(
            &self.keypair.pubkey(),
            &marginfi_group,
        );
        let bank_vault_authority = marginfi_instructions::derive_bank_vault_authority(&opp.asset_bank);
        
        // These need to be fetched from on-chain bank data
        let bank_liquidity_vault = self.derive_bank_liquidity_vault(&opp.asset_bank)?;
        let bank_insurance_vault = self.derive_bank_insurance_vault(&opp.asset_bank)?;

        let liquidate_ix = marginfi_instructions::build_liquidate_ix(
            marginfi_group,
            opp.asset_bank,
            opp.liab_bank,
            liquidator_marginfi_account,
            self.keypair.pubkey(),
            opp.account_address,
            bank_vault_authority,
            bank_liquidity_vault,
            bank_insurance_vault,
            token_program,
            opp.max_liquidatable,
        );

        let instructions = vec![liquidate_ix];

        let recent_blockhash = self.rpc_client.get_latest_blockhash()?;
        let message = solana_sdk::message::Message::new(&instructions, Some(&self.keypair.pubkey()));
        let mut tx = solana_sdk::transaction::Transaction::new_unsigned(message);
        tx.sign(&[&self.keypair], recent_blockhash);

        // Simulate first
        match self.rpc_client.simulate_transaction(&tx) {
            Ok(sim_result) => {
                if let Some(err) = sim_result.value.err {
                    log::error!("Simulation failed: {:?}", err);
                    return Ok(LiquidationResult {
                        success: false,
                        signature: None,
                        profit_lamports: 0,
                        error: Some(format!("Simulation failed: {:?}", err)),
                    });
                }
            }
            Err(e) => {
                return Ok(LiquidationResult {
                    success: false,
                    signature: None,
                    profit_lamports: 0,
                    error: Some(format!("Simulation error: {}", e)),
                });
            }
        }

        match self.rpc_client.send_and_confirm_transaction(&tx) {
            Ok(signature) => {
                log::info!("Marginfi liquidation successful: {}", signature);
                Ok(LiquidationResult {
                    success: true,
                    signature: Some(signature),
                    profit_lamports: opp.estimated_profit_lamports,
                    error: None,
                })
            }
            Err(e) => {
                log::error!("Transaction failed: {}", e);
                Ok(LiquidationResult {
                    success: false,
                    signature: None,
                    profit_lamports: 0,
                    error: Some(format!("Transaction failed: {}", e)),
                })
            }
        }
    }

    /// Derive reserve liquidity supply vault (PDA)
    fn derive_reserve_liquidity_supply(&self, reserve: &Pubkey) -> Result<Pubkey> {
        let kamino_program = Pubkey::from_str(kamino_instructions::KAMINO_PROGRAM)?;
        Ok(Pubkey::find_program_address(
            &[b"liquidity", reserve.as_ref()],
            &kamino_program,
        ).0)
    }

    /// Derive reserve collateral supply vault (PDA)
    fn derive_reserve_collateral_supply(&self, reserve: &Pubkey) -> Result<Pubkey> {
        let kamino_program = Pubkey::from_str(kamino_instructions::KAMINO_PROGRAM)?;
        Ok(Pubkey::find_program_address(
            &[b"collateral", reserve.as_ref()],
            &kamino_program,
        ).0)
    }

    /// Derive reserve fee receiver (PDA)
    fn derive_reserve_fee_receiver(&self, reserve: &Pubkey) -> Result<Pubkey> {
        let kamino_program = Pubkey::from_str(kamino_instructions::KAMINO_PROGRAM)?;
        Ok(Pubkey::find_program_address(
            &[b"fee_receiver", reserve.as_ref()],
            &kamino_program,
        ).0)
    }

    /// Derive bank liquidity vault for Marginfi
    fn derive_bank_liquidity_vault(&self, bank: &Pubkey) -> Result<Pubkey> {
        let marginfi_program = Pubkey::from_str(marginfi_instructions::MARGINFI_PROGRAM)?;
        Ok(Pubkey::find_program_address(
            &[b"liquidity_vault", bank.as_ref()],
            &marginfi_program,
        ).0)
    }

    /// Derive bank insurance vault for Marginfi
    fn derive_bank_insurance_vault(&self, bank: &Pubkey) -> Result<Pubkey> {
        let marginfi_program = Pubkey::from_str(marginfi_instructions::MARGINFI_PROGRAM)?;
        Ok(Pubkey::find_program_address(
            &[b"insurance_vault", bank.as_ref()],
            &marginfi_program,
        ).0)
    }

    /// Pubkey du wallet
    pub fn wallet_pubkey(&self) -> Pubkey {
        self.keypair.pubkey()
    }
}
