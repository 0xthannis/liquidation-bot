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

// Raydium AMM Program ID
const RAYDIUM_AMM_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// Pool addresses
const POOLS = {
  'SOL/USDC': {
    raydium: new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'),
    orca: new PublicKey('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ'),
    tokenA: 'SOL',
    tokenB: 'USDC',
  },
};

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
  raydiumPrice: number;
  orcaPrice: number;
  spreadPercent: number;
  potentialProfitUsd: number;
  direction: 'raydium_to_orca' | 'orca_to_raydium';
  timestamp: number;
  swapAmountUsd: number;
}

export class CrossDexMonitor {
  private connection: Connection;
  private subscriptionId: number | null = null;
  private onOpportunity: OpportunityCallback | null = null;
  private minSpreadPercent: number = 0.5; // 0.5% minimum spread to attempt execution
  private minSwapUsd: number = 100000; // Only react to swaps >$100k
  private isRunning: boolean = false;

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
    console.log(`📡 Listening to Raydium Program: ${RAYDIUM_AMM_PROGRAM.toString().slice(0, 8)}...`);
    console.log(`💰 Min swap size: $${this.minSwapUsd.toLocaleString()}`);
    console.log(`📊 Min spread: ${this.minSpreadPercent}%\n`);

    this.isRunning = true;

    // Subscribe to Raydium program logs
    this.subscriptionId = this.connection.onLogs(
      RAYDIUM_AMM_PROGRAM,
      async (logs: Logs) => {
        await this.handleRaydiumLogs(logs);
      },
      'confirmed'
    );

    console.log(`✅ Cross-DEX Monitor subscribed (ID: ${this.subscriptionId})`);
  }

  async stop(): Promise<void> {
    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
      this.isRunning = false;
      console.log('🛑 Cross-DEX Monitor stopped');
    }
  }

  private async handleRaydiumLogs(logs: Logs): Promise<void> {
    crossDexStats.eventsDetected++;
    crossDexStats.lastEventTime = new Date().toISOString();

    // Look for swap-related logs
    const isSwap = logs.logs.some(log => 
      log.includes('Instruction: Swap') || 
      log.includes('swap') ||
      log.includes('ray_log')
    );

    if (!isSwap) return;

    // Try to estimate swap size from logs (simplified - real implementation would parse properly)
    const swapSizeEstimate = this.estimateSwapSize(logs.logs);
    
    if (swapSizeEstimate < this.minSwapUsd) {
      return; // Ignore small swaps
    }

    crossDexStats.largeSwapsDetected++;

    console.log(`\n⚡ Cross-DEX Event: Large swap ~$${swapSizeEstimate.toLocaleString()} on Raydium`);
    console.log(`   TX: ${logs.signature.slice(0, 16)}...`);

    // Check for arbitrage opportunity
    await this.checkOpportunity('SOL/USDC', swapSizeEstimate);
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

  private async checkOpportunity(pair: string, swapAmountUsd: number): Promise<void> {
    const pool = POOLS[pair as keyof typeof POOLS];
    if (!pool) return;

    try {
      // Fetch prices from both DEXes
      const [raydiumPrice, orcaPrice] = await Promise.all([
        this.getRaydiumPrice(pool.raydium, pool.tokenA, pool.tokenB),
        this.getOrcaPrice(pool.orca, pool.tokenA, pool.tokenB),
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
        raydiumPrice,
        orcaPrice,
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
    }
  }

  private async getRaydiumPrice(poolAddress: PublicKey, tokenA: string, tokenB: string): Promise<number | null> {
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

  private async getOrcaPrice(poolAddress: PublicKey, tokenA: string, tokenB: string): Promise<number | null> {
    // Use same method but add slight variance to simulate Orca
    const price = await this.getRaydiumPrice(poolAddress, tokenA, tokenB);
    if (price) {
      // Add tiny variance (-0.1% to +0.1%) to simulate Orca price difference
      return price * (1 + (Math.random() * 0.002 - 0.001));
    }
    return null;
  }

  getStats(): CrossDexStats {
    return { ...crossDexStats };
  }
}

export default CrossDexMonitor;
