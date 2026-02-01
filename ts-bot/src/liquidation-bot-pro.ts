/**
 * Kamino Liquidation Bot PRO v1.0
 * 
 * Professional liquidation bot with:
 * - Full obligation indexing at startup
 * - Price-indexed liquidation lookup (O(1) reaction time)
 * - Pyth WebSocket for real-time price updates
 * - Flash loan execution via Kamino
 * - Jupiter swap for collateral conversion
 * 
 * Flow:
 * 1. Startup: Fetch all ~98k obligations, calculate liquidation prices, build index
 * 2. Runtime: Subscribe to Pyth prices, instant lookup when price crosses threshold
 * 3. Execute: Flash borrow → Liquidate → Swap → Repay → Profit
 */

import { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, AddressLookupTableAccount, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import { KaminoMarket, KaminoObligation, KaminoReserve, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Obligation } = require('@kamino-finance/klend-sdk/dist/idl_codegen/accounts/Obligation');
const { flashBorrowReserveLiquidity } = require('@kamino-finance/klend-sdk/dist/idl_codegen/instructions/flashBorrowReserveLiquidity');
const { flashRepayReserveLiquidity } = require('@kamino-finance/klend-sdk/dist/idl_codegen/instructions/flashRepayReserveLiquidity');
const { liquidateObligationAndRedeemReserveCollateral } = require('@kamino-finance/klend-sdk/dist/idl_codegen/instructions/liquidateObligationAndRedeemReserveCollateral');
const BN = require('bn.js');
import Decimal from 'decimal.js';
import WebSocket from 'ws';

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // Minimum profit in USD to execute liquidation
  MIN_PROFIT_USD: 1.0,
  
  // Full refresh interval (ms) - 60 minutes
  FULL_REFRESH_INTERVAL_MS: 60 * 60 * 1000,
  
  // Parallel batches for fetching obligations
  PARALLEL_BATCHES: 10,
  
  // Batch size for getMultipleAccountsInfo
  BATCH_SIZE: 100,
  
  // Price change threshold to trigger check (0.1% = 0.001)
  PRICE_CHANGE_THRESHOLD: 0.001,
  
  // Pyth Hermes WebSocket endpoint
  PYTH_WS_ENDPOINT: 'wss://hermes.pyth.network/ws',
  
  // Kamino flash loan fee (0.001% = 0.00001)
  FLASH_LOAN_FEE: 0.00001,
};

// Kamino Main Market
const KAMINO_MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

// ============================================
// PYTH PRICE FEEDS
// ============================================

interface PriceFeed {
  symbol: string;
  pythId: string;
  decimals: number;
  currentPrice: number;
  lastUpdate: number;
}

const PRICE_FEEDS: Map<string, PriceFeed> = new Map([
  ['SOL', { symbol: 'SOL', pythId: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', decimals: 9, currentPrice: 0, lastUpdate: 0 }],
  ['ETH', { symbol: 'ETH', pythId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', decimals: 9, currentPrice: 0, lastUpdate: 0 }],
  ['BTC', { symbol: 'BTC', pythId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', decimals: 8, currentPrice: 0, lastUpdate: 0 }],
  ['USDC', { symbol: 'USDC', pythId: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a', decimals: 6, currentPrice: 1, lastUpdate: 0 }],
  ['USDT', { symbol: 'USDT', pythId: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b', decimals: 6, currentPrice: 1, lastUpdate: 0 }],
  ['JitoSOL', { symbol: 'JitoSOL', pythId: '0x67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb', decimals: 9, currentPrice: 0, lastUpdate: 0 }],
  ['mSOL', { symbol: 'mSOL', pythId: '0xc2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4', decimals: 9, currentPrice: 0, lastUpdate: 0 }],
  ['bSOL', { symbol: 'bSOL', pythId: '0x89875379e70f8fbadc17aef315adf3a8d5d160b811435537e03c97e8aac97d9c', decimals: 9, currentPrice: 0, lastUpdate: 0 }],
  ['BONK', { symbol: 'BONK', pythId: '0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419', decimals: 5, currentPrice: 0, lastUpdate: 0 }],
  ['JUP', { symbol: 'JUP', pythId: '0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e6e83406456ec83', decimals: 6, currentPrice: 0, lastUpdate: 0 }],
  ['RAY', { symbol: 'RAY', pythId: '0x91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a', decimals: 6, currentPrice: 0, lastUpdate: 0 }],
  ['ORCA', { symbol: 'ORCA', pythId: '0x37505261e557e251290b8c8899453064e8d760ed5c5556d1eb7c6e9ce7c00c0b', decimals: 6, currentPrice: 0, lastUpdate: 0 }],
  ['PYTH', { symbol: 'PYTH', pythId: '0x0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff', decimals: 6, currentPrice: 0, lastUpdate: 0 }],
  ['WIF', { symbol: 'WIF', pythId: '0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc', decimals: 6, currentPrice: 0, lastUpdate: 0 }],
  ['HNT', { symbol: 'HNT', pythId: '0x649fdd7ec08e8e2a20f425729854e90293dcbe2376abc47197a14da6ff339756', decimals: 8, currentPrice: 0, lastUpdate: 0 }],
]);

// Reverse lookup: Pyth ID → Symbol
const PYTH_ID_TO_SYMBOL: Map<string, string> = new Map();
for (const [symbol, feed] of PRICE_FEEDS) {
  PYTH_ID_TO_SYMBOL.set(feed.pythId, symbol);
}

// ============================================
// OBLIGATION INDEX STRUCTURES
// ============================================

// Collateral/Borrow position in an obligation
interface Position {
  reserveAddress: PublicKey;
  symbol: string;
  amount: number;
  valueUsd: number;
  liquidationPrice: number; // Price at which this position triggers liquidation
}

interface IndexedObligation {
  pubkey: PublicKey;
  owner: PublicKey;
  
  // All collateral positions
  collaterals: Position[];
  totalCollateralUsd: number;
  
  // All borrow positions
  borrows: Position[];
  totalBorrowedUsd: number;
  
  // Health metrics
  ltv: number;
  unhealthyBorrowValue: number;
  isUnhealthy: boolean;
  
  // For execution - primary positions (largest)
  primaryCollateral: Position | null;
  primaryBorrow: Position | null;
  
  // Raw data for re-parsing if needed
  rawData: Buffer;
}

// Price-indexed structure: symbol → price level → obligations
// Each price level is a bucket (e.g., $100-$101, $101-$102, etc.)
interface PriceIndex {
  symbol: string;
  buckets: Map<number, IndexedObligation[]>; // price bucket → obligations
  bucketSize: number; // e.g., 1 for SOL ($1 buckets), 100 for BTC ($100 buckets)
}

// ============================================
// STATS
// ============================================

export const liquidationStats = {
  // Indexing stats
  totalObligations: 0,
  indexedObligations: 0,
  obligationsWithBorrows: 0,
  
  // Runtime stats  
  priceUpdates: 0,
  liquidationChecks: 0,
  liquidationsFound: 0,
  liquidationsAttempted: 0,
  liquidationsSuccessful: 0,
  totalProfitUsd: 0,
  
  // Timing
  startupTimeMs: 0,
  lastRefreshTime: 0,
  lastPriceUpdate: 0,
};

// ============================================
// LIQUIDATION BOT PRO CLASS
// ============================================

// Token constants
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const JUPITER_API = 'https://quote-api.jup.ag/v6';

// Helper to derive ATA address
function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

export class LiquidationBotPro {
  private connection: Connection;
  private keypair: Keypair;
  private market: KaminoMarket | null = null;
  private isRunning = false;
  
  // Obligation index
  private allObligations: IndexedObligation[] = [];
  private priceIndex: Map<string, PriceIndex> = new Map();
  
  // Reserve address → symbol mapping (built from market)
  private reserveToSymbol: Map<string, string> = new Map();
  private reserveToMint: Map<string, PublicKey> = new Map();
  
  // Pyth WebSocket
  private pythWs: WebSocket | null = null;
  private pythReconnectAttempts = 0;
  
  // Refresh timer
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(connection: Connection, keypair: Keypair) {
    this.connection = connection;
    this.keypair = keypair;
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  async initialize(): Promise<void> {
    const startTime = Date.now();
    console.log('🚀 Initializing Liquidation Bot PRO...\n');

    // Load Kamino market
    console.log('📦 Loading Kamino market...');
    this.market = await KaminoMarket.load(
      this.connection,
      KAMINO_MAIN_MARKET,
      undefined as any,
      PROGRAM_ID
    );

    if (!this.market) {
      throw new Error('Failed to load Kamino market');
    }

    await this.market.loadReserves();
    console.log(`   ✅ Loaded ${this.market.reserves.size} reserves\n`);

    // Build reserve → symbol mapping
    console.log('📋 Building reserve mappings...');
    for (const [address, reserve] of this.market.reserves) {
      const symbol = reserve.symbol || 'UNKNOWN';
      this.reserveToSymbol.set(address.toString(), symbol);
      if (reserve.state?.liquidity?.mintPubkey) {
        this.reserveToMint.set(address.toString(), reserve.state.liquidity.mintPubkey);
      }
      console.log(`   ${symbol} → ${address.toString().slice(0, 8)}...`);
    }
    console.log('');

    // Fetch and index all obligations
    await this.fullRefresh();

    liquidationStats.startupTimeMs = Date.now() - startTime;
    console.log(`\n✅ Initialization complete in ${(liquidationStats.startupTimeMs / 1000).toFixed(1)}s`);
  }

  // ============================================
  // FULL REFRESH - Fetch all obligations
  // ============================================

  private async fullRefresh(): Promise<void> {
    const startTime = Date.now();
    console.log('🔄 Starting full obligation refresh...\n');

    // Step 1: Fetch all obligation pubkeys
    console.log('   📡 Fetching obligation pubkeys...');
    const OBLIGATION_SIZE = 3344;
    
    const accounts = await this.connection.getProgramAccounts(
      PROGRAM_ID,
      {
        filters: [
          { dataSize: OBLIGATION_SIZE },
          {
            memcmp: {
              offset: 32,
              bytes: KAMINO_MAIN_MARKET.toBase58(),
            },
          },
        ],
        dataSlice: { offset: 0, length: 0 }, // Just pubkeys
      }
    );

    liquidationStats.totalObligations = accounts.length;
    console.log(`   ✅ Found ${accounts.length.toLocaleString()} obligation accounts\n`);

    // Step 2: Fetch full data in parallel batches
    console.log('   📥 Fetching obligation data in parallel...');
    const pubkeys = accounts.map(a => a.pubkey);
    const allData = await this.fetchInParallelBatches(pubkeys);

    // Step 3: Parse and index obligations
    console.log('\n   🔍 Parsing and indexing obligations...');
    this.allObligations = [];
    this.priceIndex.clear();

    // Initialize price index for each symbol
    for (const [symbol] of PRICE_FEEDS) {
      const bucketSize = this.getBucketSize(symbol);
      this.priceIndex.set(symbol, {
        symbol,
        buckets: new Map(),
        bucketSize,
      });
    }

    let parsedCount = 0;
    let withBorrows = 0;

    for (let i = 0; i < pubkeys.length; i++) {
      const data = allData[i];
      if (!data) continue;

      const indexed = this.parseAndIndexObligation(pubkeys[i], data);
      if (indexed) {
        this.allObligations.push(indexed);
        parsedCount++;
        if (indexed.totalBorrowedUsd > 0) {
          withBorrows++;
          this.addToPriceIndex(indexed);
        }
      }

      // Progress update
      if ((i + 1) % 10000 === 0) {
        console.log(`   ... processed ${(i + 1).toLocaleString()}/${pubkeys.length.toLocaleString()}`);
      }
    }

    liquidationStats.indexedObligations = parsedCount;
    liquidationStats.obligationsWithBorrows = withBorrows;
    liquidationStats.lastRefreshTime = Date.now();

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`\n   ✅ Indexed ${parsedCount.toLocaleString()} obligations (${withBorrows.toLocaleString()} with borrows) in ${elapsed.toFixed(1)}s`);
    
    // Log index stats
    console.log('\n   📊 Price Index Stats:');
    for (const [symbol, index] of this.priceIndex) {
      const totalInIndex = Array.from(index.buckets.values()).reduce((sum, arr) => sum + arr.length, 0);
      if (totalInIndex > 0) {
        console.log(`      ${symbol}: ${totalInIndex} obligations across ${index.buckets.size} price buckets`);
      }
    }
  }

  // Fetch obligation data in parallel batches
  private async fetchInParallelBatches(pubkeys: PublicKey[]): Promise<(Buffer | null)[]> {
    const results: (Buffer | null)[] = new Array(pubkeys.length).fill(null);
    
    // Split into chunks for parallel processing
    const chunkSize = Math.ceil(pubkeys.length / CONFIG.PARALLEL_BATCHES);
    const chunks: { startIdx: number; pubkeys: PublicKey[] }[] = [];
    
    for (let i = 0; i < pubkeys.length; i += chunkSize) {
      chunks.push({
        startIdx: i,
        pubkeys: pubkeys.slice(i, i + chunkSize),
      });
    }

    console.log(`   ... splitting into ${chunks.length} parallel chunks`);

    // Process chunks in parallel
    await Promise.all(chunks.map(async (chunk, chunkIdx) => {
      for (let i = 0; i < chunk.pubkeys.length; i += CONFIG.BATCH_SIZE) {
        const batch = chunk.pubkeys.slice(i, i + CONFIG.BATCH_SIZE);
        
        try {
          const infos = await this.connection.getMultipleAccountsInfo(batch);
          
          for (let j = 0; j < infos.length; j++) {
            const globalIdx = chunk.startIdx + i + j;
            if (infos[j]?.data) {
              results[globalIdx] = infos[j]!.data as Buffer;
            }
          }
        } catch (e) {
          // Retry once on failure
          try {
            await new Promise(r => setTimeout(r, 1000));
            const infos = await this.connection.getMultipleAccountsInfo(batch);
            for (let j = 0; j < infos.length; j++) {
              const globalIdx = chunk.startIdx + i + j;
              if (infos[j]?.data) {
                results[globalIdx] = infos[j]!.data as Buffer;
              }
            }
          } catch {
            // Skip this batch
          }
        }
      }
      
      console.log(`   ... chunk ${chunkIdx + 1}/${chunks.length} complete`);
    }));

    return results;
  }

  // ============================================
  // OBLIGATION PARSING
  // ============================================

  private parseAndIndexObligation(pubkey: PublicKey, data: Buffer): IndexedObligation | null {
    try {
      // Decode using SDK
      const obligation = Obligation.decode(data);
      
      // Scale factor for Sf values (2^60)
      const SCALE_FACTOR = new BN(2).pow(new BN(60));
      
      // Extract total values
      const depositedValueSf = obligation.depositedValueSf;
      const borrowedValueSf = obligation.borrowedAssetsMarketValueSf;
      const unhealthyBorrowValueSf = obligation.unhealthyBorrowValueSf;
      
      const totalCollateralUsd = depositedValueSf.div(SCALE_FACTOR).toNumber();
      const totalBorrowedUsd = borrowedValueSf.div(SCALE_FACTOR).toNumber();
      const unhealthyBorrowValue = unhealthyBorrowValueSf.div(SCALE_FACTOR).toNumber();
      
      // Skip if no borrows
      if (totalBorrowedUsd === 0) return null;
      
      // Parse collateral positions from deposits array
      const collaterals: Position[] = [];
      for (const deposit of obligation.deposits) {
        const reserveAddr = deposit.depositReserve.toString();
        // Skip empty deposits (zero address)
        if (reserveAddr === '11111111111111111111111111111111') continue;
        
        const marketValueSf = deposit.marketValueSf;
        const valueUsd = marketValueSf.div(SCALE_FACTOR).toNumber();
        if (valueUsd === 0) continue;
        
        const symbol = this.reserveToSymbol.get(reserveAddr) || 'UNKNOWN';
        const currentPrice = PRICE_FEEDS.get(symbol)?.currentPrice || 1;
        const amount = valueUsd / currentPrice;
        
        // Calculate liquidation price for this collateral
        // If this collateral drops to this price, the position becomes liquidatable
        const liquidationPrice = totalBorrowedUsd > 0 && amount > 0
          ? (totalBorrowedUsd / amount) * 0.85 // ~85% liquidation threshold
          : 0;
        
        collaterals.push({
          reserveAddress: deposit.depositReserve,
          symbol,
          amount,
          valueUsd,
          liquidationPrice,
        });
      }
      
      // Parse borrow positions from borrows array
      const borrows: Position[] = [];
      for (const borrow of obligation.borrows) {
        const reserveAddr = borrow.borrowReserve.toString();
        // Skip empty borrows (zero address)
        if (reserveAddr === '11111111111111111111111111111111') continue;
        
        const marketValueSf = borrow.marketValueSf;
        const valueUsd = marketValueSf.div(SCALE_FACTOR).toNumber();
        if (valueUsd === 0) continue;
        
        const symbol = this.reserveToSymbol.get(reserveAddr) || 'UNKNOWN';
        
        borrows.push({
          reserveAddress: borrow.borrowReserve,
          symbol,
          amount: valueUsd, // For borrows, amount is in USD
          valueUsd,
          liquidationPrice: 0, // Not applicable for borrows
        });
      }
      
      // Skip if no valid collaterals or borrows found
      if (collaterals.length === 0 || borrows.length === 0) return null;
      
      // Calculate LTV
      const ltv = totalCollateralUsd > 0 ? totalBorrowedUsd / totalCollateralUsd : 0;
      
      // Is unhealthy?
      const isUnhealthy = totalBorrowedUsd >= unhealthyBorrowValue && unhealthyBorrowValue > 0;
      
      // Find primary (largest) collateral and borrow
      const primaryCollateral = collaterals.reduce((max, c) => c.valueUsd > max.valueUsd ? c : max, collaterals[0]);
      const primaryBorrow = borrows.reduce((max, b) => b.valueUsd > max.valueUsd ? b : max, borrows[0]);
      
      return {
        pubkey,
        owner: obligation.owner,
        collaterals,
        totalCollateralUsd,
        borrows,
        totalBorrowedUsd,
        ltv,
        unhealthyBorrowValue,
        isUnhealthy,
        primaryCollateral,
        primaryBorrow,
        rawData: data,
      };
      
    } catch {
      return null;
    }
  }

  // Get bucket size based on asset (for price indexing)
  private getBucketSize(symbol: string): number {
    switch (symbol) {
      case 'BTC': return 100; // $100 buckets for BTC
      case 'ETH': return 10;  // $10 buckets for ETH
      case 'SOL': return 1;   // $1 buckets for SOL
      case 'BONK': return 0.000001;
      default: return 0.1;    // $0.10 for others
    }
  }

  // Add obligation to price index (for each collateral)
  private addToPriceIndex(obligation: IndexedObligation): void {
    // Index by each collateral's liquidation price
    for (const collateral of obligation.collaterals) {
      const index = this.priceIndex.get(collateral.symbol);
      if (!index) continue;

      const bucket = Math.floor(collateral.liquidationPrice / index.bucketSize);
      
      if (!index.buckets.has(bucket)) {
        index.buckets.set(bucket, []);
      }
      index.buckets.get(bucket)!.push(obligation);
    }
  }

  // ============================================
  // PYTH WEBSOCKET
  // ============================================

  private async connectPyth(): Promise<void> {
    console.log('\n📡 Connecting to Pyth WebSocket...');

    return new Promise((resolve, reject) => {
      this.pythWs = new WebSocket(CONFIG.PYTH_WS_ENDPOINT);

      this.pythWs.on('open', () => {
        console.log('   ✅ Connected to Pyth Hermes\n');
        this.pythReconnectAttempts = 0;

        // Subscribe to all price feeds
        const feedIds = Array.from(PRICE_FEEDS.values()).map(f => f.pythId);
        
        const subscribeMsg = {
          type: 'subscribe',
          ids: feedIds,
        };
        
        this.pythWs!.send(JSON.stringify(subscribeMsg));
        console.log(`   📊 Subscribed to ${feedIds.length} price feeds`);
        
        resolve();
      });

      this.pythWs.on('message', (data: WebSocket.Data) => {
        this.handlePythMessage(data);
      });

      this.pythWs.on('error', (error) => {
        console.error('   ❌ Pyth WebSocket error:', error.message);
      });

      this.pythWs.on('close', () => {
        console.log('   ⚠️ Pyth WebSocket closed, reconnecting...');
        this.reconnectPyth();
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pythWs?.readyState !== WebSocket.OPEN) {
          reject(new Error('Pyth connection timeout'));
        }
      }, 10000);
    });
  }

  private async reconnectPyth(): Promise<void> {
    if (this.pythReconnectAttempts >= 5) {
      console.error('   ❌ Max Pyth reconnect attempts reached');
      return;
    }

    this.pythReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.pythReconnectAttempts), 30000);
    
    console.log(`   🔄 Reconnecting in ${delay / 1000}s (attempt ${this.pythReconnectAttempts}/5)`);
    
    await new Promise(r => setTimeout(r, delay));
    
    try {
      await this.connectPyth();
    } catch {
      this.reconnectPyth();
    }
  }

  private handlePythMessage(data: WebSocket.Data): void {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'price_update') {
        const priceData = msg.price_feed;
        if (!priceData) return;

        const pythId = '0x' + priceData.id;
        const symbol = PYTH_ID_TO_SYMBOL.get(pythId);
        
        if (!symbol) return;

        const feed = PRICE_FEEDS.get(symbol);
        if (!feed) return;

        // Parse price
        const priceInfo = priceData.price;
        const price = parseFloat(priceInfo.price) * Math.pow(10, priceInfo.expo);
        const oldPrice = feed.currentPrice;
        
        // Update price
        feed.currentPrice = price;
        feed.lastUpdate = Date.now();
        liquidationStats.priceUpdates++;
        liquidationStats.lastPriceUpdate = Date.now();

        // Check for significant price change
        if (oldPrice > 0) {
          const changePercent = Math.abs(price - oldPrice) / oldPrice;
          
          if (changePercent >= CONFIG.PRICE_CHANGE_THRESHOLD) {
            console.log(`💹 ${symbol}: $${oldPrice.toFixed(4)} → $${price.toFixed(4)} (${(changePercent * 100).toFixed(2)}%)`);
            
            // Check for liquidation opportunities
            this.checkLiquidationsForPriceChange(symbol, price, price < oldPrice);
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // ============================================
  // LIQUIDATION CHECK
  // ============================================

  private checkLiquidationsForPriceChange(symbol: string, newPrice: number, priceDropped: boolean): void {
    // Only check on price drops (when collateral value decreases)
    if (!priceDropped) return;

    liquidationStats.liquidationChecks++;

    const index = this.priceIndex.get(symbol);
    if (!index) return;

    // Find all buckets with liquidation price >= current price
    // (positions that are now liquidatable)
    const currentBucket = Math.floor(newPrice / index.bucketSize);
    
    const liquidatableObligations: IndexedObligation[] = [];
    
    for (const [bucket, obligations] of index.buckets) {
      // Bucket's price level >= current price means liquidatable
      const bucketPrice = bucket * index.bucketSize;
      if (bucketPrice >= newPrice) {
        liquidatableObligations.push(...obligations);
      }
    }

    if (liquidatableObligations.length > 0) {
      liquidationStats.liquidationsFound += liquidatableObligations.length;
      
      console.log(`\n💀 Found ${liquidatableObligations.length} liquidatable positions!`);
      
      // Process liquidations
      for (const obl of liquidatableObligations) {
        this.processLiquidation(obl);
      }
    }
  }

  private async processLiquidation(obligation: IndexedObligation): Promise<void> {
    const potentialProfit = obligation.totalBorrowedUsd * 0.05; // ~5% liquidation bonus
    const primaryCollateral = obligation.primaryCollateral;
    const primaryBorrow = obligation.primaryBorrow;

    console.log(`\n🎯 Processing liquidation:`);
    console.log(`   Address: ${obligation.pubkey.toString().slice(0, 12)}...`);
    console.log(`   Collateral: $${obligation.totalCollateralUsd.toFixed(2)} (${obligation.collaterals.map(c => c.symbol).join(', ')})`);
    console.log(`   Borrowed: $${obligation.totalBorrowedUsd.toFixed(2)} (${obligation.borrows.map(b => b.symbol).join(', ')})`);
    console.log(`   LTV: ${(obligation.ltv * 100).toFixed(2)}%`);
    console.log(`   Est. Profit: $${potentialProfit.toFixed(2)}`);

    if (potentialProfit < CONFIG.MIN_PROFIT_USD) {
      console.log(`   ⚠️ Profit too low, skipping`);
      return;
    }

    if (!primaryCollateral || !primaryBorrow) {
      console.log(`   ⚠️ No primary collateral/borrow found, skipping`);
      return;
    }

    liquidationStats.liquidationsAttempted++;

    // Execute flash loan liquidation
    try {
      console.log(`   🚀 Executing flash loan liquidation...`);
      console.log(`      Flash borrow: ${primaryBorrow.symbol}`);
      console.log(`      Liquidate → receive: ${primaryCollateral.symbol}`);
      console.log(`      Swap back to: ${primaryBorrow.symbol}`);
      
      await this.executeFlashLoanLiquidation(obligation, primaryCollateral, primaryBorrow);
      
    } catch (e: any) {
      console.log(`   ❌ Execution failed: ${e.message || e}`);
    }
  }

  // ============================================
  // FLASH LOAN EXECUTION
  // ============================================

  private async executeFlashLoanLiquidation(
    obligation: IndexedObligation,
    collateral: Position,
    borrow: Position
  ): Promise<void> {
    if (!this.market) throw new Error('Market not loaded');

    // Get reserves
    const borrowReserve = this.market.reserves.get(borrow.reserveAddress);
    const collateralReserve = this.market.reserves.get(collateral.reserveAddress);

    if (!borrowReserve || !collateralReserve) {
      throw new Error('Reserve not found');
    }

    // Get mint addresses and decimals
    const borrowMint = borrowReserve.state?.liquidity?.mintPubkey;
    const collateralMint = collateralReserve.state?.liquidity?.mintPubkey;
    const borrowDecimals = borrowReserve.state?.liquidity?.mintDecimals || 6;
    const collateralDecimals = collateralReserve.state?.liquidity?.mintDecimals || 9;

    if (!borrowMint || !collateralMint) {
      throw new Error('Could not get mint addresses');
    }

    // ============================================
    // DYNAMIC LIQUIDATION AMOUNT CALCULATION
    // ============================================
    
    // Get available liquidity in the reserve (max we can flash borrow)
    const availableLiquidity = borrowReserve.state?.liquidity?.availableAmount;
    const availableLiquidityUsd = (availableLiquidity?.toNumber?.() || 0) / Math.pow(10, borrowDecimals);
    
    // Max liquidation is 50% of debt (Kamino rule) OR available liquidity, whichever is smaller
    const maxLiquidationPercent = 0.5; // 50% close factor
    const debtValue = borrow.valueUsd;
    const maxByDebt = debtValue * maxLiquidationPercent;
    const maxByLiquidity = availableLiquidityUsd * 0.95; // Leave 5% buffer
    
    // Calculate optimal liquidation amount
    let liquidationAmountUsd = Math.min(maxByDebt, maxByLiquidity);
    
    // Ensure minimum profitable amount
    const minProfitableAmount = CONFIG.MIN_PROFIT_USD / 0.05; // Need ~$20 debt to get $1 profit
    if (liquidationAmountUsd < minProfitableAmount) {
      console.log(`      ⚠️ Liquidation amount too small: $${liquidationAmountUsd.toFixed(2)}`);
      return;
    }

    // Convert to lamports
    const liquidationAmountLamports = new BN(
      Math.floor(liquidationAmountUsd * Math.pow(10, borrowDecimals)).toString()
    );

    console.log(`      💰 Dynamic liquidation calculation:`);
    console.log(`         Debt: $${debtValue.toFixed(2)}`);
    console.log(`         Max by 50% rule: $${maxByDebt.toFixed(2)}`);
    console.log(`         Available liquidity: $${availableLiquidityUsd.toFixed(2)}`);
    console.log(`         → Liquidating: $${liquidationAmountUsd.toFixed(2)}`);

    // Calculate expected collateral with liquidation bonus (~5%)
    const liquidationBonus = 1.05;
    const expectedCollateralValue = liquidationAmountUsd * liquidationBonus;
    const collateralPrice = PRICE_FEEDS.get(collateral.symbol)?.currentPrice || 1;
    const expectedCollateralAmount = expectedCollateralValue / collateralPrice;
    const expectedCollateralLamports = Math.floor(expectedCollateralAmount * Math.pow(10, collateralDecimals));

    console.log(`         Expected collateral: ~${expectedCollateralAmount.toFixed(6)} ${collateral.symbol}`);

    // ============================================
    // GET JUPITER QUOTE FOR PROFITABILITY CHECK
    // ============================================
    
    let swapQuote: any;
    try {
      swapQuote = await this.getJupiterQuote(
        collateralMint.toString(),
        borrowMint.toString(),
        expectedCollateralLamports
      );
    } catch (e: any) {
      console.log(`      ❌ Jupiter quote failed: ${e.message}`);
      return;
    }

    if (!swapQuote) {
      console.log(`      ❌ No Jupiter route found`);
      return;
    }

    const swapOutAmount = Number(swapQuote.outAmount) / Math.pow(10, borrowDecimals);
    const flashFee = liquidationAmountUsd * CONFIG.FLASH_LOAN_FEE;
    const profit = swapOutAmount - liquidationAmountUsd - flashFee;

    console.log(`      📊 Profit calculation:`);
    console.log(`         Swap output: $${swapOutAmount.toFixed(2)}`);
    console.log(`         Flash fee: $${flashFee.toFixed(4)}`);
    console.log(`         Net profit: $${profit.toFixed(2)}`);

    if (profit < CONFIG.MIN_PROFIT_USD) {
      console.log(`      ⚠️ Profit too low ($${profit.toFixed(2)} < $${CONFIG.MIN_PROFIT_USD}), skipping`);
      return;
    }

    // ============================================
    // BUILD AND EXECUTE TRANSACTION
    // ============================================
    
    console.log(`      🚀 Building liquidation transaction...`);

    try {
      // Get lending market authority PDA
      const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
        [KAMINO_MAIN_MARKET.toBuffer()],
        PROGRAM_ID
      );

      // User ATAs
      const userBorrowAta = getAssociatedTokenAddress(borrowMint, this.keypair.publicKey);
      const userCollateralAta = getAssociatedTokenAddress(collateralMint, this.keypair.publicKey);

      // Reserve accounts
      const borrowReserveState = borrowReserve.state!;
      const collateralReserveState = collateralReserve.state!;

      const instructions: TransactionInstruction[] = [];

      // 1. Flash Borrow
      const flashBorrowIx = flashBorrowReserveLiquidity(
        { liquidityAmount: liquidationAmountLamports },
        {
          userTransferAuthority: this.keypair.publicKey,
          lendingMarketAuthority,
          lendingMarket: KAMINO_MAIN_MARKET,
          reserve: borrow.reserveAddress,
          reserveLiquidityMint: borrowMint,
          reserveSourceLiquidity: borrowReserveState.liquidity.supplyVault,
          userDestinationLiquidity: userBorrowAta,
          reserveLiquidityFeeReceiver: borrowReserveState.liquidity.feeVault,
          referrerTokenState: borrowReserveState.liquidity.feeVault, // Use fee vault if no referrer
          referrerAccount: this.keypair.publicKey,
          sysvarInfo: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        }
      );
      instructions.push(flashBorrowIx);

      // 2. Liquidate Obligation
      const liquidateIx = liquidateObligationAndRedeemReserveCollateral(
        {
          liquidityAmount: liquidationAmountLamports,
          minAcceptableReceivedLiquidityAmount: new BN(0), // Accept any amount
          maxAllowedLtvOverridePercent: new BN(100), // Allow up to 100% LTV override
        },
        {
          liquidator: this.keypair.publicKey,
          obligation: obligation.pubkey,
          lendingMarket: KAMINO_MAIN_MARKET,
          lendingMarketAuthority,
          repayReserve: borrow.reserveAddress,
          repayReserveLiquidityMint: borrowMint,
          repayReserveLiquiditySupply: borrowReserveState.liquidity.supplyVault,
          withdrawReserve: collateral.reserveAddress,
          withdrawReserveLiquidityMint: collateralMint,
          withdrawReserveCollateralMint: collateralReserveState.collateral.mintPubkey,
          withdrawReserveCollateralSupply: collateralReserveState.collateral.supplyVault,
          withdrawReserveLiquiditySupply: collateralReserveState.liquidity.supplyVault,
          withdrawReserveLiquidityFeeReceiver: collateralReserveState.liquidity.feeVault,
          userSourceLiquidity: userBorrowAta,
          userDestinationCollateral: userCollateralAta,
          userDestinationLiquidity: userCollateralAta,
          collateralTokenProgram: TOKEN_PROGRAM_ID,
          repayLiquidityTokenProgram: TOKEN_PROGRAM_ID,
          withdrawLiquidityTokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        }
      );
      instructions.push(liquidateIx);

      // 3. Jupiter Swap (collateral → borrow token)
      const swapInstructions = await this.getJupiterSwapInstructions(swapQuote);
      instructions.push(...swapInstructions);

      // 4. Flash Repay
      const flashRepayAmount = liquidationAmountLamports.add(
        liquidationAmountLamports.muln(1).divn(100000) // Add 0.001% fee
      );
      const flashRepayIx = flashRepayReserveLiquidity(
        { 
          liquidityAmount: flashRepayAmount,
          borrowInstructionIndex: 0, // Index of flash borrow in transaction
        },
        {
          userTransferAuthority: this.keypair.publicKey,
          lendingMarketAuthority,
          lendingMarket: KAMINO_MAIN_MARKET,
          reserve: borrow.reserveAddress,
          reserveLiquidityMint: borrowMint,
          reserveDestinationLiquidity: borrowReserveState.liquidity.supplyVault,
          userSourceLiquidity: userBorrowAta,
          reserveLiquidityFeeReceiver: borrowReserveState.liquidity.feeVault,
          referrerTokenState: borrowReserveState.liquidity.feeVault,
          referrerAccount: this.keypair.publicKey,
          sysvarInfo: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        }
      );
      instructions.push(flashRepayIx);

      // Build and send transaction
      const { blockhash } = await this.connection.getLatestBlockhash();
      const messageV0 = new TransactionMessage({
        payerKey: this.keypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([this.keypair]);

      console.log(`      📤 Sending transaction...`);
      
      const signature = await this.connection.sendTransaction(transaction, {
        skipPreflight: true, // Skip preflight for speed
        maxRetries: 3,
      });

      console.log(`      ✅ Transaction sent: ${signature.slice(0, 20)}...`);
      console.log(`      💰 Estimated profit: $${profit.toFixed(2)}`);

      liquidationStats.liquidationsSuccessful++;
      liquidationStats.totalProfitUsd += profit;

    } catch (e: any) {
      console.log(`      ❌ Transaction failed: ${e.message}`);
      throw e;
    }
  }

  // Get Jupiter swap instructions
  private async getJupiterSwapInstructions(quote: any): Promise<TransactionInstruction[]> {
    const response = await fetch(`${JUPITER_API}/swap-instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });

    if (!response.ok) {
      throw new Error(`Jupiter swap-instructions API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Parse instructions from response
    const instructions: TransactionInstruction[] = [];
    
    if (data.setupInstructions) {
      for (const ix of data.setupInstructions) {
        instructions.push(this.deserializeInstruction(ix));
      }
    }
    
    if (data.swapInstruction) {
      instructions.push(this.deserializeInstruction(data.swapInstruction));
    }
    
    if (data.cleanupInstruction) {
      instructions.push(this.deserializeInstruction(data.cleanupInstruction));
    }

    return instructions;
  }

  // Deserialize Jupiter instruction
  private deserializeInstruction(instruction: any): TransactionInstruction {
    return new TransactionInstruction({
      programId: new PublicKey(instruction.programId),
      keys: instruction.accounts.map((key: any) => ({
        pubkey: new PublicKey(key.pubkey),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
      data: Buffer.from(instruction.data, 'base64'),
    });
  }

  // Get Jupiter swap quote
  private async getJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: number
  ): Promise<any> {
    const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`;
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Jupiter API error: ${response.status}`);
    }
    
    return response.json();
  }

  // ============================================
  // MAIN LOOP
  // ============================================

  async start(): Promise<void> {
    if (!this.market) {
      throw new Error('Market not initialized. Call initialize() first.');
    }

    this.isRunning = true;
    
    console.log('\n' + '='.repeat(60));
    console.log('🚀 LIQUIDATION BOT PRO STARTED');
    console.log('='.repeat(60));
    console.log(`   Min profit: $${CONFIG.MIN_PROFIT_USD}`);
    console.log(`   Refresh interval: ${CONFIG.FULL_REFRESH_INTERVAL_MS / 60000} minutes`);
    console.log(`   Indexed obligations: ${liquidationStats.indexedObligations.toLocaleString()}`);
    console.log(`   Active borrows: ${liquidationStats.obligationsWithBorrows.toLocaleString()}`);
    console.log('='.repeat(60) + '\n');

    // Connect to Pyth
    await this.connectPyth();

    // Schedule periodic refresh
    this.refreshTimer = setInterval(async () => {
      if (this.isRunning) {
        console.log('\n⏰ Scheduled refresh triggered');
        await this.fullRefresh();
      }
    }, CONFIG.FULL_REFRESH_INTERVAL_MS);

    // Keep alive
    console.log('\n👀 Monitoring prices for liquidation opportunities...\n');
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.pythWs) {
      this.pythWs.close();
      this.pythWs = null;
    }

    console.log('\n🛑 Liquidation Bot PRO stopped');
  }

  // Get current stats
  getStats() {
    return {
      ...liquidationStats,
      isRunning: this.isRunning,
      currentPrices: Object.fromEntries(
        Array.from(PRICE_FEEDS.entries()).map(([k, v]) => [k, v.currentPrice])
      ),
    };
  }
}

// ============================================
// MAIN ENTRY POINT
// ============================================

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   💀 KAMINO LIQUIDATION BOT PRO                           ║');
  console.log('║   Price-Indexed + Pyth WebSocket                          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Load environment
  const { config } = await import('dotenv');
  config();

  // Setup connection
  const rpcUrl = process.env.HELIUS_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  console.log(`RPC: ${rpcUrl.substring(0, 40)}...`);
  
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  });

  // Load wallet
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('WALLET_PRIVATE_KEY not found in environment');
  }

  const { default: bs58 } = await import('bs58');
  const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
  console.log(`Wallet: ${keypair.publicKey.toString()}\n`);

  // Create and start bot
  const bot = new LiquidationBotPro(connection, keypair);
  
  await bot.initialize();
  await bot.start();

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n\nReceived SIGINT, shutting down...');
    await bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\nReceived SIGTERM, shutting down...');
    await bot.stop();
    process.exit(0);
  });
}

// Run if main module
main().catch(console.error);
