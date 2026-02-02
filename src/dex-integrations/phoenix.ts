/**
 * Phoenix DEX Integration
 * Uses official @ellipsis-labs/phoenix-sdk
 * Documentation: https://github.com/Ellipsis-Labs/phoenix-sdk
 */

import { Connection, PublicKey } from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';

// Token mint addresses
const TOKEN_MINTS: Record<string, string> = {
  'SOL': 'So11111111111111111111111111111111111111112',
  'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'JUP': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'JTO': 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'WIF': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
};

export interface PhoenixPriceQuote {
  pair: string;
  price: number;
  bidPrice: number;
  askPrice: number;
  spread: number;
  liquidity: number;
  marketId: string;
}

/**
 * Phoenix DEX client for fetching orderbook prices
 * Phoenix is a CLOB (Central Limit Order Book) DEX
 */
export class PhoenixClient {
  private connection: Connection;
  private client: Phoenix.Client | null = null;
  private initialized = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Initialize the Phoenix SDK
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create Phoenix client
      this.client = await Phoenix.Client.create(this.connection);
      this.initialized = true;
      console.log('[Phoenix] SDK initialized');
      console.log(`[Phoenix] Found ${this.client.marketConfigs.length} markets`);
    } catch (e) {
      console.error('[Phoenix] Failed to initialize SDK:', e);
      throw e;
    }
  }

  /**
   * Get price for a trading pair from Phoenix orderbook
   * Returns price in quote tokens (USDC) per 1 base token
   */
  async getPrice(pair: string): Promise<PhoenixPriceQuote | null> {
    if (!this.client) {
      await this.initialize();
    }

    // Map our pair format to Phoenix market name
    const phoenixMarketName = pair.replace('/', '-');

    try {
      // Find market config for this pair
      const marketConfig = this.client!.marketConfigs.find(
        (market) => market.name === phoenixMarketName || market.name === pair
      );

      if (!marketConfig) {
        // Phoenix may not have all pairs
        return null;
      }

      // Get market state
      const marketState = this.client!.marketStates.get(marketConfig.marketId);
      if (!marketState) {
        console.error(`[Phoenix] Market state not found for ${pair}`);
        return null;
      }

      // Refresh market data
      await marketState.refresh(this.connection);

      // Get orderbook data
      const ladder = marketState.getUiLadder(5); // Top 5 levels

      if (!ladder.bids.length || !ladder.asks.length) {
        console.error(`[Phoenix] Empty orderbook for ${pair}`);
        return null;
      }

      // Best bid and ask prices
      const bestBid = ladder.bids[0];
      const bestAsk = ladder.asks[0];

      const bidPrice = bestBid.price;
      const askPrice = bestAsk.price;
      const midPrice = (bidPrice + askPrice) / 2;
      const spread = (askPrice - bidPrice) / midPrice;

      // Estimate liquidity from orderbook depth
      let totalBidLiquidity = 0;
      let totalAskLiquidity = 0;

      for (const bid of ladder.bids) {
        totalBidLiquidity += bid.quantity * bid.price;
      }
      for (const ask of ladder.asks) {
        totalAskLiquidity += ask.quantity * ask.price;
      }

      const liquidity = totalBidLiquidity + totalAskLiquidity;

      return {
        pair,
        price: midPrice,
        bidPrice,
        askPrice,
        spread,
        liquidity,
        marketId: marketConfig.marketId,
      };

    } catch (e) {
      console.error(`[Phoenix] Error fetching price for ${pair}:`, e);
      return null;
    }
  }

  /**
   * Get prices for multiple pairs
   */
  async getPrices(pairs: string[]): Promise<Map<string, PhoenixPriceQuote>> {
    const results = new Map<string, PhoenixPriceQuote>();

    for (const pair of pairs) {
      const quote = await this.getPrice(pair);
      if (quote) {
        results.set(pair, quote);
      }
    }

    return results;
  }
}
