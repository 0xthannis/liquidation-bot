/**
 * Main Entry Point - Launches both Round-Trip and Cross-DEX engines in parallel
 * 
 * Round-Trip: Continues scanning via flash-arb.ts (spawned as child process)
 * Cross-DEX: Event-based monitoring via arbitrage-engine.ts
 */

import { Connection, Keypair } from '@solana/web3.js';
import { KaminoMarket } from '@kamino-finance/klend-sdk';
import bs58 from 'bs58';
import { spawn, ChildProcess } from 'child_process';
import { ArbitrageEngine, executeWithLock, engineStats } from './arbitrage-engine';
import { startApiServer, botStats } from './api-server';
import { crossDexStats } from './cross-dex-monitor';

// Load environment
import 'dotenv/config';

// Constants
const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Global state
let roundTripProcess: ChildProcess | null = null;
let arbitrageEngine: ArbitrageEngine | null = null;

async function loadWallet(): Promise<Keypair> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY not found in environment');
  }
  
  const secretKey = bs58.decode(privateKey);
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Start Round-Trip engine as a child process
 * This ensures it runs completely independently
 */
function startRoundTripEngine(): void {
  console.log('\n🔄 Starting Round-Trip Engine (child process)...');
  
  roundTripProcess = spawn('npx', ['tsx', 'src/flash-arb.ts'], {
    cwd: process.cwd(),
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: true,
    env: process.env,
  });

  // Pipe stdout with prefix
  roundTripProcess.stdout?.on('data', (data) => {
    const lines = data.toString().split('\n').filter((l: string) => l.trim());
    lines.forEach((line: string) => {
      console.log(`[RT] ${line}`);
    });
  });

  // Pipe stderr with prefix
  roundTripProcess.stderr?.on('data', (data) => {
    const lines = data.toString().split('\n').filter((l: string) => l.trim());
    lines.forEach((line: string) => {
      console.error(`[RT] ${line}`);
    });
  });

  roundTripProcess.on('exit', (code) => {
    console.log(`[RT] Process exited with code ${code}`);
    // Restart if crashed
    if (code !== 0) {
      console.log('[RT] Restarting in 5 seconds...');
      setTimeout(startRoundTripEngine, 5000);
    }
  });

  console.log(`✅ Round-Trip Engine started (PID: ${roundTripProcess.pid})`);
}

/**
 * Start Cross-DEX engine
 */
async function startCrossDexEngine(connection: Connection, keypair: Keypair): Promise<void> {
  console.log('\n🔗 Starting Cross-DEX Engine...');

  // Load Kamino market
  console.log('   Loading Kamino market...');
  const { PublicKey } = await import('@solana/web3.js');
  const market = await KaminoMarket.load(connection, new PublicKey(KAMINO_MAIN_MARKET));

  if (!market) {
    throw new Error('Failed to load Kamino market');
  }

  await market.loadReserves();
  console.log('   ✅ Kamino market loaded');

  // Initialize arbitrage engine
  arbitrageEngine = new ArbitrageEngine(connection, keypair);
  await arbitrageEngine.initialize(market);

  // Start cross-DEX monitoring
  await arbitrageEngine.startCrossDexMonitor();

  console.log('✅ Cross-DEX Engine started (event-based)');
}

/**
 * Periodic stats logging
 */
function startStatsLogger(): void {
  setInterval(() => {
    if (arbitrageEngine) {
      arbitrageEngine.logStatsSummary();
    }
  }, 60000); // Every minute
}

/**
 * Enhanced API endpoint for combined stats
 */
function getEnhancedStats() {
  return {
    ...botStats,
    crossDex: crossDexStats,
    engine: engineStats,
  };
}

/**
 * Graceful shutdown
 */
function setupGracefulShutdown(): void {
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');

    // Stop round-trip process
    if (roundTripProcess) {
      roundTripProcess.kill('SIGTERM');
      console.log('   Stopped Round-Trip Engine');
    }

    // Stop cross-DEX monitor
    if (arbitrageEngine) {
      await arbitrageEngine.stopCrossDexMonitor();
      console.log('   Stopped Cross-DEX Engine');
    }

    console.log('✅ Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   DUAL ARBITRAGE ENGINE - Round-Trip + Cross-DEX');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   RPC: ${RPC_URL.slice(0, 30)}...`);
  console.log('   Engines: Round-Trip (loop) + Cross-DEX (events)');
  console.log('   Mutex: Active (prevents concurrent transactions)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Setup shutdown handlers
  setupGracefulShutdown();

  // Connect to Solana
  const connection = new Connection(RPC_URL, 'confirmed');
  console.log('✅ Connected to Solana');

  // Load wallet
  const keypair = await loadWallet();
  console.log(`✅ Wallet loaded: ${keypair.publicKey.toString().slice(0, 8)}...`);

  // Start API server
  startApiServer(3001);

  // Start both engines
  // Note: Round-Trip runs as child process to not interfere
  startRoundTripEngine();

  // Cross-DEX runs in main process for event handling
  await startCrossDexEngine(connection, keypair);

  // Start stats logger
  startStatsLogger();

  console.log('\n🚀 Both engines running in parallel!');
  console.log('   - Round-Trip: Scanning every 1.1s');
  console.log('   - Cross-DEX: Listening for large swaps on Raydium');
  console.log('   - API: http://localhost:3001/stats\n');
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
