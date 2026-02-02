/**
 * Flash Loan Arbitrage Executor
 * Uses Kamino flash loans for capital-efficient arbitrage
 * Integrates with Raydium and Orca DEXes for swaps
 */

import { 
  Connection, 
  Keypair, 
  PublicKey, 
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { logger } from './utils/logger.js';
import { ArbitrageOpportunity, calculateJitoTip, calculateNetProfitAfterTip } from './profit-calculator.js';
import { KaminoFlashLoanClient } from './kamino-flash-loan.js';
import { RaydiumClient } from './dex-integrations/raydium.js';
import { OrcaClient } from './dex-integrations/orca.js';
import BN from 'bn.js';

// Jito tip account (mainnet)
const JITO_TIP_ACCOUNT = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');

// Token mint addresses
const TOKEN_MINTS: Record<string, PublicKey> = {
  'SOL': new PublicKey('So11111111111111111111111111111111111111112'),
  'USDC': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  'JUP': new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
  'JTO': new PublicKey('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'),
  'BONK': new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
  'WIF': new PublicKey('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'),
};

// Token decimals
const TOKEN_DECIMALS: Record<string, number> = {
  'SOL': 9,
  'USDC': 6,
  'JUP': 6,
  'JTO': 9,
  'BONK': 5,
  'WIF': 6,
};

/**
 * Execution result
 */
export interface ExecutionResult {
  success: boolean;
  txSignature?: string;
  actualProfit?: number;
  error?: string;
  executionTimeMs: number;
}

/**
 * Executor statistics
 */
export interface ExecutorStats {
  tradesExecuted: number;
  tradesSuccessful: number;
  tradesFailed: number;
  totalProfitUsd: number;
}

/**
 * Flash Loan Arbitrage Executor
 * Executes arbitrage trades using Kamino flash loans
 */
export class Executor {
  private connection: Connection;
  private keypair: Keypair;
  private dryRun: boolean;
  private kaminoClient: KaminoFlashLoanClient;
  private raydiumClient: RaydiumClient;
  private orcaClient: OrcaClient;
  private stats: ExecutorStats = {
    tradesExecuted: 0,
    tradesSuccessful: 0,
    tradesFailed: 0,
    totalProfitUsd: 0,
  };

  constructor(connection: Connection, keypair: Keypair, dryRun: boolean = true) {
    this.connection = connection;
    this.keypair = keypair;
    this.dryRun = dryRun;
    this.kaminoClient = new KaminoFlashLoanClient(connection);
    this.raydiumClient = new RaydiumClient(connection);
    this.orcaClient = new OrcaClient(connection);
    
    if (dryRun) {
      logger.warn('Executor running in DRY RUN mode - no transactions will be sent');
    }
  }

  /**
   * Initialize the executor
   */
  async initialize(): Promise<void> {
    await this.kaminoClient.initialize();
    await this.raydiumClient.initialize();
    await this.orcaClient.initialize();
    logger.info('Executor initialized');
  }

  // Cache SOL price for Jito tip calculation
  private solPriceUsd: number = 100; // Default, updated from scanner

  /**
   * Update SOL price for tip calculations
   */
  setSolPrice(price: number): void {
    this.solPriceUsd = price;
  }

  /**
   * Execute an arbitrage opportunity
   */
  async execute(opportunity: ArbitrageOpportunity): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.stats.tradesExecuted++;

    // Calculate dynamic Jito tip (15% of expected profit)
    const jitoTipSol = calculateJitoTip(opportunity.calculation.netProfit, this.solPriceUsd);
    const jitoTipUsd = jitoTipSol * this.solPriceUsd;
    const finalProfit = calculateNetProfitAfterTip(opportunity.calculation.netProfit, jitoTipSol, this.solPriceUsd);

    // Skip if not profitable after tip
    if (finalProfit <= 0) {
      logger.warn(`[Skip] ${opportunity.pair}: Not profitable after Jito tip ($${jitoTipUsd.toFixed(2)})`);
      return {
        success: false,
        error: 'Not profitable after Jito tip',
        executionTimeMs: Date.now() - startTime,
      };
    }

    logger.opportunity(`EXECUTING: ${opportunity.pair}`);
    logger.info(`   Buy: ${opportunity.buyDex} @ $${opportunity.buyPrice.toFixed(4)}`);
    logger.info(`   Sell: ${opportunity.sellDex} @ $${opportunity.sellPrice.toFixed(4)}`);
    logger.info(`   Flash amount: $${opportunity.flashAmount.toLocaleString()}`);
    logger.info(`   Jito tip: ${jitoTipSol.toFixed(6)} SOL ($${jitoTipUsd.toFixed(2)})`);
    logger.info(`   Final profit: $${finalProfit.toFixed(2)}`);

    // In dry run mode, just log and return
    if (this.dryRun) {
      const executionTimeMs = Date.now() - startTime;
      logger.info('   [DRY RUN] Trade not executed');
      return {
        success: true,
        executionTimeMs,
        actualProfit: opportunity.calculation.netProfit,
      };
    }

    try {
      // Execute the flash loan arbitrage
      const result = await this.executeFlashLoanArbitrage(opportunity);
      
      const executionTimeMs = Date.now() - startTime;

      if (result.success) {
        this.stats.tradesSuccessful++;
        this.stats.totalProfitUsd += result.actualProfit || 0;
        
        logger.success(`Trade executed successfully!`);
        logger.info(`   Signature: ${result.txSignature}`);
        logger.info(`   Actual profit: $${result.actualProfit?.toFixed(2) || 'N/A'}`);
        logger.info(`   Execution time: ${executionTimeMs}ms`);
      } else {
        this.stats.tradesFailed++;
        logger.error(`Trade failed: ${result.error}`);
      }

      return { ...result, executionTimeMs };

    } catch (e) {
      this.stats.tradesFailed++;
      const executionTimeMs = Date.now() - startTime;
      logger.error(`Execution error: ${e}`);
      return {
        success: false,
        error: String(e),
        executionTimeMs,
      };
    }
  }

  /**
   * Execute flash loan arbitrage
   * Flow: Flash Borrow USDC → Buy token on cheap DEX → Sell token on expensive DEX → Repay flash loan
   */
  private async executeFlashLoanArbitrage(
    opportunity: ArbitrageOpportunity
  ): Promise<ExecutionResult> {
    const [baseToken] = opportunity.pair.split('/');
    
    // Calculate flash loan amount in USDC lamports (6 decimals)
    const flashAmountLamports = BigInt(Math.floor(opportunity.flashAmount * 1_000_000));

    try {
      // Build swap instructions using Jupiter
      // In a full implementation, we would:
      // 1. Get swap instruction for buying baseToken with USDC on buyDex
      // 2. Get swap instruction for selling baseToken for USDC on sellDex
      
      const swapInstructions = await this.buildSwapInstructions(opportunity);
      
      if (!swapInstructions || swapInstructions.length === 0) {
        return {
          success: false,
          error: 'Failed to build swap instructions',
          executionTimeMs: 0,
        };
      }

      // Execute flash loan with swap instructions
      const result = await this.kaminoClient.executeFlashLoan({
        tokenSymbol: 'USDC',
        amountLamports: flashAmountLamports,
        borrowerKeypair: this.keypair,
        customInstructions: swapInstructions,
      });

      if (result.success) {
        // Calculate actual profit (flash amount returned + profit - fees)
        const actualProfit = opportunity.calculation.netProfit;
        
        return {
          success: true,
          txSignature: result.signature,
          actualProfit,
          executionTimeMs: 0,
        };
      } else {
        return {
          success: false,
          error: result.error,
          executionTimeMs: 0,
        };
      }

    } catch (e) {
      return {
        success: false,
        error: String(e),
        executionTimeMs: 0,
      };
    }
  }

  /**
   * Build swap instructions for the arbitrage
   * Uses Raydium/Orca DEX SDKs directly
   */
  private async buildSwapInstructions(
    opportunity: ArbitrageOpportunity
  ): Promise<TransactionInstruction[]> {
    const [baseToken] = opportunity.pair.split('/');
    const baseMint = TOKEN_MINTS[baseToken];
    const usdcMint = TOKEN_MINTS['USDC'];
    const baseDecimals = TOKEN_DECIMALS[baseToken];
    
    if (!baseMint) {
      logger.error(`Unknown token: ${baseToken}`);
      return [];
    }

    const instructions: TransactionInstruction[] = [];

    try {
      // Calculate amounts
      const usdcAmountIn = Math.floor(opportunity.flashAmount * 1_000_000); // USDC has 6 decimals
      const expectedTokenAmount = Math.floor((opportunity.flashAmount / opportunity.buyPrice) * Math.pow(10, baseDecimals));

      logger.info(`[Executor] Building swaps: ${opportunity.flashAmount} USDC → ${baseToken} → USDC`);
      logger.info(`[Executor] Buy on ${opportunity.buyDex}, Sell on ${opportunity.sellDex}`);

      // STEP 1: Buy token on buyDex (USDC → baseToken)
      if (opportunity.buyDex === 'raydium') {
        const buyTxBuffer = await this.raydiumClient.buildSwapTransaction(
          usdcMint.toBase58(),
          baseMint.toBase58(),
          usdcAmountIn,
          this.keypair.publicKey,
          100 // 1% slippage
        );
        if (!buyTxBuffer) {
          logger.error('[Executor] Failed to build Raydium buy transaction');
          return [];
        }
        // Extract instructions from Raydium versioned transaction
        const buyTx = VersionedTransaction.deserialize(buyTxBuffer);
        const buyIxs = await this.extractInstructionsFromVersionedTx(buyTx);
        instructions.push(...buyIxs);
        logger.info(`[Executor] Raydium buy: ${buyIxs.length} instructions`);
      } else if (opportunity.buyDex === 'orca') {
        const buyTxBuilder = await this.orcaClient.buildSwapTransaction(
          usdcMint,
          baseMint,
          new BN(usdcAmountIn),
          this.keypair.publicKey,
          1 // 1% slippage
        );
        if (!buyTxBuilder) {
          logger.error('[Executor] Failed to build Orca buy transaction');
          return [];
        }
        // Orca TransactionBuilder.compressIx(false) returns Instruction with instructions array
        const buyIx = buyTxBuilder.compressIx(false);
        instructions.push(...buyIx.instructions);
        // Add cleanup instructions at the end (close WSOL accounts etc)
        if (buyIx.cleanupInstructions?.length > 0) {
          instructions.push(...buyIx.cleanupInstructions);
        }
        logger.info(`[Executor] Orca buy: ${buyIx.instructions.length} instructions`);
      }

      // STEP 2: Sell token on sellDex (baseToken → USDC)
      if (opportunity.sellDex === 'raydium') {
        const sellTxBuffer = await this.raydiumClient.buildSwapTransaction(
          baseMint.toBase58(),
          usdcMint.toBase58(),
          expectedTokenAmount,
          this.keypair.publicKey,
          100 // 1% slippage
        );
        if (!sellTxBuffer) {
          logger.error('[Executor] Failed to build Raydium sell transaction');
          return [];
        }
        // Extract instructions from Raydium versioned transaction
        const sellTx = VersionedTransaction.deserialize(sellTxBuffer);
        const sellIxs = await this.extractInstructionsFromVersionedTx(sellTx);
        instructions.push(...sellIxs);
        logger.info(`[Executor] Raydium sell: ${sellIxs.length} instructions`);
      } else if (opportunity.sellDex === 'orca') {
        const sellTxBuilder = await this.orcaClient.buildSwapTransaction(
          baseMint,
          usdcMint,
          new BN(expectedTokenAmount),
          this.keypair.publicKey,
          1 // 1% slippage
        );
        if (!sellTxBuilder) {
          logger.error('[Executor] Failed to build Orca sell transaction');
          return [];
        }
        // Orca TransactionBuilder.compressIx(false) returns Instruction with instructions array
        const sellIx = sellTxBuilder.compressIx(false);
        instructions.push(...sellIx.instructions);
        if (sellIx.cleanupInstructions?.length > 0) {
          instructions.push(...sellIx.cleanupInstructions);
        }
        logger.info(`[Executor] Orca sell: ${sellIx.instructions.length} instructions`);
      }

      // STEP 3: Add Jito tip instruction
      const jitoTipSol = calculateJitoTip(opportunity.calculation.netProfit, this.solPriceUsd);
      const jitoTipLamports = Math.floor(jitoTipSol * LAMPORTS_PER_SOL);
      
      if (jitoTipLamports > 0) {
        const tipIx = SystemProgram.transfer({
          fromPubkey: this.keypair.publicKey,
          toPubkey: JITO_TIP_ACCOUNT,
          lamports: jitoTipLamports,
        });
        instructions.push(tipIx);
        logger.info(`[Executor] Jito tip: ${jitoTipSol.toFixed(6)} SOL`);
      }

      logger.info(`[Executor] Total instructions: ${instructions.length}`);
      return instructions;

    } catch (e) {
      logger.error(`[Executor] Error building swap instructions: ${e}`);
      return [];
    }
  }

  /**
   * Extract instructions from a VersionedTransaction
   * Handles both static accounts and address lookup tables
   */
  private async extractInstructionsFromVersionedTx(tx: VersionedTransaction): Promise<TransactionInstruction[]> {
    const message = tx.message;
    const instructions: TransactionInstruction[] = [];
    
    // Get all account keys (static + from lookup tables)
    let allAccountKeys: PublicKey[] = [...message.staticAccountKeys];
    
    // If there are address lookup tables, resolve them
    if (message.addressTableLookups && message.addressTableLookups.length > 0) {
      for (const lookup of message.addressTableLookups) {
        try {
          const lookupTableAccount = await this.connection.getAddressLookupTable(lookup.accountKey);
          if (lookupTableAccount.value) {
            // Add writable accounts
            for (const idx of lookup.writableIndexes) {
              allAccountKeys.push(lookupTableAccount.value.state.addresses[idx]);
            }
            // Add readonly accounts
            for (const idx of lookup.readonlyIndexes) {
              allAccountKeys.push(lookupTableAccount.value.state.addresses[idx]);
            }
          }
        } catch (e) {
          logger.warn(`[Executor] Failed to resolve lookup table: ${e}`);
        }
      }
    }
    
    // Convert each compiled instruction to TransactionInstruction
    for (const ix of message.compiledInstructions) {
      const programId = allAccountKeys[ix.programIdIndex];
      if (!programId) {
        logger.warn(`[Executor] Missing programId at index ${ix.programIdIndex}`);
        continue;
      }
      
      const keys = ix.accountKeyIndexes.map(idx => {
        const pubkey = allAccountKeys[idx];
        if (!pubkey) {
          logger.warn(`[Executor] Missing account at index ${idx}`);
          return null;
        }
        return {
          pubkey,
          isSigner: idx < message.header.numRequiredSignatures,
          isWritable: idx < message.header.numRequiredSignatures - message.header.numReadonlySignedAccounts ||
                     (idx >= message.header.numRequiredSignatures && 
                      idx < allAccountKeys.length - message.header.numReadonlyUnsignedAccounts),
        };
      }).filter(k => k !== null) as { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
      
      instructions.push(new TransactionInstruction({
        programId,
        keys,
        data: Buffer.from(ix.data),
      }));
    }
    
    return instructions;
  }

  /**
   * Get executor statistics
   */
  getStats(): ExecutorStats {
    return { ...this.stats };
  }

  /**
   * Set dry run mode
   */
  setDryRun(dryRun: boolean): void {
    this.dryRun = dryRun;
    if (dryRun) {
      logger.warn('Executor switched to DRY RUN mode');
    } else {
      logger.info('Executor switched to LIVE mode');
    }
  }
}
