/**
 * Meteora DLMM DEX Integration
 * Uses official @meteora-ag/dlmm SDK
 * Documentation: https://docs.meteora.ag/developer-guide/guides/dlmm/typescript-sdk/sdk-functions
 */

import { Connection, PublicKey } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';

// Token mint addresses
const TOKEN_MINTS: Record<string, string> = {
  'SOL': 'So11111111111111111111111111111111111111112',
  'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'JUP': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'JTO': 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'WIF': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
};

// Known Meteora DLMM pool addresses for common pairs
// These are the most liquid DLMM pools
const DLMM_POOL_ADDRESSES: Record<string, string> = {
  'SOL/USDC': 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'JUP/USDC': '7gAK3n7YnUxGcmrH5JdPviCHMDBgNPADKkdkG7UyGJH3',
  'JTO/USDC': '2eSZKDCPgSQRDTjXqhqgApwVjJSAqQnT3RNfZCRZrqLr',
  'BONK/USDC': 'FoSDw2L5DmTuQTFe55gWPDXf88euaxAEKFre74CnvQbX',
  'WIF/USDC': '8S7hF5drqTfMCeNeLahkA4pZFPnNjZ4WSMpcJJNwbxj2',
};

export interface MeteoraPriceQuote {
  pair: string;
  price: number;
  liquidity: number;
  activeBinId: number;
  binStep: number;
}

/**
 * Meteora DLMM client for fetching pool prices
 */
export class MeteoraClient {
  private connection: Connection;
  private poolCache: Map<string, DLMM> = new Map();
  private initialized = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Initialize and cache pool instances
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log('[Meteora] Initializing DLMM pools...');
    
    for (const [pair, address] of Object.entries(DLMM_POOL_ADDRESSES)) {
      try {
        const pool = await DLMM.create(this.connection, new PublicKey(address));
        this.poolCache.set(pair, pool);
      } catch (e) {
        console.error(`[Meteora] Failed to load pool for ${pair}:`, e);
      }
    }

    this.initialized = true;
    console.log(`[Meteora] Initialized ${this.poolCache.size} DLMM pools`);
  }

  /**
   * Get price for a trading pair from Meteora DLMM
   * Returns price in quote tokens (USDC) per 1 base token
   */
  async getPrice(pair: string): Promise<MeteoraPriceQuote | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    const pool = this.poolCache.get(pair);
    if (!pool) {
      // Try to create pool on demand
      const poolAddress = DLMM_POOL_ADDRESSES[pair];
      if (!poolAddress) {
        console.error(`[Meteora] No DLMM pool found for pair: ${pair}`);
        return null;
      }

      try {
        const newPool = await DLMM.create(this.connection, new PublicKey(poolAddress));
        this.poolCache.set(pair, newPool);
        return this.getPriceFromPool(pair, newPool);
      } catch (e) {
        console.error(`[Meteora] Failed to create pool for ${pair}:`, e);
        return null;
      }
    }

    return this.getPriceFromPool(pair, pool);
  }

  /**
   * Get price from a DLMM pool instance
   */
  private async getPriceFromPool(pair: string, pool: DLMM): Promise<MeteoraPriceQuote | null> {
    try {
      // Refresh pool state to get latest data
      await pool.refetchStates();

      // Get active bin which contains current price
      const activeBin = await pool.getActiveBin();
      
      if (!activeBin) {
        console.error(`[Meteora] No active bin for ${pair}`);
        return null;
      }

      // Get price per token from active bin
      // pricePerToken is already in human-readable format
      const price = parseFloat(activeBin.pricePerToken);

      // Get pool info for liquidity
      const lbPair = pool.lbPair;
      const binStep = lbPair.binStep;

      // Estimate liquidity from reserves
      const reserveX = lbPair.reserveX.toNumber();
      const reserveY = lbPair.reserveY.toNumber();
      
      // Rough TVL estimate (reserveY is USDC in most pairs)
      const liquidity = reserveY * 2;

      return {
        pair,
        price,
        liquidity,
        activeBinId: activeBin.binId,
        binStep,
      };

    } catch (e) {
      console.error(`[Meteora] Error fetching price for ${pair}:`, e);
      return null;
    }
  }

  /**
   * Get prices for multiple pairs
   */
  async getPrices(pairs: string[]): Promise<Map<string, MeteoraPriceQuote>> {
    const results = new Map<string, MeteoraPriceQuote>();

    for (const pair of pairs) {
      const quote = await this.getPrice(pair);
      if (quote) {
        results.set(pair, quote);
      }
    }

    return results;
  }
}
