/**
 * Cross-DEX Monitor - Event-based arbitrage detection
 * Listens to Raydium swap events and checks for Orca price differences
 * Does NOT use polling loops - only reacts to blockchain events
 */

import {
  Connection,
  PublicKey,
  Logs,
} from '@solana/web3.js';
import { recordTrade, botStats } from './api-server';
import { getPoolPrice } from './amm-swap';
import { discoverNewTokens, getDiscoveredTokens, DiscoveredToken } from './new-token-discovery';

// DEX Program IDs
const DEX_PROGRAMS = {
  raydium: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  pumpswap: new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'),
  orca: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'), // Whirlpool
};

// Pool addresses (for direct price reading - fallback to Jupiter if not available)
const POOLS: Record<string, any> = {
  'SOL/USDC': {
    raydium: new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'),
    orca: new PublicKey('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ'),
  },
  'JUP/SOL': {
    raydium: new PublicKey('BkLRfwsQeqFdvvLNgJFVWDJiTNU4BsPzLn8eFqFXrMzx'), // JUP/SOL Raydium
    orca: new PublicKey('HcjZvfeSNJbNkfLD4eEcRBr96AD3w1GpmMppaeRZf7ur'), // JUP/SOL Orca Whirlpool
  },
  'BONK/SOL': {
    raydium: new PublicKey('Hnt5TmTPpMx2Uf3APXFfsvMZfpqEvQmyByGwUvBPRey8'), // BONK/SOL Raydium
    orca: new PublicKey('5raXu2iqomFiGe5uMHTYmUVCnSyaDrRMBodLgsbFB3CN'), // BONK/SOL Orca Whirlpool  
  },
};

// DEX pairs for cross-DEX arbitrage
const DEX_PAIRS = [
  { dex1: 'raydium', dex2: 'orca', name: 'Raydium ↔ Orca' },
  { dex1: 'raydium', dex2: 'pumpswap', name: 'Raydium ↔ PumpSwap' },
  { dex1: 'orca', dex2: 'pumpswap', name: 'Orca ↔ PumpSwap' },
];

// Token mints
const TOKENS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  JUP: new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
  BONK: new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
};

// Static trading pairs to monitor
const STATIC_TRADING_PAIRS = [
  { name: 'SOL/USDC', tokenA: 'SOL', tokenB: 'USDC', decimalsA: 9, decimalsB: 6, mintA: 'So11111111111111111111111111111111111111112', mintB: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { name: 'JUP/SOL', tokenA: 'JUP', tokenB: 'SOL', decimalsA: 6, decimalsB: 9, mintA: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', mintB: 'So11111111111111111111111111111111111111112' },
  { name: 'BONK/SOL', tokenA: 'BONK', tokenB: 'SOL', decimalsA: 5, decimalsB: 9, mintA: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', mintB: 'So11111111111111111111111111111111111111112' },
];

// Dynamic trading pairs (static + discovered)
let TRADING_PAIRS = [...STATIC_TRADING_PAIRS];

// Cross-DEX specific stats
export interface CrossDexStats {
  eventsDetected: number;
  largeSwapsDetected: number;
  opportunitiesFound: number;
  opportunitiesExecuted: number;
  opportunitiesMissed: number;
  missedReasons: {
    latency: number;
    conflict: number;
    spreadTooLow: number;
    other: number;
  };
  lastEventTime: string | null;
  totalProfitUsd: number;
}

export const crossDexStats: CrossDexStats = {
  eventsDetected: 0,
  largeSwapsDetected: 0,
  opportunitiesFound: 0,
  opportunitiesExecuted: 0,
  opportunitiesMissed: 0,
  missedReasons: {
    latency: 0,
    conflict: 0,
    spreadTooLow: 0,
    other: 0,
  },
  lastEventTime: null,
  totalProfitUsd: 0,
};

// Callback type for when profitable opportunity is found
export type OpportunityCallback = (opportunity: CrossDexOpportunity) => Promise<boolean>;

export interface CrossDexOpportunity {
  pair: string;
  dex1: string;
  dex2: string;
  dex1Price: number;
  dex2Price: number;
  spreadPercent: number;
  potentialProfitUsd: number;
  direction: string; // e.g., 'raydium_to_orca', 'pumpswap_to_raydium', etc.
  timestamp: number;
  swapAmountUsd: number;
}

// Price cache to avoid rate limits
interface PriceCache {
  price: number;
  timestamp: number;
}

export class CrossDexMonitor {
  private connection: Connection;
  private subscriptionId: number | null = null;
  private onOpportunity: OpportunityCallback | null = null;
  private minSpreadPercent: number = 0.60; // 0.60% minimum - need to cover Raydium 0.25% + Orca 0.3% + buffer
  private minSwapUsd: number = 10000; // React to swaps >$10k (many more opportunities)
  private isRunning: boolean = false;
  
  // Rate limiting and caching
  private priceCache: Map<string, PriceCache> = new Map();
  private priceCacheTTL: number = 10000; // 10 seconds cache (reduce Jupiter 429)
  private lastPriceCheck: number = 0;
  private minCheckInterval: number = 8000; // 8 seconds between checks
  private pendingChecks: number = 0;
  private maxPendingChecks: number = 1; // Only 1 concurrent check (avoid 429)

  constructor(connection: Connection) {
    this.connection = connection;
  }

  setOpportunityCallback(callback: OpportunityCallback) {
    this.onOpportunity = callback;
  }

  /**
   * Refresh trading pairs by discovering new tokens
   */
  private async refreshTradingPairs(): Promise<void> {
    try {
      const discoveredTokens = await discoverNewTokens();
      
      // Start with static pairs
      TRADING_PAIRS = [...STATIC_TRADING_PAIRS];
      
      // Add discovered tokens as trading pairs
      for (const token of discoveredTokens) {
        const pairName = `${token.symbol}/SOL`;
        
        // Skip if already exists
        if (TRADING_PAIRS.some(p => p.name === pairName)) continue;
        
        // Add dynamic token to TOKENS map
        (TOKENS as any)[token.symbol] = new PublicKey(token.mint);
        
        TRADING_PAIRS.push({
          name: pairName,
          tokenA: token.symbol,
          tokenB: 'SOL',
          decimalsA: token.decimals,
          decimalsB: 9,
          mintA: token.mint,
          mintB: 'So11111111111111111111111111111111111111112',
        });
      }
      
      console.log(`📊 Monitoring ${TRADING_PAIRS.length} pairs (${STATIC_TRADING_PAIRS.length} static + ${discoveredTokens.length} discovered)`);
    } catch (error) {
      console.error('Error refreshing trading pairs:', error);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️ Cross-DEX Monitor already running');
      return;
    }

    console.log('\n🔗 Starting Cross-DEX Monitor (Event-Based)');
    
    // Discover new tokens on startup
    await this.refreshTradingPairs();
    
    console.log(`📡 Listening to DEX Programs:`);
    console.log(`   - Raydium: ${DEX_PROGRAMS.raydium.toString().slice(0, 8)}...`);
    console.log(`   - PumpSwap: ${DEX_PROGRAMS.pumpswap.toString().slice(0, 8)}...`);
    console.log(`   - Orca: ${DEX_PROGRAMS.orca.toString().slice(0, 8)}...`);
    console.log(`💰 Min swap size: $${this.minSwapUsd.toLocaleString()}`);
    console.log(`📊 Min spread: ${this.minSpreadPercent}%`);
    console.log(`🔀 Trading Pairs: ${TRADING_PAIRS.map(p => p.name).join(', ')}\n`);

    this.isRunning = true;
    
    // Refresh discovered tokens every 5 minutes
    setInterval(() => this.refreshTradingPairs(), 5 * 60 * 1000);

    // Subscribe to Raydium program logs
    this.subscriptionId = this.connection.onLogs(
      DEX_PROGRAMS.raydium,
      async (logs: Logs) => {
        await this.handleDexLogs(logs, 'raydium');
      },
      'confirmed'
    );

    // Subscribe to PumpSwap program logs
    const pumpswapSubId = this.connection.onLogs(
      DEX_PROGRAMS.pumpswap,
      async (logs: Logs) => {
        await this.handleDexLogs(logs, 'pumpswap');
      },
      'confirmed'
    );

    console.log(`✅ Cross-DEX Monitor subscribed:`);
    console.log(`   - Raydium (ID: ${this.subscriptionId})`);
    console.log(`   - PumpSwap (ID: ${pumpswapSubId})`);
  }

  async stop(): Promise<void> {
    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
      this.isRunning = false;
      console.log('🛑 Cross-DEX Monitor stopped');
    }
  }

  private async handleDexLogs(logs: Logs, sourceDex: string): Promise<void> {
    crossDexStats.eventsDetected++;
    crossDexStats.lastEventTime = new Date().toISOString();

    // Look for swap-related logs
    const isSwap = logs.logs.some(log => 
      log.includes('Instruction: Swap') || 
      log.includes('swap') ||
      log.includes('ray_log') ||
      log.includes('Sell') ||
      log.includes('Buy')
    );

    if (!isSwap) return;

    // Try to estimate swap size from logs (simplified - real implementation would parse properly)
    const swapSizeEstimate = this.estimateSwapSize(logs.logs);
    
    if (swapSizeEstimate < this.minSwapUsd) {
      return; // Ignore small swaps
    }

    crossDexStats.largeSwapsDetected++;

    // Silent mode - no log, just check for opportunities
    // Check for arbitrage opportunity across ALL trading pairs
    for (const pair of TRADING_PAIRS) {
      await this.checkAllDexPairs(pair.name, swapSizeEstimate, sourceDex);
    }
  }

  private estimateSwapSize(logs: string[]): number {
    // Simplified estimation based on log patterns
    // In production, you'd parse the actual instruction data
    for (const log of logs) {
      // Look for amount patterns in logs
      const amountMatch = log.match(/amount[:\s]+(\d+)/i);
      if (amountMatch) {
        const amount = parseInt(amountMatch[1]);
        // Rough estimation assuming USDC (6 decimals)
        if (amount > 1000000) {
          return amount / 1000000;
        }
      }
    }
    // Default: assume medium-sized swap to not miss opportunities
    // We'll filter by actual price check anyway
    return 150000; // Assume $150k to trigger price check
  }

  private async checkAllDexPairs(pair: string, swapAmountUsd: number, sourceDex: string): Promise<void> {
    const pairConfig = TRADING_PAIRS.find(p => p.name === pair);
    if (!pairConfig) return;

    // Throttle: skip if too many pending checks or too soon
    const now = Date.now();
    if (this.pendingChecks >= this.maxPendingChecks) {
      return;
    }
    if (now - this.lastPriceCheck < this.minCheckInterval) {
      return;
    }
    
    this.pendingChecks++;
    this.lastPriceCheck = now;

    try {
      // Fetch prices from Raydium & Orca via Jupiter
      const [raydiumPrice, orcaPrice] = await Promise.all([
        this.getCachedPrice(pairConfig.tokenA, pairConfig.tokenB, 'raydium'),
        this.getCachedPrice(pairConfig.tokenA, pairConfig.tokenB, 'orca'),
      ]);

      console.log(`📊 ${pair} prices:`);
      console.log(`   Raydium:  ${raydiumPrice ? `$${raydiumPrice.toFixed(4)}` : '❌'}`);
      console.log(`   Orca:     ${orcaPrice ? `$${orcaPrice.toFixed(4)}` : '❌'}`);

      // Find the best arbitrage opportunity across Raydium & Orca
      const prices: { dex: string; price: number }[] = [];
      if (raydiumPrice) prices.push({ dex: 'raydium', price: raydiumPrice });
      if (orcaPrice) prices.push({ dex: 'orca', price: orcaPrice });

      if (prices.length < 2) {
        console.log(`   ⚠️ Need at least 2 DEX prices`);
        return;
      }

      // Find min and max prices
      const minPrice = prices.reduce((a, b) => a.price < b.price ? a : b);
      const maxPrice = prices.reduce((a, b) => a.price > b.price ? a : b);
      
      const spreadPercent = ((maxPrice.price - minPrice.price) / minPrice.price) * 100;
      const potentialProfitUsd = (spreadPercent / 100) * swapAmountUsd;
      const direction = `${minPrice.dex}_to_${maxPrice.dex}`;

      console.log(`   Best spread: ${minPrice.dex.toUpperCase()} → ${maxPrice.dex.toUpperCase()}`);
      console.log(`   Spread: ${spreadPercent.toFixed(3)}% ($${potentialProfitUsd.toFixed(2)} potential)`);

      // Only record NOT profitable scans here - executor will record the result of profitable ones
      if (spreadPercent < this.minSpreadPercent) {
        recordTrade({
          pair,
          type: 'cross_dex',
          amount: swapAmountUsd,
          profit: potentialProfitUsd,
          profitUsd: potentialProfitUsd,
          status: 'not_profitable',
          txSignature: '',
          details: `${minPrice.dex} → ${maxPrice.dex}: Spread ${spreadPercent.toFixed(3)}% (need >${this.minSpreadPercent}%)`,
        });
        console.log(`   Status: ❌ Not profitable (need >${this.minSpreadPercent}%)`);
        crossDexStats.missedReasons.spreadTooLow++;
        crossDexStats.opportunitiesMissed++;
        return;
      }

      // PROFITABLE OPPORTUNITY!
      crossDexStats.opportunitiesFound++;
      console.log(`\n💰 PROFITABLE OPPORTUNITY DETECTED!`);
      console.log(`   Buy on: ${minPrice.dex.toUpperCase()} @ $${minPrice.price.toFixed(4)}`);
      console.log(`   Sell on: ${maxPrice.dex.toUpperCase()} @ $${maxPrice.price.toFixed(4)}`);
      console.log(`   Spread: ${spreadPercent.toFixed(3)}%`);

      const opportunity: CrossDexOpportunity = {
        pair,
        dex1: minPrice.dex,
        dex2: maxPrice.dex,
        dex1Price: minPrice.price,
        dex2Price: maxPrice.price,
        spreadPercent,
        potentialProfitUsd,
        direction,
        timestamp: Date.now(),
        swapAmountUsd,
      };

      // Execute via callback
      if (this.onOpportunity) {
        console.log(`   Action: Attempting ${minPrice.dex} → ${maxPrice.dex} arbitrage...`);
        this.onOpportunity(opportunity)
          .then(success => {
            if (success) {
              console.log(`   Result: ✅ Success`);
              crossDexStats.opportunitiesExecuted++;
            } else {
              console.log(`   Result: ❌ Failed`);
              crossDexStats.opportunitiesMissed++;
            }
          })
          .catch(err => {
            console.log(`   Result: ❌ Error: ${err}`);
            crossDexStats.opportunitiesMissed++;
          });
      }
    } finally {
      this.pendingChecks--;
    }
  }

  private async checkOpportunity(pair: string, swapAmountUsd: number): Promise<void> {
    const pool = POOLS[pair as keyof typeof POOLS];
    if (!pool) return;

    // Throttle: skip if too many pending checks or too soon
    const now = Date.now();
    if (this.pendingChecks >= this.maxPendingChecks) {
      return; // Skip silently - too many pending
    }
    if (now - this.lastPriceCheck < this.minCheckInterval) {
      return; // Skip silently - too soon
    }
    
    this.pendingChecks++;
    this.lastPriceCheck = now;

    try {
      // Fetch prices (with caching)
      const [raydiumPrice, orcaPrice] = await Promise.all([
        this.getCachedPrice(pool.tokenA, pool.tokenB, 'raydium'),
        this.getCachedPrice(pool.tokenA, pool.tokenB, 'orca'),
      ]);

      if (raydiumPrice === null || orcaPrice === null) {
        console.log(`   ⚠️ Could not fetch prices`);
        return;
      }

      // Calculate spread
      const spreadPercent = Math.abs((raydiumPrice - orcaPrice) / Math.min(raydiumPrice, orcaPrice)) * 100;
      const potentialProfitUsd = (spreadPercent / 100) * swapAmountUsd;
      const direction = raydiumPrice < orcaPrice ? 'raydium_to_orca' : 'orca_to_raydium';

      console.log(`📊 ${pair}:`);
      console.log(`   Raydium: $${raydiumPrice.toFixed(4)}`);
      console.log(`   Orca:    $${orcaPrice.toFixed(4)}`);
      console.log(`   Spread:  ${spreadPercent.toFixed(3)}% ($${potentialProfitUsd.toFixed(2)} potential)`);

      // Log the opportunity
      recordTrade({
        pair,
        type: 'cross_dex_opportunity',
        amount: swapAmountUsd,
        profit: potentialProfitUsd,
        profitUsd: potentialProfitUsd,
        status: spreadPercent >= this.minSpreadPercent ? 'opportunity_detected' : 'not_profitable',
        txSignature: '',
        details: `Spread: ${spreadPercent.toFixed(3)}%, Direction: ${direction}`,
      });

      if (spreadPercent < this.minSpreadPercent) {
        console.log(`   Status:  ❌ Not profitable (need >${this.minSpreadPercent}%)`);
        crossDexStats.missedReasons.spreadTooLow++;
        crossDexStats.opportunitiesMissed++;
        return;
      }

      // PROFITABLE OPPORTUNITY!
      crossDexStats.opportunitiesFound++;
      console.log(`\n💰 PROFITABLE OPPORTUNITY DETECTED!`);
      console.log(`   Spread: ${spreadPercent.toFixed(3)}% ($${potentialProfitUsd.toFixed(2)} potential)`);
      console.log(`   Direction: Buy on ${direction === 'raydium_to_orca' ? 'Raydium' : 'Orca'}, Sell on ${direction === 'raydium_to_orca' ? 'Orca' : 'Raydium'}`);

      const opportunity: CrossDexOpportunity = {
        pair,
        dex1: 'raydium',
        dex2: 'orca',
        dex1Price: raydiumPrice,
        dex2Price: orcaPrice,
        spreadPercent,
        potentialProfitUsd,
        direction,
        timestamp: Date.now(),
        swapAmountUsd,
      };

      // Execute via callback (will go through mutex)
      if (this.onOpportunity) {
        console.log(`   Action: Attempting cross-DEX arbitrage...`);
        
        // Fire and forget - don't block event processing
        this.onOpportunity(opportunity)
          .then(success => {
            if (success) {
              console.log(`   Result: ✅ Success`);
              crossDexStats.opportunitiesExecuted++;
            } else {
              console.log(`   Result: ❌ Failed (likely conflict or latency)`);
              crossDexStats.opportunitiesMissed++;
              crossDexStats.missedReasons.conflict++;
            }
          })
          .catch(err => {
            console.log(`   Result: ❌ Error: ${err.message}`);
            crossDexStats.opportunitiesMissed++;
            crossDexStats.missedReasons.other++;
          });
      }

    } catch (error) {
      console.log(`   ⚠️ Error checking opportunity: ${error}`);
    } finally {
      this.pendingChecks--;
    }
  }

  private async getCachedPrice(tokenA: string, tokenB: string, source: string): Promise<number | null> {
    const cacheKey = `${tokenA}-${tokenB}-${source}`;
    const cached = this.priceCache.get(cacheKey);
    const now = Date.now();
    
    // Return cached price if still valid (10s cache to reduce 429)
    if (cached && (now - cached.timestamp) < this.priceCacheTTL) {
      return cached.price;
    }
    
    // Use Jupiter for all pairs and DEXes (most reliable)
    const price = await this.fetchPrice(tokenA, tokenB);
    if (price !== null) {
      this.priceCache.set(cacheKey, { price, timestamp: now });
    }
    return price;
  }

  private async fetchPrice(tokenA: string, tokenB: string): Promise<number | null> {
    try {
      // Find pair config for decimals and mints
      const pairConfig = TRADING_PAIRS.find(p => p.tokenA === tokenA && p.tokenB === tokenB);
      if (!pairConfig) return null;
      
      // Use mintA/mintB from pair config (supports dynamic tokens)
      const inputMint = pairConfig.mintA;
      const outputMint = pairConfig.mintB;
      const inputDecimals = pairConfig.decimalsA;
      const outputDecimals = pairConfig.decimalsB;
      const amount = Math.pow(10, inputDecimals); // 1 unit of tokenA
      
      const apiKey = process.env.JUPITER_API_KEY || '1605a29f-3095-43b5-ab87-cbb29975bd36';
      const response = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`,
        { headers: { 'Accept': 'application/json', 'x-api-key': apiKey } }
      );
      
      if (!response.ok) {
        return null;
      }
      
      const data = await response.json() as { outAmount?: string };
      
      if (data.outAmount) {
        // Price = outAmount / 10^outputDecimals (price of 1 tokenA in tokenB)
        return parseInt(data.outAmount) / Math.pow(10, outputDecimals);
      }
      
      return null;
    } catch (err) {
      return null;
    }
  }

  getStats(): CrossDexStats {
    return { ...crossDexStats };
  }
}

export default CrossDexMonitor;
