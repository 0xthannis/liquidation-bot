/**
 * Arbitrage Engine - Orchestrates Round-Trip and Cross-DEX engines
 * Implements mutex to prevent concurrent transaction execution
 */

import { Connection, Keypair } from '@solana/web3.js';
import { KaminoMarket } from '@kamino-finance/klend-sdk';
import CrossDexMonitor, { CrossDexOpportunity, crossDexStats } from './cross-dex-monitor';
import { CrossDexExecutor } from './cross-dex-executor';
import { botStats, recordTrade } from './api-server';

// Mutex state
let isExecutingTrade = false;
let lastTradeTime = 0;
const COOLDOWN_MS = 2000; // 2 seconds between trades

// Engine stats
export interface EngineStats {
  roundTrip: {
    scans: number;
    opportunities: number;
    executed: number;
    skippedByMutex: number;
  };
  crossDex: {
    events: number;
    opportunities: number;
    executed: number;
    skippedByMutex: number;
  };
  mutex: {
    currentlyLocked: boolean;
    lastLockTime: number;
    totalLocks: number;
  };
}

export const engineStats: EngineStats = {
  roundTrip: {
    scans: 0,
    opportunities: 0,
    executed: 0,
    skippedByMutex: 0,
  },
  crossDex: {
    events: 0,
    opportunities: 0,
    executed: 0,
    skippedByMutex: 0,
  },
  mutex: {
    currentlyLocked: false,
    lastLockTime: 0,
    totalLocks: 0,
  },
};

/**
 * Execute a trade with mutex protection
 * Returns true if executed, false if skipped
 */
export async function executeWithLock(
  type: 'round_trip' | 'cross_dex',
  fn: () => Promise<boolean>
): Promise<boolean> {
  // Check if already executing
  if (isExecutingTrade) {
    console.log(`⏭️ ${type}: Skipped (trade in progress)`);
    if (type === 'round_trip') {
      engineStats.roundTrip.skippedByMutex++;
    } else {
      engineStats.crossDex.skippedByMutex++;
    }
    return false;
  }

  // Check cooldown
  const timeSinceLastTrade = Date.now() - lastTradeTime;
  if (timeSinceLastTrade < COOLDOWN_MS) {
    console.log(`⏭️ ${type}: Skipped (cooldown: ${COOLDOWN_MS - timeSinceLastTrade}ms remaining)`);
    if (type === 'round_trip') {
      engineStats.roundTrip.skippedByMutex++;
    } else {
      engineStats.crossDex.skippedByMutex++;
    }
    return false;
  }

  // Acquire lock
  try {
    isExecutingTrade = true;
    engineStats.mutex.currentlyLocked = true;
    engineStats.mutex.lastLockTime = Date.now();
    engineStats.mutex.totalLocks++;
    lastTradeTime = Date.now();

    console.log(`🔒 ${type}: Acquired mutex lock`);
    
    const result = await fn();
    
    if (result) {
      if (type === 'round_trip') {
        engineStats.roundTrip.executed++;
      } else {
        engineStats.crossDex.executed++;
      }
    }
    
    return result;
  } catch (error) {
    console.error(`❌ ${type}: Execution error:`, error);
    return false;
  } finally {
    isExecutingTrade = false;
    engineStats.mutex.currentlyLocked = false;
    console.log(`🔓 ${type}: Released mutex lock`);
  }
}

/**
 * Check if mutex is available (for non-blocking checks)
 */
export function isMutexAvailable(): boolean {
  if (isExecutingTrade) return false;
  if (Date.now() - lastTradeTime < COOLDOWN_MS) return false;
  return true;
}

/**
 * Main Arbitrage Engine class
 */
export class ArbitrageEngine {
  private connection: Connection;
  private keypair: Keypair;
  private market: KaminoMarket | null = null;
  private crossDexMonitor: CrossDexMonitor;
  private crossDexExecutor: CrossDexExecutor;
  private isRunning = false;

  constructor(connection: Connection, keypair: Keypair) {
    this.connection = connection;
    this.keypair = keypair;
    this.crossDexMonitor = new CrossDexMonitor(connection);
    this.crossDexExecutor = new CrossDexExecutor(connection, keypair);

    // Set up cross-DEX opportunity callback
    this.crossDexMonitor.setOpportunityCallback(
      this.handleCrossDexOpportunity.bind(this)
    );
  }

  async initialize(market: KaminoMarket): Promise<void> {
    this.market = market;
    await this.crossDexExecutor.initialize(market);
    console.log('\n🚀 Arbitrage Engine initialized');
    console.log('   - Round-Trip: Ready (uses existing flash-arb.ts)');
    console.log('   - Cross-DEX: Ready (REAL execution with Kamino)');
    console.log('   - Mutex: Active (2s cooldown)\n');
  }

  async startCrossDexMonitor(): Promise<void> {
    if (!this.market) {
      throw new Error('Engine not initialized. Call initialize() first.');
    }

    await this.crossDexMonitor.start();
    this.isRunning = true;
  }

  async stopCrossDexMonitor(): Promise<void> {
    await this.crossDexMonitor.stop();
    this.isRunning = false;
  }

  /**
   * Handle cross-DEX opportunity (called by monitor)
   * This goes through the mutex
   */
  private async handleCrossDexOpportunity(
    opportunity: CrossDexOpportunity
  ): Promise<boolean> {
    engineStats.crossDex.opportunities++;

    return executeWithLock('cross_dex', async () => {
      return this.executeCrossDexArbitrage(opportunity);
    });
  }

  /**
   * Execute cross-DEX arbitrage using real Kamino flash loans
   */
  private async executeCrossDexArbitrage(
    opportunity: CrossDexOpportunity
  ): Promise<boolean> {
    try {
      // Use the real executor with Kamino flash loans
      return await this.crossDexExecutor.execute(opportunity);
    } catch (error) {
      console.error(`   ❌ Error:`, error);
      
      crossDexStats.opportunitiesMissed++;
      crossDexStats.missedReasons.other++;

      recordTrade({
        pair: opportunity.pair,
        type: 'cross_dex',
        amount: opportunity.swapAmountUsd,
        profit: 0,
        profitUsd: 0,
        status: 'cross_dex_failed',
        details: `Error: ${error}`,
      });

      return false;
    }
  }

  /**
   * Get combined stats from all engines
   */
  getStats() {
    return {
      engine: engineStats,
      crossDex: this.crossDexMonitor.getStats(),
      roundTrip: {
        scans: botStats.scansToday,
        totalTrades: botStats.totalTrades,
      },
    };
  }

  /**
   * Log stats summary (call every N scans)
   */
  logStatsSummary(): void {
    const cdStats = this.crossDexMonitor.getStats();
    
    console.log('\n📈 ═══════════════════════════════════════════');
    console.log('   ARBITRAGE ENGINE STATS');
    console.log('═══════════════════════════════════════════════');
    console.log(`   Round-Trip:`);
    console.log(`     Scans: ${botStats.scansToday}`);
    console.log(`     Executed: ${engineStats.roundTrip.executed}`);
    console.log(`     Skipped (mutex): ${engineStats.roundTrip.skippedByMutex}`);
    console.log(`   Cross-DEX:`);
    console.log(`     Events: ${cdStats.eventsDetected}`);
    console.log(`     Large Swaps: ${cdStats.largeSwapsDetected}`);
    console.log(`     Opportunities: ${cdStats.opportunitiesFound}`);
    console.log(`     Executed: ${cdStats.opportunitiesExecuted}`);
    console.log(`     Missed: ${cdStats.opportunitiesMissed}`);
    console.log(`       - Spread too low: ${cdStats.missedReasons.spreadTooLow}`);
    console.log(`       - Latency: ${cdStats.missedReasons.latency}`);
    console.log(`       - Conflict: ${cdStats.missedReasons.conflict}`);
    console.log(`   Mutex:`);
    console.log(`     Total locks: ${engineStats.mutex.totalLocks}`);
    console.log(`     Currently locked: ${engineStats.mutex.currentlyLocked}`);
    console.log('═══════════════════════════════════════════════\n');
  }
}

export default ArbitrageEngine;
