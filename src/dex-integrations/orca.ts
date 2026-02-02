/**
 * Orca Whirlpools DEX Integration
 * Uses official @orca-so/whirlpools-sdk (legacy)
 * Documentation: https://dev.orca.so/
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { 
  WhirlpoolContext, 
  buildWhirlpoolClient, 
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil,
  swapQuoteByInputToken,
  IGNORE_CACHE,
} from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import BN from 'bn.js';

// Orca Whirlpools Config for Mainnet
const WHIRLPOOLS_CONFIG = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ');

// Token mint addresses and decimals
const TOKEN_INFO: Record<string, { mint: PublicKey; decimals: number }> = {
  'SOL': { mint: new PublicKey('So11111111111111111111111111111111111111112'), decimals: 9 },
  'USDC': { mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), decimals: 6 },
  'JUP': { mint: new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'), decimals: 6 },
  'JTO': { mint: new PublicKey('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'), decimals: 9 },
  'BONK': { mint: new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), decimals: 5 },
  'WIF': { mint: new PublicKey('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'), decimals: 6 },
};

// Main tick spacings to check (most liquid pools use these)
const TICK_SPACINGS = [64, 128, 8, 1];

export interface OrcaPriceQuote {
  pair: string;
  price: number;
  liquidity: number;
  sqrtPrice: string;
  tickCurrentIndex: number;
}

/**
 * Orca Whirlpools client for fetching pool prices
 */
export class OrcaClient {
  private connection: Connection;
  private ctx: WhirlpoolContext | null = null;
  private client: any = null;
  private initialized = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Initialize the Orca Whirlpools SDK
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create a read-only context (no wallet needed for price queries)
      this.ctx = WhirlpoolContext.withProvider(
        { connection: this.connection } as any,
        ORCA_WHIRLPOOL_PROGRAM_ID
      );
      this.client = buildWhirlpoolClient(this.ctx);
      this.initialized = true;
      console.log('[Orca] Whirlpools SDK initialized');
    } catch (e) {
      console.error('[Orca] Failed to initialize SDK:', e);
      throw e;
    }
  }

  // Cache for pool addresses
  private poolCache: Map<string, PublicKey> = new Map();

  /**
   * Find whirlpool address for a pair
   */
  private async findWhirlpool(pair: string): Promise<PublicKey | null> {
    // Check cache first
    if (this.poolCache.has(pair)) {
      return this.poolCache.get(pair)!;
    }

    const [base, quote] = pair.split('/');
    const baseInfo = TOKEN_INFO[base];
    const quoteInfo = TOKEN_INFO[quote];
    
    if (!baseInfo || !quoteInfo) {
      return null;
    }

    // Token order matters - smaller pubkey is tokenA
    const [tokenMintA, tokenMintB] = baseInfo.mint.toBuffer().compare(quoteInfo.mint.toBuffer()) < 0
      ? [baseInfo.mint, quoteInfo.mint]
      : [quoteInfo.mint, baseInfo.mint];

    // Try tick spacings in order of typical liquidity
    for (const tickSpacing of TICK_SPACINGS) {
      try {
        const pda = PDAUtil.getWhirlpool(
          ORCA_WHIRLPOOL_PROGRAM_ID,
          WHIRLPOOLS_CONFIG,
          tokenMintA,
          tokenMintB,
          tickSpacing
        );
        
        const accountInfo = await this.connection.getAccountInfo(pda.publicKey);
        if (accountInfo) {
          this.poolCache.set(pair, pda.publicKey);
          return pda.publicKey;
        }
      } catch (e) {
        // Continue
      }
    }
    
    return null;
  }

  /**
   * Get price using swapQuoteByInputToken
   * Returns price in quote tokens (USDC) per 1 base token
   */
  async getPrice(pair: string): Promise<OrcaPriceQuote | null> {
    if (!this.client || !this.ctx) {
      await this.initialize();
    }

    const [base, quote] = pair.split('/');
    const baseInfo = TOKEN_INFO[base];
    const quoteInfo = TOKEN_INFO[quote];

    if (!baseInfo || !quoteInfo) {
      console.error(`[Orca] Unknown tokens in pair: ${pair}`);
      return null;
    }

    try {
      const poolAddress = await this.findWhirlpool(pair);
      if (!poolAddress) {
        console.error(`[Orca] No whirlpool found for pair: ${pair}`);
        return null;
      }

      const whirlpool = await this.client.getPool(poolAddress);
      
      // Use swapQuoteByInputToken to get accurate price
      // Swap 1 unit of base token to see how much quote we get
      const inputAmount = new BN(Math.pow(10, baseInfo.decimals)); // 1 token
      const slippage = Percentage.fromFraction(1, 100); // 1%

      const swapQuote = await swapQuoteByInputToken(
        whirlpool,
        baseInfo.mint,
        inputAmount,
        slippage,
        ORCA_WHIRLPOOL_PROGRAM_ID,
        this.ctx!.fetcher,
        IGNORE_CACHE
      );

      // Calculate price from quote
      const outputAmount = swapQuote.estimatedAmountOut.toNumber();
      const price = outputAmount / Math.pow(10, quoteInfo.decimals);

      console.log(`[Orca] ${pair}: price=${price}`);

      return {
        pair,
        price,
        liquidity: whirlpool.getData().liquidity.toNumber(),
        sqrtPrice: whirlpool.getData().sqrtPrice.toString(),
        tickCurrentIndex: whirlpool.getData().tickCurrentIndex,
      };

    } catch (e) {
      console.error(`[Orca] Error fetching price for ${pair}:`, e);
      return null;
    }
  }

  /**
   * Get prices for multiple pairs
   */
  async getPrices(pairs: string[]): Promise<Map<string, OrcaPriceQuote>> {
    const results = new Map<string, OrcaPriceQuote>();

    for (const pair of pairs) {
      const quote = await this.getPrice(pair);
      if (quote) {
        results.set(pair, quote);
      }
      // Small delay between RPC calls
      await new Promise(r => setTimeout(r, 50));
    }

    return results;
  }

  /**
   * Build swap transaction for Orca Whirlpool
   * @param inputMint Input token mint
   * @param outputMint Output token mint
   * @param amountIn Amount in base units
   * @param walletPubkey Wallet public key
   * @param slippagePct Slippage percentage (default 1%)
   * @returns Transaction instructions or null
   */
  async buildSwapTransaction(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amountIn: BN,
    walletPubkey: PublicKey,
    slippagePct: number = 1
  ): Promise<any | null> {
    if (!this.client || !this.ctx) {
      await this.initialize();
    }

    try {
      // Find the whirlpool for this pair
      const inputSymbol = Object.keys(TOKEN_INFO).find(k => TOKEN_INFO[k].mint.equals(inputMint));
      const outputSymbol = Object.keys(TOKEN_INFO).find(k => TOKEN_INFO[k].mint.equals(outputMint));
      
      if (!inputSymbol || !outputSymbol) {
        console.error('[Orca] Unknown token mints');
        return null;
      }

      const pair = `${inputSymbol}/${outputSymbol}`;
      const reversePair = `${outputSymbol}/${inputSymbol}`;
      
      let poolAddress = await this.findWhirlpool(pair);
      if (!poolAddress) {
        poolAddress = await this.findWhirlpool(reversePair);
      }
      
      if (!poolAddress) {
        console.error(`[Orca] No whirlpool found for ${inputSymbol}/${outputSymbol}`);
        return null;
      }

      const whirlpool = await this.client.getPool(poolAddress);
      const slippage = Percentage.fromFraction(slippagePct, 100);

      // Get swap quote
      const swapQuote = await swapQuoteByInputToken(
        whirlpool,
        inputMint,
        amountIn,
        slippage,
        ORCA_WHIRLPOOL_PROGRAM_ID,
        this.ctx!.fetcher,
        IGNORE_CACHE
      );

      // Build swap transaction
      const swapTx = await whirlpool.swap(swapQuote, walletPubkey);
      
      return swapTx;

    } catch (e) {
      console.error('[Orca] Error building swap transaction:', e);
      return null;
    }
  }

  /**
   * Get token info by symbol
   */
  getTokenInfo(symbol: string): { mint: PublicKey; decimals: number } | null {
    return TOKEN_INFO[symbol] || null;
  }

  /**
   * Get context for external use
   */
  getContext(): WhirlpoolContext | null {
    return this.ctx;
  }
}
