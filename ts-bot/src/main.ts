/**
 * Cross-DEX Flash Loan Arbitrage Bot
 * 
 * Exploits real price differences between Raydium and Orca
 * Uses Kamino flash loans for capital-free arbitrage
 */

import { Connection, Keypair } from '@solana/web3.js';
import { KaminoMarket } from '@kamino-finance/klend-sdk';
import bs58 from 'bs58';
import { ArbitrageEngine, engineStats } from './arbitrage-engine';
import { startApiServer, botStats } from './api-server';
import { crossDexStats } from './cross-dex-monitor';

// Load environment
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

// Constants
const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
const RPC_URL = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Global state
let arbitrageEngine: ArbitrageEngine | null = null;

async function loadWallet(): Promise<Keypair> {
  const privateKey = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('WALLET_PRIVATE_KEY not found in environment');
  }
  
  const secretKey = bs58.decode(privateKey);
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Start Cross-DEX engine
 */
async function startCrossDexEngine(connection: Connection, keypair: Keypair): Promise<void> {
  console.log('\n🔗 Starting Cross-DEX Engine...');

  // Load Kamino market
  console.log('   Loading Kamino market...');
  const { PublicKey } = await import('@solana/web3.js');
  const market = await KaminoMarket.load(connection, new PublicKey(KAMINO_MAIN_MARKET), undefined as any);

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

    if (arbitrageEngine) {
      await arbitrageEngine.stopCrossDexMonitor();
      console.log('   ✅ Cross-DEX Engine stopped');
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
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   ⚡ CROSS-DEX FLASH LOAN ARBITRAGE BOT              ║');
  console.log('║   Raydium <-> Orca | Kamino Flash Loans            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`RPC: ${RPC_URL.slice(0, 40)}...`);

  // Setup shutdown handlers
  setupGracefulShutdown();

  // Connect to Solana
  const connection = new Connection(RPC_URL, 'confirmed');
  console.log('✅ Connected to Solana');

  // Load wallet
  const keypair = await loadWallet();
  console.log(`✅ Wallet: ${keypair.publicKey.toString().slice(0, 12)}...`);

  // Start API server
  startApiServer(3001);
  console.log('✅ API server: http://localhost:3001');

  // Start Cross-DEX engine
  await startCrossDexEngine(connection, keypair);

  // Start stats logger
  startStatsLogger();

  console.log('\n🚀 Cross-DEX Bot running!');
  console.log('   📶 Listening for large swaps on Raydium');
  console.log('   💰 Min spread: 0.5% for execution');
  console.log('   🔗 Flash loans via Kamino\n');
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
