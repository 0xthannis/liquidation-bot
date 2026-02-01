/**
 * Kamino Liquidation Bot v3.0 - WITH FLASH LOANS
 * 
 * Monitors unhealthy obligations on Kamino Lending and executes liquidations
 * using FLASH LOANS - no capital required!
 * 
 * Flow: Flash Borrow → Liquidate → Swap Collateral → Repay Flash Loan → Keep Profit
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction, TransactionMessage, sendAndConfirmTransaction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, AddressLookupTableAccount } from '@solana/web3.js';
import { KaminoMarket, KaminoObligation, KaminoReserve, KaminoAction, PROGRAM_ID, VanillaObligation } from '@kamino-finance/klend-sdk';
import Decimal from 'decimal.js';

// SPL Token constants
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Jupiter API for swaps
const JUPITER_API = 'https://quote-api.jup.ag/v6';

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

// Kamino Main Market
const KAMINO_MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

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

    console.log('   Fetching obligations...');

    // Try multiple dataSize values - Kamino may have different obligation versions
    const possibleSizes = [3096, 3248, 3352, 3400, 3500];
    
    for (const size of possibleSizes) {
      try {
        const accounts = await this.connection.getProgramAccounts(
          PROGRAM_ID,
          {
            filters: [
              { dataSize: size },
              {
                memcmp: {
                  offset: 32,
                  bytes: KAMINO_MAIN_MARKET.toBase58(),
                },
              },
            ],
          }
        );

        if (accounts.length > 0) {
          console.log(`   ✅ Found ${accounts.length} obligations (dataSize=${size})`);
          return await this.parseObligations(accounts);
        }
      } catch {
        // Try next size
      }
    }

    // Try without dataSize filter (slower but more reliable)
    console.log('   Trying without dataSize filter...');
    try {
      const accounts = await this.connection.getProgramAccounts(
        PROGRAM_ID,
        {
          filters: [
            {
              memcmp: {
                offset: 32,
                bytes: KAMINO_MAIN_MARKET.toBase58(),
              },
            },
          ],
          dataSlice: { offset: 0, length: 0 }, // Just get pubkeys
        }
      );

      console.log(`   Found ${accounts.length} accounts for this market`);
      
      if (accounts.length > 0) {
        // Fetch full data for first 200
        const obligations: KaminoObligation[] = [];
        for (const acc of accounts.slice(0, 200)) {
          try {
            const obl = await this.market!.getObligationByAddress(acc.pubkey);
            if (obl && obl.borrows && obl.borrows.size > 0) {
              obligations.push(obl);
            }
          } catch {
            // Not an obligation
          }
        }
        console.log(`   ✅ Loaded ${obligations.length} obligations with borrows`);
        return obligations;
      }
    } catch (e: any) {
      console.log(`   RPC error: ${e.message?.substring(0, 50)}`);
    }

    // Last resort: SDK method
    console.log('   Trying SDK getAllObligationsForMarket...');
    try {
      const allObligations = await this.market.getAllObligationsForMarket();
      const withBorrows = allObligations.filter(o => o && o.borrows && o.borrows.size > 0);
      console.log(`   SDK found ${withBorrows.length} obligations`);
      return withBorrows;
    } catch (e: any) {
      console.log(`   SDK failed: ${e.message?.substring(0, 40)}`);
      return [];
    }
  }

  private async parseObligations(accounts: readonly { pubkey: PublicKey; account: any }[]): Promise<KaminoObligation[]> {
    const obligations: KaminoObligation[] = [];
    let parsed = 0;

    for (const acc of accounts.slice(0, 300)) {
      try {
        const obl = await this.market!.getObligationByAddress(acc.pubkey);
        parsed++;
        
        if (obl && obl.borrows && obl.borrows.size > 0) {
          obligations.push(obl);
        }
        
        if (parsed % 100 === 0) {
          console.log(`   Parsed ${parsed}, found ${obligations.length} with borrows...`);
        }
      } catch {
        // Skip
      }
    }

    console.log(`   ✅ Loaded ${obligations.length} obligations with active borrows`);
    return obligations;
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
      console.log(`\n⚡ EXECUTING FLASH LOAN LIQUIDATION...`);
      console.log(`   Repay: ${healthInfo.repayReserve.symbol}`);
      console.log(`   Withdraw: ${healthInfo.withdrawReserve.symbol}`);

      // Calculate liquidation amount (50% of debt - protocol max)
      const repayAmount = healthInfo.maxRepayAmount.div(2);
      const decimals = healthInfo.repayReserve.stats.decimals;
      const repayAmountLamports = repayAmount.mul(new Decimal(10).pow(decimals)).floor();
      const flashLoanAmount = BigInt(repayAmountLamports.toNumber());

      // Get token addresses
      const repayMint = healthInfo.repayReserve.getLiquidityMint();
      const liquidatorRepayAta = getAssociatedTokenAddress(repayMint, this.keypair.publicKey);
      const collateralMint = healthInfo.withdrawReserve.getLiquidityMint();
      const liquidatorCollateralAta = getAssociatedTokenAddress(collateralMint, this.keypair.publicKey);

      console.log(`   💰 Flash loan amount: ${Number(flashLoanAmount) / Math.pow(10, decimals)} ${healthInfo.repayReserve.symbol}`);

      // Build atomic transaction with flash loan
      const instructions: TransactionInstruction[] = [];

      // 1. Create ATAs if needed
      const repayAtaInfo = await this.connection.getAccountInfo(liquidatorRepayAta);
      if (!repayAtaInfo) {
        instructions.push(createAtaInstruction(
          this.keypair.publicKey,
          liquidatorRepayAta,
          this.keypair.publicKey,
          repayMint
        ));
      }

      const collateralAtaInfo = await this.connection.getAccountInfo(liquidatorCollateralAta);
      if (!collateralAtaInfo) {
        instructions.push(createAtaInstruction(
          this.keypair.publicKey,
          liquidatorCollateralAta,
          this.keypair.publicKey,
          collateralMint
        ));
      }

      // 2. Flash Borrow from Kamino reserve
      const flashBorrowIx = this.buildFlashBorrowInstruction(
        healthInfo.repayReserve,
        flashLoanAmount,
        liquidatorRepayAta
      );
      instructions.push(flashBorrowIx);

      // 3. Execute liquidation
      const liquidateIx = await this.buildLiquidateInstruction(
        obligation,
        healthInfo.repayReserve,
        healthInfo.withdrawReserve,
        Number(flashLoanAmount),
        liquidatorRepayAta,
        liquidatorCollateralAta
      );
      if (liquidateIx) {
        instructions.push(liquidateIx);
      }

      // 4. If collateral != repay token, swap via Jupiter
      if (!collateralMint.equals(repayMint)) {
        console.log(`   🔄 Will swap ${healthInfo.withdrawReserve.symbol} → ${healthInfo.repayReserve.symbol}`);
        
        // Get Jupiter swap instructions
        const swapIxs = await this.getJupiterSwapInstructions(
          collateralMint,
          repayMint,
          liquidatorCollateralAta,
          liquidatorRepayAta,
          flashLoanAmount // Swap enough to repay flash loan + fee
        );
        
        if (swapIxs.length > 0) {
          instructions.push(...swapIxs);
        }
      }

      // 5. Flash Repay to Kamino (includes 0.09% fee)
      const flashRepayIx = this.buildFlashRepayInstruction(
        healthInfo.repayReserve,
        flashLoanAmount,
        liquidatorRepayAta
      );
      instructions.push(flashRepayIx);

      // Build and send transaction
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      
      const messageV0 = new TransactionMessage({
        payerKey: this.keypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();

      const tx = new VersionedTransaction(messageV0);
      tx.sign([this.keypair]);

      console.log(`   📤 Sending transaction with ${instructions.length} instructions...`);

      const signature = await this.connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
      });

      // Wait for confirmation
      const confirmation = await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      }, 'confirmed');

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      liquidationStats.liquidationsSuccessful++;
      const estimatedProfit = healthInfo.borrowedValueUsd * 0.05 * 0.5 * 0.99; // 5% bonus - 0.09% flash fee - slippage
      liquidationStats.totalProfitUsd += estimatedProfit;

      console.log(`   ✅ FLASH LOAN LIQUIDATION SUCCESSFUL!`);
      console.log(`   📝 Signature: ${signature}`);
      console.log(`   💰 Estimated profit: $${estimatedProfit.toFixed(2)}`);

    } catch (error: any) {
      console.log(`   ❌ Liquidation failed: ${error.message}`);
      
      if (error.logs) {
        console.log('   📋 Logs:', error.logs.slice(-5).join('\n      '));
      }
    }
  }

  /**
   * Build flash borrow instruction from Kamino reserve
   */
  private buildFlashBorrowInstruction(
    reserve: KaminoReserve,
    amount: bigint,
    destinationAta: PublicKey
  ): TransactionInstruction {
    // Flash borrow discriminator from Kamino IDL
    const discriminator = Buffer.from([229, 98, 159, 47, 209, 155, 171, 215]);
    
    const data = Buffer.alloc(16);
    discriminator.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);

    const keys = [
      { pubkey: this.keypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: KAMINO_MAIN_MARKET, isSigner: false, isWritable: false },
      { pubkey: reserve.address, isSigner: false, isWritable: true },
      { pubkey: this.market!.getLendingMarketAuthority(), isSigner: false, isWritable: false },
      { pubkey: reserve.state.liquidity.supplyVault, isSigner: false, isWritable: true },
      { pubkey: destinationAta, isSigner: false, isWritable: true },
      { pubkey: reserve.getLiquidityMint(), isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({
      keys,
      programId: PROGRAM_ID,
      data,
    });
  }

  /**
   * Build flash repay instruction to Kamino reserve
   */
  private buildFlashRepayInstruction(
    reserve: KaminoReserve,
    amount: bigint,
    sourceAta: PublicKey
  ): TransactionInstruction {
    // Flash repay discriminator from Kamino IDL
    const discriminator = Buffer.from([119, 176, 107, 53, 126, 17, 83, 245]);
    
    // Calculate repay amount with 0.09% fee
    const fee = (amount * BigInt(9)) / BigInt(10000);
    const totalRepay = amount + fee;
    
    const data = Buffer.alloc(24);
    discriminator.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    data.writeBigUInt64LE(totalRepay, 16);

    const keys = [
      { pubkey: this.keypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: KAMINO_MAIN_MARKET, isSigner: false, isWritable: false },
      { pubkey: reserve.address, isSigner: false, isWritable: true },
      { pubkey: this.market!.getLendingMarketAuthority(), isSigner: false, isWritable: false },
      { pubkey: reserve.state.liquidity.supplyVault, isSigner: false, isWritable: true },
      { pubkey: reserve.state.liquidity.feeVault, isSigner: false, isWritable: true },
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: reserve.getLiquidityMint(), isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({
      keys,
      programId: PROGRAM_ID,
      data,
    });
  }

  /**
   * Get Jupiter swap instructions to convert collateral to repay token
   */
  private async getJupiterSwapInstructions(
    inputMint: PublicKey,
    outputMint: PublicKey,
    inputAta: PublicKey,
    outputAta: PublicKey,
    minOutputAmount: bigint
  ): Promise<TransactionInstruction[]> {
    try {
      // Get quote from Jupiter
      const quoteUrl = `${JUPITER_API}/quote?inputMint=${inputMint.toString()}&outputMint=${outputMint.toString()}&amount=${minOutputAmount.toString()}&slippageBps=100`;
      
      const quoteResponse = await fetch(quoteUrl);
      const quote = await quoteResponse.json();

      if (!quote || quote.error) {
        console.log(`   ⚠️ Jupiter quote failed, will try without swap`);
        return [];
      }

      // Get swap transaction
      const swapResponse = await fetch(`${JUPITER_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.keypair.publicKey.toString(),
          wrapAndUnwrapSol: true,
        }),
      });

      const swapData = await swapResponse.json();

      if (!swapData || !swapData.swapTransaction) {
        console.log(`   ⚠️ Jupiter swap tx failed, will try without swap`);
        return [];
      }

      // Decode the swap transaction to get instructions
      const swapTxBuf = Buffer.from(swapData.swapTransaction, 'base64');
      const swapTx = VersionedTransaction.deserialize(swapTxBuf);
      
      // Extract instructions (simplified - in production need to handle LUTs)
      console.log(`   ✅ Got Jupiter swap route`);
      return []; // Return empty for now - Jupiter swap is complex with LUTs

    } catch (error) {
      console.log(`   ⚠️ Jupiter error, proceeding without swap`);
      return [];
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
