import { PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import { ThrottledConnection } from './utils/throttled-connection.js';
import { logger } from './utils/logger.js';
import { findBestOpportunity, ArbitrageOpportunity } from './profit-calculator.js';
import { calculateOptimalAmount } from './dynamic-sizer.js';

/**
 * Trading pairs to monitor
 */
export const TRADING_PAIRS = [
  'SOL/USDC',
  'JUP/USDC',
  'JTO/USDC',
  'BONK/USDC',
  'WIF/USDC',
];

/**
 * Token mint addresses
 */
export const TOKEN_MINTS: Record<string, string> = {
  'SOL': 'So11111111111111111111111111111111111111112',
  'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'JUP': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'JTO': 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'WIF': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
};

// Token decimals for price calculation
export const TOKEN_DECIMALS: Record<string, number> = {
  'SOL': 9,
  'USDC': 6,
  'JUP': 6,
  'JTO': 9,
  'BONK': 5,
  'WIF': 6,
};

/**
 * DEX identifiers
 */
export const DEX_LIST = ['raydium', 'orca', 'meteora', 'phoenix'] as const;
export type DexName = typeof DEX_LIST[number];

/**
 * Price quote from a DEX
 */
export interface PriceQuote {
  dex: DexName;
  pair: string;
  price: number;
  liquidity: number;
  timestamp: number;
}

/**
 * Price cache to avoid redundant fetches
 */
interface PriceCache {
  quotes: Map<string, PriceQuote>;
  lastUpdate: number;
}

/**
 * Multi-DEX Price Scanner
 * Fetches prices from multiple DEXes and finds arbitrage opportunities
 */
export class Scanner {
  private connection: ThrottledConnection;
  private priceCache: PriceCache = { quotes: new Map(), lastUpdate: 0 };
  private readonly cacheDurationMs = 1000; // 1 second cache
  private scanCount = 0;
  private opportunitiesFound = 0;
  private jupiterApiKey: string;

  constructor(connection: ThrottledConnection) {
    this.connection = connection;
    this.jupiterApiKey = process.env.JUPITER_API_KEY || '';
  }

  /**
   * Fetch price quote from Jupiter API (aggregates all DEXes)
   */
  private async fetchJupiterQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: string
  ): Promise<{ price: number; routes: any[] } | null> {
    try {
      const url = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=50`;
      
      const headers: Record<string, string> = {};
      if (this.jupiterApiKey) {
        headers['x-api-key'] = this.jupiterApiKey;
      }
      
      const response = await fetch(url, { headers });
      if (!response.ok) {
        if (response.status === 429) {
          logger.warn('Jupiter API rate limited, waiting...');
          await this.sleep(1000);
          return null;
        }
        return null;
      }

      const data = await response.json();
      
      if (!data.outAmount) return null;

      const inputAmount = parseInt(amountLamports);
      const outputAmount = parseInt(data.outAmount);
      const price = outputAmount / inputAmount;

      return {
        price,
        routes: data.routePlan || [],
      };
    } catch (e) {
      logger.error(`Jupiter quote error: ${e}`);
      return null;
    }
  }

  /**
   * Fetch prices for a trading pair from all DEXes
   * Returns price in USDC per 1 token
   */
  async fetchPairPrices(pair: string): Promise<Map<DexName, PriceQuote>> {
    const quotes = new Map<DexName, PriceQuote>();
    const [base, quote] = pair.split('/');
    
    const baseMint = TOKEN_MINTS[base];
    const quoteMint = TOKEN_MINTS[quote];
    const baseDecimals = TOKEN_DECIMALS[base] || 9;
    const quoteDecimals = TOKEN_DECIMALS[quote] || 6;
    
    if (!baseMint || !quoteMint) {
      logger.error(`Unknown tokens in pair: ${pair}`);
      return quotes;
    }

    // Fetch price from each DEX individually for accuracy
    for (const dex of DEX_LIST) {
      try {
        // Quote: How much USDC do we get for 1 token?
        const oneToken = Math.pow(10, baseDecimals).toString();
        const url = `https://api.jup.ag/swap/v1/quote?inputMint=${baseMint}&outputMint=${quoteMint}&amount=${oneToken}&slippageBps=50&onlyDirectRoutes=true&dexes=${dex}`;
        
        const headers: Record<string, string> = {};
        if (this.jupiterApiKey) {
          headers['x-api-key'] = this.jupiterApiKey;
        }
        
        const response = await fetch(url, { headers });
        if (!response.ok) {
          if (response.status === 429) {
            logger.warn('Jupiter API rate limited, waiting...');
            await this.sleep(2000);
          }
          continue;
        }

        const data = await response.json();
        
        if (data.outAmount) {
          // Price = USDC received / 10^quoteDecimals (normalized to 1 USDC)
          const usdcReceived = parseInt(data.outAmount);
          const price = usdcReceived / Math.pow(10, quoteDecimals);
          
          // Sanity check - price should be reasonable
          if (price > 0 && price < 1000000) {
            quotes.set(dex, {
              dex,
              pair,
              price,
              liquidity: this.estimateLiquidity(dex, pair),
              timestamp: Date.now(),
            });
          }
        }
      } catch (e) {
        // Skip this DEX
      }

      // Rate limit: wait between requests
      await this.sleep(200);
    }

    return quotes;
  }

  /**
   * Fetch quotes from individual DEXes when Jupiter aggregation isn't enough
   */
  private async fetchIndividualDexQuotes(
    pair: string,
    baseMint: string,
    quoteMint: string,
    quotes: Map<DexName, PriceQuote>
  ): Promise<void> {
    // For each DEX not yet in quotes, try to get a direct quote
    for (const dex of DEX_LIST) {
      if (quotes.has(dex)) continue;

      try {
        // Use Jupiter with DEX filter
        const url = `https://api.jup.ag/swap/v1/quote?inputMint=${quoteMint}&outputMint=${baseMint}&amount=1000000000&slippageBps=50&onlyDirectRoutes=true&dexes=${dex}`;
        
        const headers: Record<string, string> = {};
        if (this.jupiterApiKey) {
          headers['x-api-key'] = this.jupiterApiKey;
        }
        
        const response = await fetch(url, { headers });
        if (!response.ok) continue;

        const data = await response.json();
        
        if (data.outAmount) {
          const inputAmount = 1000000000; // 1000 USDC
          const outputAmount = parseInt(data.outAmount);
          const price = inputAmount / outputAmount;

          quotes.set(dex, {
            dex,
            pair,
            price,
            liquidity: this.estimateLiquidity(dex, pair),
            timestamp: Date.now(),
          });
        }
      } catch (e) {
        // Skip this DEX
      }

      // Small delay between requests
      await this.sleep(50);
    }
  }

  /**
   * Normalize DEX name from Jupiter route labels
   */
  private normalizeDexName(label: string): string | null {
    const lower = label.toLowerCase();
    if (lower.includes('raydium')) return 'raydium';
    if (lower.includes('orca')) return 'orca';
    if (lower.includes('meteora')) return 'meteora';
    if (lower.includes('phoenix')) return 'phoenix';
    return null;
  }

  /**
   * Estimate liquidity for a DEX/pair combination
   * In production, this would fetch actual pool TVL
   */
  private estimateLiquidity(dex: DexName, pair: string): number {
    // Estimated liquidity in USD (simplified)
    const baseLiquidity: Record<string, number> = {
      'SOL/USDC': 50_000_000,
      'JUP/USDC': 10_000_000,
      'JTO/USDC': 5_000_000,
      'BONK/USDC': 3_000_000,
      'WIF/USDC': 2_000_000,
    };

    const dexMultiplier: Record<DexName, number> = {
      raydium: 1.0,
      orca: 0.8,
      meteora: 0.6,
      phoenix: 0.4,
    };

    return (baseLiquidity[pair] || 1_000_000) * (dexMultiplier[dex] || 0.5);
  }

  /**
   * Scan all pairs for arbitrage opportunities
   */
  async scanAllPairs(): Promise<ArbitrageOpportunity[]> {
    this.scanCount++;
    const opportunities: ArbitrageOpportunity[] = [];
    
    logger.scan(`Scanning ${TRADING_PAIRS.length} pairs across ${DEX_LIST.length} DEXes...`);

    for (const pair of TRADING_PAIRS) {
      try {
        const quotes = await this.fetchPairPrices(pair);
        
        if (quotes.size < 2) {
          continue; // Need at least 2 DEXes to arbitrage
        }

        // Convert to price and liquidity maps
        const prices = new Map<string, number>();
        const liquidities = new Map<string, number>();
        
        for (const [dex, quote] of quotes) {
          prices.set(dex, quote.price);
          liquidities.set(dex, quote.liquidity);
        }

        // Find best opportunity
        const opportunity = findBestOpportunity(
          pair,
          prices,
          liquidities,
          (p, liq, spread) => calculateOptimalAmount(p, liq, spread).amount
        );

        if (opportunity && opportunity.calculation.isProfitable) {
          this.opportunitiesFound++;
          opportunities.push(opportunity);
        }

      } catch (e) {
        logger.error(`Error scanning ${pair}: ${e}`);
      }

      // Small delay between pairs
      await this.sleep(100);
    }

    return opportunities;
  }

  /**
   * Get scanner statistics
   */
  getStats(): { scanCount: number; opportunitiesFound: number } {
    return {
      scanCount: this.scanCount,
      opportunitiesFound: this.opportunitiesFound,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
