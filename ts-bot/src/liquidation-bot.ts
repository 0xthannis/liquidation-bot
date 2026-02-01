/**
 * Kamino Liquidation Bot v2.0
 * 
 * Monitors unhealthy obligations on Kamino Lending and executes liquidations.
 * Uses the official klend-sdk for proper transaction building.
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import { KaminoMarket, KaminoObligation, KaminoReserve, KaminoAction, PROGRAM_ID, VanillaObligation } from '@kamino-finance/klend-sdk';
import Decimal from 'decimal.js';

// SPL Token constants
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Helper to derive ATA address
function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

// Helper to create ATA instruction
function createAtaInstruction(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0),
  });
}

// Kamino Main Market - CORRECT ADDRESSES
const KAMINO_MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
// Use SDK's PROGRAM_ID which is correct: KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD

// Configuration
const CONFIG = {
  // Minimum profit in USD to execute liquidation
  MIN_PROFIT_USD: 0.5,
  // NO MAX - liquidate as much as possible
  // Scan interval in ms
  SCAN_INTERVAL_MS: 5000,
  // Liquidation bonus threshold (5% = positions with LTV > 95%)
  UNHEALTHY_LTV_THRESHOLD: 0.95,
};

// Stats
export const liquidationStats = {
  scans: 0,
  unhealthyFound: 0,
  liquidationsAttempted: 0,
  liquidationsSuccessful: 0,
  totalProfitUsd: 0,
  lastScanTime: 0,
};

export class LiquidationBot {
  private connection: Connection;
  private keypair: Keypair;
  private market: KaminoMarket | null = null;
  private isRunning = false;
  private scanInterval: NodeJS.Timeout | null = null;

  constructor(connection: Connection, keypair: Keypair) {
    this.connection = connection;
    this.keypair = keypair;
  }

  async initialize(): Promise<void> {
    console.log('🔄 Loading Kamino market...');
    
    this.market = await KaminoMarket.load(
      this.connection,
      KAMINO_MAIN_MARKET,
      undefined as any,
      PROGRAM_ID
    );

    if (!this.market) {
      throw new Error('Failed to load Kamino market');
    }

    await this.market.loadReserves();
    console.log(`✅ Kamino market loaded with ${this.market.reserves.size} reserves`);
    
    // Log available reserves
    console.log('📊 Available reserves:');
    for (const [address, reserve] of this.market.reserves) {
      const symbol = reserve.symbol || 'Unknown';
      console.log(`   - ${symbol} (${address.toString().slice(0, 8)}...)`);
    }
  }

  async start(): Promise<void> {
    if (!this.market) {
      throw new Error('Market not initialized. Call initialize() first.');
    }

    this.isRunning = true;
    console.log('\n🚀 Liquidation Bot started!');
    console.log(`   Min profit: $${CONFIG.MIN_PROFIT_USD}`);
    console.log(`   Max liquidation: UNLIMITED 💰`);
    console.log(`   Scan interval: ${CONFIG.SCAN_INTERVAL_MS / 1000}s`);
    console.log(`   LTV threshold: ${CONFIG.UNHEALTHY_LTV_THRESHOLD * 100}%\n`);

    // Initial scan
    await this.scanForLiquidations();

    // Start periodic scanning
    this.scanInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.scanForLiquidations();
      }
    }, CONFIG.SCAN_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    console.log('🛑 Liquidation Bot stopped');
  }

  private async scanForLiquidations(): Promise<void> {
    if (!this.market) return;

    liquidationStats.scans++;
    liquidationStats.lastScanTime = Date.now();

    try {
      // Refresh market data
      await this.market.loadReserves();

      // Get all obligations
      const obligations = await this.getAllObligations();
      
      console.log(`🔍 Scan #${liquidationStats.scans}: Checking ${obligations.length} obligations...`);

      let unhealthyCount = 0;

      for (const obligation of obligations) {
        try {
          const healthInfo = this.analyzeObligation(obligation);
          
          if (healthInfo.isLiquidatable) {
            unhealthyCount++;
            liquidationStats.unhealthyFound++;

            console.log(`\n💀 UNHEALTHY OBLIGATION FOUND!`);
            console.log(`   Owner: ${obligation.obligationAddress.toString().slice(0, 12)}...`);
            console.log(`   LTV: ${(healthInfo.ltv * 100).toFixed(2)}%`);
            console.log(`   Borrowed: $${healthInfo.borrowedValueUsd.toFixed(2)}`);
            console.log(`   Collateral: $${healthInfo.collateralValueUsd.toFixed(2)}`);
            console.log(`   Potential profit: $${healthInfo.potentialProfitUsd.toFixed(2)}`);

            if (healthInfo.potentialProfitUsd >= CONFIG.MIN_PROFIT_USD) {
              await this.executeLiquidation(obligation, healthInfo);
            } else {
              console.log(`   ⚠️ Profit too low, skipping`);
            }
          }
        } catch (err) {
          // Skip problematic obligations
        }
      }

      if (unhealthyCount === 0) {
        process.stdout.write(`   ✅ All obligations healthy\r`);
      }

    } catch (error) {
      console.error('Scan error:', error);
    }
  }

  private async getAllObligations(): Promise<KaminoObligation[]> {
    if (!this.market) return [];

    try {
      // Use SDK's method to get all obligations for the market
      // This is more reliable than manual getProgramAccounts
      const allObligations = await this.market.getAllObligationsForMarket();
      
      // Filter to only get obligations with borrows (potential liquidation targets)
      const obligationsWithBorrows = allObligations.filter(obl => 
        obl && obl.borrows && obl.borrows.size > 0
      );

      console.log(`   Found ${obligationsWithBorrows.length} obligations with active borrows`);
      
      return obligationsWithBorrows;
    } catch (error) {
      console.error('Error fetching obligations:', error);
      
      // Fallback: try getProgramAccounts without dataSize filter
      try {
        console.log('   Trying fallback method...');
        const obligationAccounts = await this.connection.getProgramAccounts(
          PROGRAM_ID,
          {
            filters: [
              {
                memcmp: {
                  offset: 8, // After discriminator
                  bytes: KAMINO_MAIN_MARKET.toBase58(),
                },
              },
            ],
          }
        );

        const obligations: KaminoObligation[] = [];
        const batchSize = 50;
        
        for (let i = 0; i < Math.min(obligationAccounts.length, 500); i += batchSize) {
          const batch = obligationAccounts.slice(i, i + batchSize);
          const results = await Promise.allSettled(
            batch.map(acc => this.market!.getObligationByAddress(acc.pubkey))
          );
          
          for (const result of results) {
            if (result.status === 'fulfilled' && result.value && result.value.borrows.size > 0) {
              obligations.push(result.value);
            }
          }
        }
        
        return obligations;
      } catch (fallbackError) {
        console.error('Fallback also failed:', fallbackError);
        return [];
      }
    }
  }

  private analyzeObligation(obligation: KaminoObligation): {
    isLiquidatable: boolean;
    ltv: number;
    borrowedValueUsd: number;
    collateralValueUsd: number;
    potentialProfitUsd: number;
    repayReserve: KaminoReserve | null;
    withdrawReserve: KaminoReserve | null;
    maxRepayAmount: Decimal;
  } {
    const stats = obligation.refreshedStats;
    
    const borrowedValueUsd = stats.userTotalBorrow?.toNumber() || 0;
    const collateralValueUsd = stats.userTotalDeposit?.toNumber() || 0;
    const borrowLimit = stats.borrowLimit?.toNumber() || 0;

    // Calculate LTV
    const ltv = collateralValueUsd > 0 ? borrowedValueUsd / collateralValueUsd : 0;

    // Check if liquidatable (borrowed > borrow limit means unhealthy)
    const isLiquidatable = borrowedValueUsd > borrowLimit && borrowedValueUsd > 0;

    // Calculate potential profit (liquidation bonus is typically 5%)
    const liquidationBonus = 0.05;
    const maxLiquidationAmount = borrowedValueUsd * 0.5; // Liquidate max 50% of debt (protocol limit)
    const potentialProfitUsd = maxLiquidationAmount * liquidationBonus;

    // Find best reserves to liquidate
    let repayReserve: KaminoReserve | null = null;
    let withdrawReserve: KaminoReserve | null = null;
    let maxRepayAmount = new Decimal(0);

    // Find the largest borrow position
    for (const [reserveAddress, borrowInfo] of obligation.borrows) {
      const reserve = this.market?.getReserveByAddress(reserveAddress);
      if (reserve && borrowInfo.amount.gt(maxRepayAmount)) {
        maxRepayAmount = borrowInfo.amount;
        repayReserve = reserve;
      }
    }

    // Find the largest deposit position
    let maxDepositAmount = new Decimal(0);
    for (const [reserveAddress, depositInfo] of obligation.deposits) {
      const reserve = this.market?.getReserveByAddress(reserveAddress);
      if (reserve && depositInfo.amount.gt(maxDepositAmount)) {
        maxDepositAmount = depositInfo.amount;
        withdrawReserve = reserve;
      }
    }

    return {
      isLiquidatable,
      ltv,
      borrowedValueUsd,
      collateralValueUsd,
      potentialProfitUsd,
      repayReserve,
      withdrawReserve,
      maxRepayAmount,
    };
  }

  private async executeLiquidation(
    obligation: KaminoObligation,
    healthInfo: {
      repayReserve: KaminoReserve | null;
      withdrawReserve: KaminoReserve | null;
      maxRepayAmount: Decimal;
      borrowedValueUsd: number;
    }
  ): Promise<void> {
    if (!this.market || !healthInfo.repayReserve || !healthInfo.withdrawReserve) {
      console.log('   ❌ Missing reserve info, cannot liquidate');
      return;
    }

    liquidationStats.liquidationsAttempted++;

    try {
      console.log(`\n⚡ EXECUTING LIQUIDATION...`);
      console.log(`   Repay: ${healthInfo.repayReserve.symbol}`);
      console.log(`   Withdraw: ${healthInfo.withdrawReserve.symbol}`);

      // Calculate liquidation amount (50% of debt - protocol max)
      const repayAmount = healthInfo.maxRepayAmount.div(2);
      const decimals = healthInfo.repayReserve.stats.decimals;
      const repayAmountLamports = repayAmount.mul(new Decimal(10).pow(decimals)).floor();

      // Get token addresses
      const repayMint = healthInfo.repayReserve.getLiquidityMint();
      const liquidatorRepayAta = getAssociatedTokenAddress(repayMint, this.keypair.publicKey);
      const collateralMint = healthInfo.withdrawReserve.getLiquidityMint();
      const liquidatorCollateralAta = getAssociatedTokenAddress(collateralMint, this.keypair.publicKey);

      // CHECK WALLET BALANCE before proceeding
      const repayAtaInfo = await this.connection.getAccountInfo(liquidatorRepayAta);
      if (repayAtaInfo) {
        // Parse token account to get balance
        const balance = repayAtaInfo.data.readBigUInt64LE(64); // Token balance at offset 64
        const requiredAmount = BigInt(repayAmountLamports.toNumber());
        
        if (balance < requiredAmount) {
          const balanceHuman = Number(balance) / Math.pow(10, decimals);
          const requiredHuman = repayAmountLamports.toNumber() / Math.pow(10, decimals);
          console.log(`   ❌ Insufficient ${healthInfo.repayReserve.symbol} balance`);
          console.log(`      Have: ${balanceHuman.toFixed(4)} | Need: ${requiredHuman.toFixed(4)}`);
          return;
        }
        console.log(`   ✅ Balance check passed`);
      } else {
        console.log(`   ❌ No ${healthInfo.repayReserve.symbol} token account found`);
        console.log(`   💡 You need ${healthInfo.repayReserve.symbol} tokens to liquidate`);
        return;
      }

      // Build liquidation transaction
      const tx = new Transaction();

      const collateralAtaInfo = await this.connection.getAccountInfo(liquidatorCollateralAta);
      if (!collateralAtaInfo) {
        tx.add(createAtaInstruction(
          this.keypair.publicKey,
          liquidatorCollateralAta,
          this.keypair.publicKey,
          collateralMint
        ));
      }

      // Build liquidation instruction using klend-sdk
      const liquidateIx = await this.buildLiquidateInstruction(
        obligation,
        healthInfo.repayReserve,
        healthInfo.withdrawReserve,
        repayAmountLamports.toNumber(),
        liquidatorRepayAta,
        liquidatorCollateralAta
      );

      if (liquidateIx) {
        tx.add(liquidateIx);

        // Get recent blockhash
        const { blockhash } = await this.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.keypair.publicKey;

        // Sign and send
        const signature = await sendAndConfirmTransaction(
          this.connection,
          tx,
          [this.keypair],
          { commitment: 'confirmed' }
        );

        liquidationStats.liquidationsSuccessful++;
        liquidationStats.totalProfitUsd += healthInfo.borrowedValueUsd * 0.05 * 0.5; // Approximate profit

        console.log(`   ✅ LIQUIDATION SUCCESSFUL!`);
        console.log(`   📝 Signature: ${signature}`);
        console.log(`   💰 Estimated profit: $${(healthInfo.borrowedValueUsd * 0.05 * 0.5).toFixed(2)}`);
      }

    } catch (error: any) {
      console.log(`   ❌ Liquidation failed: ${error.message}`);
      
      // Common failure reasons
      if (error.message.includes('insufficient funds')) {
        console.log('   💡 Need more funds in wallet to repay debt');
      } else if (error.message.includes('healthy')) {
        console.log('   💡 Obligation became healthy before liquidation');
      }
    }
  }

  private async buildLiquidateInstruction(
    obligation: KaminoObligation,
    repayReserve: KaminoReserve,
    withdrawReserve: KaminoReserve,
    liquidityAmount: number,
    liquidatorRepayAta: PublicKey,
    liquidatorCollateralAta: PublicKey
  ): Promise<TransactionInstruction | null> {
    if (!this.market) return null;

    // Build the liquidateObligationAndRedeemReserveCollateral instruction
    // This is the main liquidation instruction in Kamino
    
    const keys = [
      // Liquidator (signer)
      { pubkey: this.keypair.publicKey, isSigner: true, isWritable: true },
      // Obligation to liquidate
      { pubkey: obligation.obligationAddress, isSigner: false, isWritable: true },
      // Lending market
      { pubkey: KAMINO_MAIN_MARKET, isSigner: false, isWritable: false },
      // Lending market authority
      { pubkey: this.market.getLendingMarketAuthority(), isSigner: false, isWritable: false },
      // Repay reserve
      { pubkey: repayReserve.address, isSigner: false, isWritable: true },
      // Repay reserve liquidity mint
      { pubkey: repayReserve.getLiquidityMint(), isSigner: false, isWritable: false },
      // Repay reserve liquidity supply
      { pubkey: repayReserve.state.liquidity.supplyVault, isSigner: false, isWritable: true },
      // Withdraw reserve
      { pubkey: withdrawReserve.address, isSigner: false, isWritable: true },
      // Withdraw reserve collateral mint
      { pubkey: withdrawReserve.getCTokenMint(), isSigner: false, isWritable: true },
      // Withdraw reserve collateral supply
      { pubkey: withdrawReserve.state.collateral.supplyVault, isSigner: false, isWritable: true },
      // Withdraw reserve liquidity supply
      { pubkey: withdrawReserve.state.liquidity.supplyVault, isSigner: false, isWritable: true },
      // Withdraw reserve liquidity fee receiver
      { pubkey: withdrawReserve.state.liquidity.feeVault, isSigner: false, isWritable: true },
      // Liquidator repay token account
      { pubkey: liquidatorRepayAta, isSigner: false, isWritable: true },
      // Liquidator receive token account (for collateral)
      { pubkey: liquidatorCollateralAta, isSigner: false, isWritable: true },
      // Token program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    // Instruction discriminator for liquidateObligationAndRedeemReserveCollateral
    const discriminator = Buffer.from([177, 35, 54, 38, 45, 188, 58, 175]); // From IDL
    
    // Encode liquidity amount as u64
    const data = Buffer.alloc(8 + 8);
    discriminator.copy(data, 0);
    data.writeBigUInt64LE(BigInt(liquidityAmount), 8);

    return new TransactionInstruction({
      keys,
      programId: PROGRAM_ID,
      data,
    });
  }

  getStats() {
    return { ...liquidationStats };
  }

  logStats(): void {
    console.log('\n═══════════════════════════════════════════════');
    console.log('           LIQUIDATION BOT STATS              ');
    console.log('═══════════════════════════════════════════════');
    console.log(`Scans:              ${liquidationStats.scans}`);
    console.log(`Unhealthy found:    ${liquidationStats.unhealthyFound}`);
    console.log(`Liquidations tried: ${liquidationStats.liquidationsAttempted}`);
    console.log(`Liquidations OK:    ${liquidationStats.liquidationsSuccessful}`);
    console.log(`Total profit:       $${liquidationStats.totalProfitUsd.toFixed(2)}`);
    console.log('═══════════════════════════════════════════════\n');
  }
}

export default LiquidationBot;
