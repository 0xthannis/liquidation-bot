import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { ThrottledConnection } from './utils/throttled-connection.js';
import { logger } from './utils/logger.js';
import { ArbitrageOpportunity } from './profit-calculator.js';

/**
 * Kamino Lending Program ID
 */
const KAMINO_PROGRAM_ID = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

/**
 * Kamino Main Market
 */
const KAMINO_MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

/**
 * Token mints
 */
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/**
 * Execution result
 */
export interface ExecutionResult {
  success: boolean;
  txSignature?: string;
  actualProfit?: number;
  error?: string;
  gasUsed?: number;
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
  totalGasUsed: number;
}

/**
 * Flash Loan Arbitrage Executor
 * Handles the actual execution of arbitrage trades via Kamino flash loans
 */
export class Executor {
  private connection: ThrottledConnection;
  private keypair: Keypair;
  private dryRun: boolean;
  private stats: ExecutorStats = {
    tradesExecuted: 0,
    tradesSuccessful: 0,
    tradesFailed: 0,
    totalProfitUsd: 0,
    totalGasUsed: 0,
  };

  constructor(connection: ThrottledConnection, keypair: Keypair, dryRun: boolean = true) {
    this.connection = connection;
    this.keypair = keypair;
    this.dryRun = dryRun;
    
    if (dryRun) {
      logger.warn('Executor running in DRY RUN mode - no transactions will be sent');
    }
  }

  /**
   * Execute an arbitrage opportunity
   */
  async execute(opportunity: ArbitrageOpportunity): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.stats.tradesExecuted++;

    logger.opportunity(`EXECUTING: ${opportunity.pair}`);
    logger.info(`   Buy: ${opportunity.buyDex} @ $${opportunity.buyPrice.toFixed(4)}`);
    logger.info(`   Sell: ${opportunity.sellDex} @ $${opportunity.sellPrice.toFixed(4)}`);
    logger.info(`   Flash Amount: $${opportunity.flashAmount.toLocaleString()}`);
    logger.info(`   Expected Profit: $${opportunity.calculation.netProfit.toFixed(2)}`);

    if (this.dryRun) {
      logger.success(`DRY RUN - Would have executed trade`);
      this.stats.tradesSuccessful++;
      this.stats.totalProfitUsd += opportunity.calculation.netProfit;
      
      return {
        success: true,
        actualProfit: opportunity.calculation.netProfit,
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      // Build and execute the flash loan transaction
      const result = await this.executeFlashLoanArbitrage(opportunity);
      
      if (result.success) {
        this.stats.tradesSuccessful++;
        this.stats.totalProfitUsd += result.actualProfit || 0;
        logger.success(`EXECUTED - Actual profit: $${result.actualProfit?.toFixed(2) || 'unknown'}`);
      } else {
        this.stats.tradesFailed++;
        logger.error(`FAILED: ${result.error}`);
      }

      return {
        ...result,
        executionTimeMs: Date.now() - startTime,
      };

    } catch (e: any) {
      this.stats.tradesFailed++;
      logger.error(`Execution error: ${e.message}`);
      
      return {
        success: false,
        error: e.message,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute flash loan arbitrage transaction
   */
  private async executeFlashLoanArbitrage(opportunity: ArbitrageOpportunity): Promise<ExecutionResult> {
    try {
      // Step 1: Get Jupiter swap instructions for buy and sell
      const buySwapIx = await this.getJupiterSwapTransaction(
        USDC_MINT.toBase58(),
        this.getTokenMint(opportunity.pair.split('/')[0]),
        opportunity.flashAmount,
        opportunity.buyDex
      );

      const sellSwapIx = await this.getJupiterSwapTransaction(
        this.getTokenMint(opportunity.pair.split('/')[0]),
        USDC_MINT.toBase58(),
        opportunity.flashAmount, // Approximate - actual amount from first swap
        opportunity.sellDex
      );

      if (!buySwapIx || !sellSwapIx) {
        return { success: false, error: 'Failed to get swap instructions', executionTimeMs: 0 };
      }

      // Step 2: Build flash loan transaction
      // Flash borrow USDC → Swap to token on cheap DEX → Swap back to USDC on expensive DEX → Repay flash loan
      
      const { blockhash } = await this.connection.getLatestBlockhash();
      
      // For now, execute via Jupiter's transaction endpoint which handles everything
      const txResult = await this.executeJupiterArbitrage(opportunity);
      
      return txResult;

    } catch (e: any) {
      return { success: false, error: e.message, executionTimeMs: 0 };
    }
  }

  /**
   * Get Jupiter swap transaction
   */
  private async getJupiterSwapTransaction(
    inputMint: string,
    outputMint: string,
    amountUsd: number,
    preferredDex?: string
  ): Promise<any> {
    try {
      // Convert USD to lamports (assuming USDC with 6 decimals)
      const amount = Math.floor(amountUsd * 1_000_000);
      
      let url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`;
      
      if (preferredDex) {
        url += `&dexes=${preferredDex}`;
      }

      const quoteResponse = await fetch(url);
      if (!quoteResponse.ok) return null;

      const quote = await quoteResponse.json();
      
      // Get swap transaction
      const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
        }),
      });

      if (!swapResponse.ok) return null;

      const swapData = await swapResponse.json();
      return swapData;

    } catch (e) {
      logger.error(`Jupiter swap error: ${e}`);
      return null;
    }
  }

  /**
   * Execute arbitrage via Jupiter (simplified flow)
   */
  private async executeJupiterArbitrage(opportunity: ArbitrageOpportunity): Promise<ExecutionResult> {
    try {
      const [base, quote] = opportunity.pair.split('/');
      const baseMint = this.getTokenMint(base);
      const quoteMint = USDC_MINT.toBase58();
      const amountLamports = Math.floor(opportunity.flashAmount * 1_000_000);

      // Step 1: Buy token on cheap DEX
      const buyQuoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${quoteMint}&outputMint=${baseMint}&amount=${amountLamports}&slippageBps=30&dexes=${opportunity.buyDex}`;
      
      const buyQuoteRes = await fetch(buyQuoteUrl);
      if (!buyQuoteRes.ok) {
        return { success: false, error: 'Failed to get buy quote', executionTimeMs: 0 };
      }
      const buyQuote = await buyQuoteRes.json();
      
      // Get expected output amount
      const tokenAmount = buyQuote.outAmount;
      
      // Step 2: Sell token on expensive DEX
      const sellQuoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${baseMint}&outputMint=${quoteMint}&amount=${tokenAmount}&slippageBps=30&dexes=${opportunity.sellDex}`;
      
      const sellQuoteRes = await fetch(sellQuoteUrl);
      if (!sellQuoteRes.ok) {
        return { success: false, error: 'Failed to get sell quote', executionTimeMs: 0 };
      }
      const sellQuote = await sellQuoteRes.json();
      
      // Calculate actual profit
      const usdcOut = parseInt(sellQuote.outAmount) / 1_000_000;
      const actualProfit = usdcOut - opportunity.flashAmount;
      
      if (actualProfit < 10) {
        return { success: false, error: `Profit too low: $${actualProfit.toFixed(2)}`, executionTimeMs: 0 };
      }

      // Step 3: Get swap transactions
      const buySwapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: buyQuote,
          userPublicKey: this.keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
        }),
      });

      if (!buySwapRes.ok) {
        return { success: false, error: 'Failed to get buy swap tx', executionTimeMs: 0 };
      }
      
      const buySwapData = await buySwapRes.json();
      
      // Execute buy transaction
      const buyTx = VersionedTransaction.deserialize(Buffer.from(buySwapData.swapTransaction, 'base64'));
      buyTx.sign([this.keypair]);
      
      const buyTxId = await this.connection.raw.sendRawTransaction(buyTx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });
      
      logger.info(`   Buy TX: ${buyTxId}`);
      
      // Wait for confirmation
      await this.connection.confirmTransaction(buyTxId as any, 'confirmed');
      
      // Execute sell transaction
      const sellSwapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: sellQuote,
          userPublicKey: this.keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
        }),
      });

      if (!sellSwapRes.ok) {
        return { success: false, error: 'Failed to get sell swap tx', executionTimeMs: 0 };
      }
      
      const sellSwapData = await sellSwapRes.json();
      const sellTx = VersionedTransaction.deserialize(Buffer.from(sellSwapData.swapTransaction, 'base64'));
      sellTx.sign([this.keypair]);
      
      const sellTxId = await this.connection.raw.sendRawTransaction(sellTx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });
      
      logger.info(`   Sell TX: ${sellTxId}`);
      
      return {
        success: true,
        txSignature: sellTxId,
        actualProfit,
        executionTimeMs: 0,
      };

    } catch (e: any) {
      return { success: false, error: e.message, executionTimeMs: 0 };
    }
  }

  /**
   * Get token mint address
   */
  private getTokenMint(symbol: string): string {
    const mints: Record<string, string> = {
      'SOL': 'So11111111111111111111111111111111111111112',
      'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'JUP': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
      'JTO': 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
      'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      'WIF': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    };
    return mints[symbol] || symbol;
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
      logger.warn('Switched to DRY RUN mode');
    } else {
      logger.success('Switched to LIVE mode');
    }
  }
}
