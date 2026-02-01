/**
 * Kamino Liquidation Bot - Main Entry Point
 * 
 * Monitors Kamino Lending for unhealthy positions and executes liquidations.
 * Liquidations provide a 5% bonus on repaid debt.
 */

import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { LiquidationBot, liquidationStats } from './liquidation-bot';
import { startApiServer } from './api-server';

// Load environment
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

// Constants
const RPC_URL = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Global state
let liquidationBot: LiquidationBot | null = null;

async function loadWallet(): Promise<Keypair> {
  const privateKey = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('WALLET_PRIVATE_KEY not found in environment');
  }
  
  const secretKey = bs58.decode(privateKey);
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Graceful shutdown
 */
function setupGracefulShutdown(): void {
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');

    if (liquidationBot) {
      await liquidationBot.stop();
      liquidationBot.logStats();
    }

    console.log('✅ Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Periodic stats logging
 */
function startStatsLogger(): void {
  setInterval(() => {
    if (liquidationBot) {
      liquidationBot.logStats();
    }
  }, 60000); // Every minute
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   💀 KAMINO LIQUIDATION BOT                           ║');
  console.log('║   Monitor & Liquidate Unhealthy Positions             ║');
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

  // Check wallet balance
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`💰 Wallet balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 0.1 * 1e9) {
    console.log('⚠️ Warning: Low SOL balance. Need SOL for transaction fees.');
  }

  // Start API server
  startApiServer(3001);
  console.log('✅ API server: http://localhost:3001');

  // Initialize and start liquidation bot
  liquidationBot = new LiquidationBot(connection, keypair);
  await liquidationBot.initialize();
  await liquidationBot.start();

  // Start stats logger
  startStatsLogger();

  console.log('\n📊 Bot is now scanning for liquidation opportunities...');
  console.log('   Press Ctrl+C to stop\n');
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
