/**
 * Raydium DEX Integration
 * Uses official Raydium Trade API
 * Documentation: https://docs.raydium.io/raydium/traders/trade-api
 */

import { Connection } from '@solana/web3.js';

const RAYDIUM_API_URL = 'https://transaction-v1.raydium.io';

// Token mint addresses and decimals
const TOKEN_INFO: Record<string, { mint: string; decimals: number }> = {
  'SOL': { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  'USDC': { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  'JUP': { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
  'JTO': { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', decimals: 9 },
  'BONK': { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
  'WIF': { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
};

export interface RaydiumPriceQuote {
  pair: string;
  price: number;
  liquidity: number;
  poolId: string;
  poolType: string;
}

/**
 * Raydium DEX client using Trade API
 * https://docs.raydium.io/raydium/traders/trade-api
 */
export class RaydiumClient {
  private connection: Connection;
  private initialized = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    console.log('[Raydium] SDK initialized');
  }

  /**
   * Get price using Raydium Trade API swap quote
   * Returns price in quote tokens (USDC) per 1 base token
   */
  async getPrice(pair: string): Promise<RaydiumPriceQuote | null> {
    const [base, quote] = pair.split('/');
    const baseInfo = TOKEN_INFO[base];
    const quoteInfo = TOKEN_INFO[quote];

    if (!baseInfo || !quoteInfo) {
      console.error(`[Raydium] Unknown tokens in pair: ${pair}`);
      return null;
    }

    try {
      // Use 1 unit of base token to get price quote
      const inputAmount = Math.pow(10, baseInfo.decimals); // 1 token in base units
      
      const url = `${RAYDIUM_API_URL}/compute/swap-base-in?inputMint=${baseInfo.mint}&outputMint=${quoteInfo.mint}&amount=${inputAmount}&slippageBps=50&txVersion=V0`;
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      
      if (!data.success || !data.data) {
        return null;
      }

      // Calculate price from output amount
      // outputAmount is in quote token base units
      const outputAmount = Number(data.data.outputAmount);
      const price = outputAmount / Math.pow(10, quoteInfo.decimals);

      console.log(`[Raydium] ${pair}: price=${price}`);

      return {
        pair,
        price,
        liquidity: 0, // Not available from this API
        poolId: data.data.routePlan?.[0]?.poolId || '',
        poolType: 'swap',
      };

    } catch (e) {
      console.error(`[Raydium] Error fetching price for ${pair}:`, e);
      return null;
    }
  }

  async getPrices(pairs: string[]): Promise<Map<string, RaydiumPriceQuote>> {
    const results = new Map<string, RaydiumPriceQuote>();
    for (const pair of pairs) {
      const quote = await this.getPrice(pair);
      if (quote) {
        results.set(pair, quote);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return results;
  }
}
