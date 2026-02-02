import 'dotenv/config';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import express from 'express';
import { ThrottledConnection } from './utils/throttled-connection.js';
import { logger } from './utils/logger.js';
import { Scanner, TRADING_PAIRS, DEX_LIST } from './scanner.js';
import { Executor } from './executor.js';
import { ArbitrageOpportunity } from './profit-calculator.js';

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // RPC Settings
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  MAX_RPC_REQUESTS_PER_SEC: parseInt(process.env.MAX_RPC_REQUESTS_PER_SEC || '20'),
  
  // Scanning (5 seconds to avoid Jupiter rate limits)
  SCAN_INTERVAL_MS: parseInt(process.env.SCAN_INTERVAL_MS || '5000'),
  
  // Profit thresholds
  MIN_PROFIT_USD: parseFloat(process.env.MIN_PROFIT_USD || '10'),
  MAX_SLIPPAGE_TOLERANCE: parseFloat(process.env.MAX_SLIPPAGE_TOLERANCE || '0.003'),
  
  // Execution
  DRY_RUN: process.env.DRY_RUN !== 'false',
  AUTO_EXECUTE: process.env.AUTO_EXECUTE === 'true',
  
  // API Server
  API_PORT: parseInt(process.env.API_PORT || '3000'),
  ENABLE_API: process.env.ENABLE_API !== 'false',
};

// ============================================
// GLOBAL STATE
// ============================================

interface BotStats {
  startTime: number;
  totalScans: number;
  opportunitiesDetected: number;
  tradesExecuted: number;
  tradesSuccessful: number;
  totalProfitUsd: number;
  lastScanTime: number;
  recentOpportunities: ArbitrageOpportunity[];
}

const stats: BotStats = {
  startTime: Date.now(),
  totalScans: 0,
  opportunitiesDetected: 0,
  tradesExecuted: 0,
  tradesSuccessful: 0,
  totalProfitUsd: 0,
  lastScanTime: 0,
  recentOpportunities: [],
};

// ============================================
// MAIN BOT CLASS
// ============================================

class ArbitrageBot {
  private connection: ThrottledConnection;
  private keypair: Keypair;
  private scanner: Scanner;
  private executor: Executor;
  private running = false;
  private scanTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Initialize connection with throttling
    this.connection = new ThrottledConnection(
      CONFIG.RPC_URL,
      CONFIG.MAX_RPC_REQUESTS_PER_SEC
    );

    // Load wallet
    const privateKey = process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('WALLET_PRIVATE_KEY not set in environment');
    }
    this.keypair = Keypair.fromSecretKey(bs58.decode(privateKey));

    // Initialize components
    this.scanner = new Scanner(this.connection);
    this.executor = new Executor(this.connection, this.keypair, CONFIG.DRY_RUN);
  }

  async start(): Promise<void> {
    this.printBanner();
    
    logger.info(`RPC: ${CONFIG.RPC_URL.substring(0, 50)}...`);
    logger.info(`Wallet: ${this.keypair.publicKey.toBase58()}`);
    logger.info(`Mode: ${CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
    logger.info(`Auto Execute: ${CONFIG.AUTO_EXECUTE}`);
    logger.info(`Min Profit: $${CONFIG.MIN_PROFIT_USD}`);
    logger.info(`Scan Interval: ${CONFIG.SCAN_INTERVAL_MS}ms`);
    console.log('');

    // Start API server if enabled
    if (CONFIG.ENABLE_API) {
      this.startApiServer();
    }

    // Start scanning loop
    this.running = true;
    await this.scanLoop();
  }

  private printBanner(): void {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║   ⚡ FLASH LOAN ARBITRAGE BOT                              ║');
    console.log('║   Multi-DEX Scanner + Kamino Flash Loans                  ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
  }

  private async scanLoop(): Promise<void> {
    while (this.running) {
      try {
        const scanStart = Date.now();
        stats.totalScans++;
        stats.lastScanTime = scanStart;

        // Scan all pairs
        const opportunities = await this.scanner.scanAllPairs();

        // Filter by minimum profit
        const profitableOpportunities = opportunities.filter(
          opp => opp.calculation.netProfit >= CONFIG.MIN_PROFIT_USD
        );

        if (profitableOpportunities.length > 0) {
          stats.opportunitiesDetected += profitableOpportunities.length;
          
          // Keep recent opportunities for API
          stats.recentOpportunities = [
            ...profitableOpportunities,
            ...stats.recentOpportunities,
          ].slice(0, 100);

          // Log opportunities
          for (const opp of profitableOpportunities) {
            this.logOpportunity(opp);

            // Execute if auto-execute is enabled
            if (CONFIG.AUTO_EXECUTE) {
              const result = await this.executor.execute(opp);
              stats.tradesExecuted++;
              if (result.success) {
                stats.tradesSuccessful++;
                stats.totalProfitUsd += result.actualProfit || 0;
              }
            }
          }
        }

        // Log periodic stats
        if (stats.totalScans % 60 === 0) {
          this.logStats();
        }

        // Wait for next scan
        const elapsed = Date.now() - scanStart;
        const waitTime = Math.max(0, CONFIG.SCAN_INTERVAL_MS - elapsed);
        await this.sleep(waitTime);

      } catch (e) {
        logger.error(`Scan error: ${e}`);
        await this.sleep(5000); // Wait 5s on error
      }
    }
  }

  private logOpportunity(opp: ArbitrageOpportunity): void {
    logger.opportunity(`OPPORTUNITY: ${opp.pair} ${(opp.spreadPercent * 100).toFixed(2)}% spread`);
    logger.info(`   Buy: ${opp.buyDex} ($${opp.buyPrice.toFixed(4)})`);
    logger.info(`   Sell: ${opp.sellDex} ($${opp.sellPrice.toFixed(4)})`);
    logger.info(`   Flash amount: $${opp.flashAmount.toLocaleString()} (dynamic)`);
    logger.info(`   Expected profit: $${opp.calculation.netProfit.toFixed(2)}`);
    logger.info(`   Slippage: ${(opp.calculation.slippageCost / opp.flashAmount * 100).toFixed(2)}%`);
  }

  private logStats(): void {
    const uptime = this.formatUptime(Date.now() - stats.startTime);
    const successRate = stats.tradesExecuted > 0 
      ? (stats.tradesSuccessful / stats.tradesExecuted * 100).toFixed(1)
      : '0.0';
    
    logger.stats(`Stats: ${stats.totalScans} scans | ${stats.opportunitiesDetected} opportunities | ${stats.tradesExecuted} executed | $${stats.totalProfitUsd.toFixed(2)} profit | ${uptime} uptime`);
  }

  private formatUptime(ms: number): string {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  }

  private startApiServer(): void {
    const app = express();

    app.get('/api/stats', (req, res) => {
      const executorStats = this.executor.getStats();
      const scannerStats = this.scanner.getStats();
      
      res.json({
        uptime: this.formatUptime(Date.now() - stats.startTime),
        totalScans: stats.totalScans,
        opportunitiesDetected: stats.opportunitiesDetected,
        tradesExecuted: stats.tradesExecuted,
        tradesSuccessful: stats.tradesSuccessful,
        totalProfitUsd: stats.totalProfitUsd.toFixed(2),
        avgProfitPerTrade: stats.tradesSuccessful > 0 
          ? (stats.totalProfitUsd / stats.tradesSuccessful).toFixed(2)
          : '0.00',
        successRate: stats.tradesExecuted > 0
          ? (stats.tradesSuccessful / stats.tradesExecuted).toFixed(3)
          : '0.000',
        config: {
          dryRun: CONFIG.DRY_RUN,
          autoExecute: CONFIG.AUTO_EXECUTE,
          minProfitUsd: CONFIG.MIN_PROFIT_USD,
          scanIntervalMs: CONFIG.SCAN_INTERVAL_MS,
        },
        pairs: TRADING_PAIRS,
        dexes: DEX_LIST,
      });
    });

    app.get('/api/opportunities', (req, res) => {
      res.json({
        count: stats.recentOpportunities.length,
        opportunities: stats.recentOpportunities.slice(0, 20),
      });
    });

    app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    app.listen(CONFIG.API_PORT, () => {
      logger.success(`API server running on port ${CONFIG.API_PORT}`);
    });
  }

  stop(): void {
    this.running = false;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
    }
    logger.info('Bot stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================
// MAIN ENTRY POINT
// ============================================

async function main(): Promise<void> {
  try {
    const bot = new ArbitrageBot();
    
    // Handle shutdown
    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down...');
      bot.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down...');
      bot.stop();
      process.exit(0);
    });

    await bot.start();

  } catch (e) {
    logger.error(`Fatal error: ${e}`);
    process.exit(1);
  }
}

main();
