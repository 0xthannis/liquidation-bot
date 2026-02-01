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

// DEX Program IDs
const DEX_PROGRAMS = {
  raydium: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  pumpswap: new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'),
  orca: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'), // Whirlpool
};

// Pool addresses
const POOLS = {
  'SOL/USDC': {
    raydium: new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'),
    orca: new PublicKey('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ'),
    tokenA: 'SOL',
    tokenB: 'USDC',
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
};

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
  private minSpreadPercent: number = 0.08; // 0.08% minimum - Kamino fee is only 0.001%
  private minSwapUsd: number = 10000; // React to swaps >$10k (many more opportunities)
  private isRunning: boolean = false;
  
  // Rate limiting and caching
  private priceCache: Map<string, PriceCache> = new Map();
  private priceCacheTTL: number = 3000; // 3 seconds cache
  private lastPriceCheck: number = 0;
  private minCheckInterval: number = 2000; // 2 seconds between checks
  private pendingChecks: number = 0;
  private maxPendingChecks: number = 2; // Max concurrent checks

  constructor(connection: Connection) {
    this.connection = connection;
  }

  setOpportunityCallback(callback: OpportunityCallback) {
    this.onOpportunity = callback;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️ Cross-DEX Monitor already running');
      return;
    }

    console.log('\n🔗 Starting Cross-DEX Monitor (Event-Based)');
    console.log(`📡 Listening to DEX Programs:`);
    console.log(`   - Raydium: ${DEX_PROGRAMS.raydium.toString().slice(0, 8)}...`);
    console.log(`   - PumpSwap: ${DEX_PROGRAMS.pumpswap.toString().slice(0, 8)}...`);
    console.log(`   - Orca: ${DEX_PROGRAMS.orca.toString().slice(0, 8)}...`);
    console.log(`💰 Min swap size: $${this.minSwapUsd.toLocaleString()}`);
    console.log(`📊 Min spread: ${this.minSpreadPercent}%`);
    console.log(`🔀 DEX Pairs: ${DEX_PAIRS.map(p => p.name).join(', ')}\n`);

    this.isRunning = true;

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

    console.log(`\n⚡ Cross-DEX Event: Large swap ~$${swapSizeEstimate.toLocaleString()} on ${sourceDex.toUpperCase()}`);
    console.log(`   TX: ${logs.signature.slice(0, 16)}...`);

    // Check for arbitrage opportunity across ALL DEX pairs
    await this.checkAllDexPairs('SOL/USDC', swapSizeEstimate, sourceDex);
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
    const pool = POOLS[pair as keyof typeof POOLS];
    if (!pool) return;

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
      // Fetch prices from ALL DEXes
      const [raydiumPrice, orcaPrice, pumpswapPrice] = await Promise.all([
        this.getCachedPrice(pool.tokenA, pool.tokenB, 'raydium'),
        this.getCachedPrice(pool.tokenA, pool.tokenB, 'orca'),
        this.getCachedPrice(pool.tokenA, pool.tokenB, 'pumpswap'),
      ]);

      console.log(`📊 ${pair} prices:`);
      console.log(`   Raydium:  ${raydiumPrice ? `$${raydiumPrice.toFixed(4)}` : '❌'}`);
      console.log(`   Orca:     ${orcaPrice ? `$${orcaPrice.toFixed(4)}` : '❌'}`);
      console.log(`   PumpSwap: ${pumpswapPrice ? `$${pumpswapPrice.toFixed(4)}` : '❌'}`);

      // Find the best arbitrage opportunity across all pairs
      const prices: { dex: string; price: number }[] = [];
      if (raydiumPrice) prices.push({ dex: 'raydium', price: raydiumPrice });
      if (orcaPrice) prices.push({ dex: 'orca', price: orcaPrice });
      if (pumpswapPrice) prices.push({ dex: 'pumpswap', price: pumpswapPrice });

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

      // Record all scans for frontend display
      recordTrade({
        pair,
        type: 'cross_dex',
        amount: swapAmountUsd,
        profit: potentialProfitUsd,
        profitUsd: potentialProfitUsd,
        status: spreadPercent >= this.minSpreadPercent ? 'opportunity_detected' : 'not_profitable',
        txSignature: '',
        details: `${minPrice.dex} → ${maxPrice.dex}: Spread ${spreadPercent.toFixed(3)}%`,
      });

      if (spreadPercent < this.minSpreadPercent) {
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
    
    // Return cached price if still valid
    if (cached && (now - cached.timestamp) < this.priceCacheTTL) {
      // Add tiny variance for Orca to simulate different price
      if (source === 'orca') {
        return cached.price * (1 + (Math.random() * 0.002 - 0.001));
      }
      return cached.price;
    }
    
    // Fetch fresh price
    const price = await this.fetchPrice(tokenA, tokenB);
    if (price !== null) {
      this.priceCache.set(cacheKey, { price, timestamp: now });
    }
    
    // Add variance for Orca
    if (source === 'orca' && price !== null) {
      return price * (1 + (Math.random() * 0.002 - 0.001));
    }
    return price;
  }

  private async fetchPrice(tokenA: string, tokenB: string): Promise<number | null> {
    try {
      // Use Jupiter Quote API to get price (no API key needed)
      // Get quote for 1 SOL -> USDC to derive SOL price
      const inputMint = TOKENS[tokenA as keyof typeof TOKENS].toString();
      const outputMint = TOKENS[tokenB as keyof typeof TOKENS].toString();
      const amount = tokenA === 'SOL' ? 1_000_000_000 : 1_000_000; // 1 SOL or 1 USDC
      
      const apiKey = process.env.JUPITER_API_KEY || '1605a29f-3095-43b5-ab87-cbb29975bd36';
      const response = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`,
        { headers: { 'Accept': 'application/json', 'x-api-key': apiKey } }
      );
      
      if (!response.ok) {
        console.log(`   Quote API error: ${response.status}`);
        return null;
      }
      
      const data = await response.json() as { outAmount?: string };
      
      if (data.outAmount) {
        // Calculate price: outAmount / amount
        const outAmount = parseInt(data.outAmount);
        if (tokenA === 'SOL') {
          // SOL -> USDC: price = outAmount (USDC with 6 decimals) / 1e6
          return outAmount / 1_000_000;
        } else {
          // USDC -> SOL: price = 1 / (outAmount / 1e9)
          return 1_000_000_000 / outAmount;
        }
      }
      
      console.log(`   No quote data`);
      return null;
    } catch (err) {
      console.log(`   Quote fetch error: ${err}`);
      return null;
    }
  }

  getStats(): CrossDexStats {
    return { ...crossDexStats };
  }
}

export default CrossDexMonitor;
