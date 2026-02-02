/**
 * Multi-DEX Price Scanner
 * Uses native DEX SDKs for accurate price fetching
 * Supports: Raydium, Orca, Phoenix
 */

import { Connection } from '@solana/web3.js';
import { logger } from './utils/logger.js';
import { findBestOpportunity, ArbitrageOpportunity } from './profit-calculator.js';
import { calculateOptimalAmount } from './dynamic-sizer.js';
import { RaydiumClient } from './dex-integrations/raydium.js';
import { OrcaClient } from './dex-integrations/orca.js';
import { PhoenixClient } from './dex-integrations/phoenix.js';

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
 * DEX identifiers - 3 DEXes with direct SDK access
 */
export const DEX_LIST = ['raydium', 'orca', 'phoenix'] as const;
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
 * Multi-DEX Price Scanner
 * Fetches prices from multiple DEXes using their native SDKs
 */
export class Scanner {
  private connection: Connection;
  private raydiumClient: RaydiumClient;
  private orcaClient: OrcaClient;
  private phoenixClient: PhoenixClient;
  private scanCount = 0;
  private opportunitiesFound = 0;
  private initialized = false;

  constructor(connection: Connection) {
    this.connection = connection;
    this.raydiumClient = new RaydiumClient(connection);
    this.orcaClient = new OrcaClient(connection);
    this.phoenixClient = new PhoenixClient(connection);
  }

  /**
   * Initialize all DEX clients
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing DEX clients...');
    
    try {
      // Initialize all DEX clients in parallel
      const results = await Promise.allSettled([
        this.raydiumClient.initialize(),
        this.orcaClient.initialize(),
        this.phoenixClient.initialize(),
      ]);

      // Log any initialization failures
      const dexNames = ['Raydium', 'Orca', 'Phoenix'];
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.warn(`${dexNames[index]} init failed: ${result.reason}`);
        }
      });

      this.initialized = true;
      logger.info('DEX clients initialization complete');
    } catch (e) {
      logger.error(`Failed to initialize DEX clients: ${e}`);
    }
  }

  /**
   * Fetch prices for a trading pair from all DEXes
   * Returns price in USDC per 1 token
   */
  async fetchPairPrices(pair: string): Promise<Map<DexName, PriceQuote>> {
    const quotes = new Map<DexName, PriceQuote>();

    // Fetch from each DEX in parallel
    const [raydiumQuote, orcaQuote, phoenixQuote] = await Promise.all([
      this.raydiumClient.getPrice(pair).catch(() => null),
      this.orcaClient.getPrice(pair).catch(() => null),
      this.phoenixClient.getPrice(pair).catch(() => null),
    ]);

    // Add Raydium quote
    if (raydiumQuote && raydiumQuote.price > 0) {
      quotes.set('raydium', {
        dex: 'raydium',
        pair,
        price: raydiumQuote.price,
        liquidity: raydiumQuote.liquidity,
        timestamp: Date.now(),
      });
    }

    // Add Orca quote
    if (orcaQuote && orcaQuote.price > 0) {
      quotes.set('orca', {
        dex: 'orca',
        pair,
        price: orcaQuote.price,
        liquidity: orcaQuote.liquidity,
        timestamp: Date.now(),
      });
    }

    // Add Phoenix quote
    if (phoenixQuote && phoenixQuote.price > 0) {
      quotes.set('phoenix', {
        dex: 'phoenix',
        pair,
        price: phoenixQuote.price,
        liquidity: phoenixQuote.liquidity,
        timestamp: Date.now(),
      });
    }

    return quotes;
  }

  /**
   * Scan all pairs for arbitrage opportunities
   */
  async scanAllPairs(): Promise<ArbitrageOpportunity[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    this.scanCount++;
    const opportunities: ArbitrageOpportunity[] = [];
    
    logger.scan(`Scanning ${TRADING_PAIRS.length} pairs across ${DEX_LIST.length} DEXes...`);

    for (const pair of TRADING_PAIRS) {
      try {
        const quotes = await this.fetchPairPrices(pair);
        
        if (quotes.size < 2) {
          continue; // Need at least 2 DEXes to arbitrage
        }

        // Log prices for debugging
        for (const [dex, quote] of quotes) {
          logger.debug(`${pair} ${dex}: $${quote.price.toFixed(6)}`);
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
          
          logger.opportunity(`${pair} ${(opportunity.spreadPercent * 100).toFixed(2)}% spread`);
          logger.info(`   Buy: ${opportunity.buyDex} ($${opportunity.buyPrice.toFixed(4)})`);
          logger.info(`   Sell: ${opportunity.sellDex} ($${opportunity.sellPrice.toFixed(4)})`);
          logger.info(`   Expected profit: $${opportunity.calculation.netProfit.toFixed(2)}`);
        }

      } catch (e) {
        logger.error(`Error scanning ${pair}: ${e}`);
      }
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
}
