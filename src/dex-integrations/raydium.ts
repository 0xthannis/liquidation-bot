/**
 * Raydium DEX Integration
 * Uses official @raydium-io/raydium-sdk-v2
 * Documentation: https://github.com/raydium-io/raydium-sdk-V2
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Raydium, PoolFetchType } from '@raydium-io/raydium-sdk-v2';

// Token mint addresses
const TOKEN_MINTS: Record<string, string> = {
  'SOL': 'So11111111111111111111111111111111111111112',
  'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'JUP': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'JTO': 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'WIF': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
};

export interface RaydiumPriceQuote {
  pair: string;
  price: number;
  liquidity: number;
  poolId: string;
  poolType: string;
}

/**
 * Raydium DEX client for fetching pool prices
 */
export class RaydiumClient {
  private connection: Connection;
  private raydium: Raydium | null = null;
  private initialized = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Initialize the Raydium SDK
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Initialize Raydium SDK without owner (read-only mode)
      this.raydium = await Raydium.load({
        connection: this.connection,
        disableLoadToken: true, // We don't need full token list
      });
      this.initialized = true;
      console.log('[Raydium] SDK initialized');
    } catch (e) {
      console.error('[Raydium] Failed to initialize SDK:', e);
      throw e;
    }
  }

  /**
   * Get price for a trading pair from Raydium pools
   * Returns price in quote tokens (USDC) per 1 base token
   */
  async getPrice(pair: string): Promise<RaydiumPriceQuote | null> {
    if (!this.raydium) {
      await this.initialize();
    }

    const [base, quote] = pair.split('/');
    const baseMint = TOKEN_MINTS[base];
    const quoteMint = TOKEN_MINTS[quote];

    if (!baseMint || !quoteMint) {
      console.error(`[Raydium] Unknown tokens in pair: ${pair}`);
      return null;
    }

    try {
      // Fetch pools for this token pair using the API
      const poolData = await this.raydium!.api.fetchPoolByMints({
        mint1: baseMint,
        mint2: quoteMint,
        type: PoolFetchType.All,
        sort: 'liquidity',
        order: 'desc',
      });

      if (!poolData || !poolData.data || poolData.data.length === 0) {
        return null;
      }

      // Get the most liquid pool
      const bestPool = poolData.data[0];
      
      // Calculate price from pool reserves
      // Price = quoteReserve / baseReserve (adjusted for decimals)
      let price = 0;
      let liquidity = 0;

      if (bestPool.mintA && bestPool.mintB) {
        const isBaseA = bestPool.mintA.address === baseMint;
        
        if (isBaseA) {
          // mintA is base, mintB is quote
          price = bestPool.price || 0;
        } else {
          // mintB is base, mintA is quote - invert price
          price = bestPool.price ? 1 / bestPool.price : 0;
        }

        liquidity = bestPool.tvl || 0;
      }

      return {
        pair,
        price,
        liquidity,
        poolId: bestPool.id,
        poolType: bestPool.type,
      };

    } catch (e) {
      console.error(`[Raydium] Error fetching price for ${pair}:`, e);
      return null;
    }
  }

  /**
   * Get prices for multiple pairs
   */
  async getPrices(pairs: string[]): Promise<Map<string, RaydiumPriceQuote>> {
    const results = new Map<string, RaydiumPriceQuote>();

    for (const pair of pairs) {
      const quote = await this.getPrice(pair);
      if (quote) {
        results.set(pair, quote);
      }
      // Small delay between API calls
      await new Promise(r => setTimeout(r, 100));
    }

    return results;
  }
}
