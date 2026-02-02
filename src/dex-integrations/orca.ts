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
  PriceMath,
} from '@orca-so/whirlpools-sdk';
import Decimal from 'decimal.js';

// Orca Whirlpools Config for Mainnet
// Source: https://dev.orca.so/Architecture%20Overview/Whirlpool%20Parameters/
const WHIRLPOOLS_CONFIG = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ');

// Token mint addresses
const TOKEN_MINTS: Record<string, PublicKey> = {
  'SOL': new PublicKey('So11111111111111111111111111111111111111112'),
  'USDC': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  'JUP': new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
  'JTO': new PublicKey('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'),
  'BONK': new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
  'WIF': new PublicKey('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'),
};

// Tick spacing (fee tier) for each pair - common values: 1, 8, 64, 128, 256
// We try all common tick spacings and pick the pool with highest liquidity
const ALL_TICK_SPACINGS = [1, 2, 4, 8, 16, 64, 128, 256];

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

  /**
   * Derive whirlpool address using PDAUtil
   * Tries all tick spacings and returns the pool with highest liquidity
   */
  private async findBestWhirlpool(pair: string): Promise<{ address: PublicKey; tickSpacing: number } | null> {
    const [base, quote] = pair.split('/');
    const baseMint = TOKEN_MINTS[base];
    const quoteMint = TOKEN_MINTS[quote];
    
    if (!baseMint || !quoteMint) {
      console.error(`[Orca] Unknown token in pair: ${pair}`);
      return null;
    }

    // Token order matters - smaller pubkey is tokenA
    const [tokenMintA, tokenMintB] = baseMint.toBuffer().compare(quoteMint.toBuffer()) < 0
      ? [baseMint, quoteMint]
      : [quoteMint, baseMint];

    let bestPool: { address: PublicKey; tickSpacing: number; liquidity: number } | null = null;
    
    // Try all tick spacings and find the one with highest liquidity
    for (const tickSpacing of ALL_TICK_SPACINGS) {
      try {
        const pda = PDAUtil.getWhirlpool(
          ORCA_WHIRLPOOL_PROGRAM_ID,
          WHIRLPOOLS_CONFIG,
          tokenMintA,
          tokenMintB,
          tickSpacing
        );
        
        // Check if the pool exists
        const accountInfo = await this.connection.getAccountInfo(pda.publicKey);
        if (accountInfo) {
          // Get pool data to check liquidity
          try {
            const whirlpool = await this.client.getPool(pda.publicKey);
            const data = whirlpool.getData();
            const liquidity = data.liquidity.toNumber();
            
            if (!bestPool || liquidity > bestPool.liquidity) {
              bestPool = { address: pda.publicKey, tickSpacing, liquidity };
            }
          } catch (e) {
            // Pool exists but couldn't fetch data, skip
          }
        }
      } catch (e) {
        // Continue to next tick spacing
      }
    }
    
    if (bestPool) {
      console.log(`[Orca] ${pair}: Best pool tick spacing=${bestPool.tickSpacing}, liquidity=${bestPool.liquidity}`);
    }
    
    return bestPool;
  }

  /**
   * Get price for a trading pair from Orca Whirlpool
   * Returns price in quote tokens (USDC) per 1 base token
   */
  async getPrice(pair: string): Promise<OrcaPriceQuote | null> {
    if (!this.client) {
      await this.initialize();
    }

    try {
      // Find the best whirlpool (highest liquidity) for this pair
      const bestPool = await this.findBestWhirlpool(pair);
      if (!bestPool) {
        console.error(`[Orca] No whirlpool found for pair: ${pair}`);
        return null;
      }

      // Fetch the whirlpool account
      const whirlpool = await this.client.getPool(bestPool.address);
      const whirlpoolData = whirlpool.getData();

      // Get token info
      const tokenA = whirlpool.getTokenAInfo();
      const tokenB = whirlpool.getTokenBInfo();

      // Calculate price from sqrtPrice
      // sqrtPriceX64ToPrice returns tokenB/tokenA (price of tokenA in terms of tokenB)
      const sqrtPriceX64 = whirlpoolData.sqrtPrice;
      const price = PriceMath.sqrtPriceX64ToPrice(
        sqrtPriceX64,
        tokenA.decimals,
        tokenB.decimals
      );

      // Determine if we need to invert the price based on token order
      const [base] = pair.split('/');
      const baseMint = TOKEN_MINTS[base];
      const isBaseTokenA = tokenA.mint.equals(baseMint);

      // Price from SDK = tokenB/tokenA
      // If base is tokenA: price = tokenB/tokenA = quote/base (correct)
      // If base is tokenB: price = tokenB/tokenA = base/quote (need to invert)
      const finalPrice = isBaseTokenA 
        ? price.toNumber() 
        : 1 / price.toNumber();

      // Estimate liquidity from token amounts
      const liquidity = whirlpoolData.liquidity.toNumber();
      
      // Debug logging
      console.log(`[Orca] ${pair}: tokenA=${tokenA.mint.toString().slice(0,8)}, tokenB=${tokenB.mint.toString().slice(0,8)}, baseMint=${baseMint.toString().slice(0,8)}, isBaseTokenA=${isBaseTokenA}, rawPrice=${price.toNumber()}, finalPrice=${finalPrice}`);

      return {
        pair,
        price: finalPrice,
        liquidity,
        sqrtPrice: sqrtPriceX64.toString(),
        tickCurrentIndex: whirlpoolData.tickCurrentIndex,
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
}
