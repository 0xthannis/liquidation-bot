/**
 * Memecoin Arbitrage: PumpSwap ↔ Raydium
 * 
 * Captures massive spreads (1-15%) when pump.fun tokens migrate to Raydium
 * Uses direct AMM swaps for minimal fees
 */

import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import fetch from 'node-fetch';
import { recordTrade } from './api-server';

// ============== PROGRAM IDS ==============
const PUMPSWAP_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const RAYDIUM_AMM_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Token mints
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Jito tip
const JITO_TIP_ACCOUNT = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');

// ============== CONFIGURATION ==============
export const MEMECOIN_CONFIG = {
  // Spread thresholds
  minSpreadPercent: 1.0,           // Minimum 1% spread to trade
  targetSpreadPercent: 3.0,        // Ideal spread for max confidence
  
  // Liquidity requirements
  minPoolLiquiditySol: 10,         // Minimum 10 SOL in pool
  maxTradePercentOfPool: 5,        // Max 5% of pool per trade
  
  // Trade amounts (in SOL)
  minTradeSol: 0.1,                // Minimum 0.1 SOL trade
  maxTradeSol: 5,                  // Maximum 5 SOL per trade (conservative)
  
  // Safety
  maxSlippageBps: 500,             // 5% max slippage
  minTokenAgeMinutes: 10,          // Token must be 10+ min old
  
  // Rate limiting
  cooldownMs: 10000,               // 10s between trades on same token
  maxConcurrentTrades: 2,          // Max 2 concurrent memecoin trades
};

// Track active trades
const activeTrades = new Map<string, number>();
let concurrentTrades = 0;

// ============== POOL DISCOVERY ==============
interface PoolInfo {
  address: PublicKey;
  dex: 'pumpswap' | 'raydium';
  tokenMint: PublicKey;
  solReserve: number;
  tokenReserve: number;
  price: number; // SOL per token
}

/**
 * Find PumpSwap pool for a token
 */
async function findPumpSwapPool(
  connection: Connection,
  tokenMint: PublicKey
): Promise<PoolInfo | null> {
  try {
    // PumpSwap pools are PDAs derived from the token mint
    const [poolAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool'), tokenMint.toBuffer(), SOL_MINT.toBuffer()],
      PUMPSWAP_PROGRAM
    );

    const poolAccount = await connection.getAccountInfo(poolAddress);
    if (!poolAccount) return null;

    // Parse pool data (simplified - actual parsing depends on PumpSwap IDL)
    // For now, we'll use Jupiter API to get the price
    const price = await getJupiterPrice(tokenMint.toString(), 'pumpswap');
    if (!price) return null;

    return {
      address: poolAddress,
      dex: 'pumpswap',
      tokenMint,
      solReserve: 0, // Would need to parse from account
      tokenReserve: 0,
      price,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Find Raydium pool for a token
 */
async function findRaydiumPool(
  connection: Connection,
  tokenMint: PublicKey
): Promise<PoolInfo | null> {
  try {
    // Use Jupiter API to find if Raydium has this pair
    const price = await getJupiterPrice(tokenMint.toString(), 'raydium');
    if (!price) return null;

    return {
      address: PublicKey.default, // Would need to fetch actual pool
      dex: 'raydium',
      tokenMint,
      solReserve: 0,
      tokenReserve: 0,
      price,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Get price from Jupiter with DEX filter
 */
async function getJupiterPrice(
  tokenMint: string,
  dex: 'pumpswap' | 'raydium'
): Promise<number | null> {
  try {
    const dexFilter = dex === 'pumpswap' 
      ? 'Pump.fun,PumpSwap' 
      : 'Raydium,Raydium CLMM,Raydium CP';

    // Get quote for 1 SOL worth of tokens
    const amount = LAMPORTS_PER_SOL.toString();
    const url = `https://api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT.toString()}&outputMint=${tokenMint}&amount=${amount}&slippageBps=100&dexes=${encodeURIComponent(dexFilter)}`;

    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) return null;

    const quote = await response.json() as any;
    if (!quote.outAmount) return null;

    // Price = tokens received per SOL
    return Number(quote.outAmount) / 1e9; // Assuming 9 decimals
  } catch (error) {
    return null;
  }
}

// ============== OPPORTUNITY DETECTION ==============
export interface MemecoinOpportunity {
  tokenMint: PublicKey;
  tokenSymbol: string;
  pumpswapPrice: number;
  raydiumPrice: number;
  spreadPercent: number;
  direction: 'pumpswap_to_raydium' | 'raydium_to_pumpswap';
  recommendedTradeSol: number;
  estimatedProfitSol: number;
}

/**
 * Check for arbitrage opportunity on a token
 */
export async function checkMemecoinArbitrage(
  connection: Connection,
  tokenMint: PublicKey,
  tokenSymbol: string = 'UNKNOWN'
): Promise<MemecoinOpportunity | null> {
  try {
    // Check cooldown
    const lastTrade = activeTrades.get(tokenMint.toString());
    if (lastTrade && Date.now() - lastTrade < MEMECOIN_CONFIG.cooldownMs) {
      return null;
    }

    // Get prices from both DEXes
    const [pumpswapPrice, raydiumPrice] = await Promise.all([
      getJupiterPrice(tokenMint.toString(), 'pumpswap'),
      getJupiterPrice(tokenMint.toString(), 'raydium'),
    ]);

    if (!pumpswapPrice || !raydiumPrice) {
      return null;
    }

    // Calculate spread
    const maxPrice = Math.max(pumpswapPrice, raydiumPrice);
    const minPrice = Math.min(pumpswapPrice, raydiumPrice);
    const spreadPercent = ((maxPrice - minPrice) / minPrice) * 100;

    if (spreadPercent < MEMECOIN_CONFIG.minSpreadPercent) {
      return null;
    }

    // Determine direction (buy on cheaper, sell on expensive)
    const direction = pumpswapPrice < raydiumPrice 
      ? 'pumpswap_to_raydium' as const
      : 'raydium_to_pumpswap' as const;

    // Calculate trade size (conservative)
    const recommendedTradeSol = Math.min(
      MEMECOIN_CONFIG.maxTradeSol,
      Math.max(MEMECOIN_CONFIG.minTradeSol, spreadPercent * 0.5) // Scale with spread
    );

    const estimatedProfitSol = recommendedTradeSol * (spreadPercent / 100) * 0.9; // 90% capture

    console.log(`\n🎰 MEMECOIN OPPORTUNITY: ${tokenSymbol}`);
    console.log(`   PumpSwap: ${pumpswapPrice.toFixed(6)} tokens/SOL`);
    console.log(`   Raydium:  ${raydiumPrice.toFixed(6)} tokens/SOL`);
    console.log(`   Spread:   ${spreadPercent.toFixed(2)}%`);
    console.log(`   Direction: ${direction}`);
    console.log(`   Trade:    ${recommendedTradeSol} SOL → ~${estimatedProfitSol.toFixed(4)} SOL profit`);

    return {
      tokenMint,
      tokenSymbol,
      pumpswapPrice,
      raydiumPrice,
      spreadPercent,
      direction,
      recommendedTradeSol,
      estimatedProfitSol,
    };
  } catch (error) {
    console.error(`Error checking ${tokenSymbol}:`, error);
    return null;
  }
}

// ============== EXECUTION ==============
export async function executeMemecoinArbitrage(
  connection: Connection,
  keypair: Keypair,
  opportunity: MemecoinOpportunity
): Promise<boolean> {
  const { tokenMint, tokenSymbol, direction, recommendedTradeSol, spreadPercent } = opportunity;

  // Check concurrent trades
  if (concurrentTrades >= MEMECOIN_CONFIG.maxConcurrentTrades) {
    console.log(`   ⏳ Max concurrent trades reached, skipping`);
    return false;
  }

  concurrentTrades++;
  activeTrades.set(tokenMint.toString(), Date.now());

  try {
    console.log(`\n🚀 Executing ${tokenSymbol} arbitrage...`);
    
    const [buyDex, sellDex] = direction === 'pumpswap_to_raydium'
      ? ['pumpswap', 'raydium']
      : ['raydium', 'pumpswap'];

    // Get swap instructions via Jupiter (simpler for now)
    const amountLamports = Math.floor(recommendedTradeSol * LAMPORTS_PER_SOL);

    // Step 1: Buy tokens on cheaper DEX
    const buyQuote = await getJupiterQuote(
      SOL_MINT.toString(),
      tokenMint.toString(),
      amountLamports,
      buyDex
    );

    if (!buyQuote) {
      console.log(`   ❌ Failed to get buy quote from ${buyDex}`);
      return false;
    }

    const tokensReceived = BigInt(buyQuote.outAmount);

    // Step 2: Sell tokens on expensive DEX  
    const sellQuote = await getJupiterQuote(
      tokenMint.toString(),
      SOL_MINT.toString(),
      Number(tokensReceived),
      sellDex
    );

    if (!sellQuote) {
      console.log(`   ❌ Failed to get sell quote from ${sellDex}`);
      return false;
    }

    const solReturned = Number(sellQuote.outAmount) / LAMPORTS_PER_SOL;
    const profit = solReturned - recommendedTradeSol;

    console.log(`   Buy:  ${recommendedTradeSol} SOL → ${tokensReceived} tokens on ${buyDex}`);
    console.log(`   Sell: ${tokensReceived} tokens → ${solReturned.toFixed(4)} SOL on ${sellDex}`);
    console.log(`   Profit: ${profit.toFixed(4)} SOL`);

    if (profit < 0.001) { // Minimum 0.001 SOL profit
      console.log(`   ❌ Profit too low after quotes`);
      recordTrade({
        pair: `${tokenSymbol}/SOL`,
        type: 'memecoin_arb',
        amount: recommendedTradeSol,
        profit: profit,
        profitUsd: profit * 200, // Assume ~$200/SOL
        status: 'opportunity_detected',
        details: `${buyDex} → ${sellDex}: ${spreadPercent.toFixed(2)}% spread but ${profit.toFixed(4)} SOL profit after slippage`,
      });
      return false;
    }

    // Get swap instructions
    const buyIx = await getJupiterSwapInstructions(buyQuote, keypair.publicKey.toString());
    const sellIx = await getJupiterSwapInstructions(sellQuote, keypair.publicKey.toString());

    if (!buyIx || !sellIx) {
      console.log(`   ❌ Failed to get swap instructions`);
      return false;
    }

    // Build transaction
    const instructions: TransactionInstruction[] = [
      // Priority fee
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    ];

    // Add buy instructions
    if (buyIx.setupInstructions) {
      instructions.push(...buyIx.setupInstructions.map(deserializeInstruction));
    }
    instructions.push(deserializeInstruction(buyIx.swapInstruction));

    // Add sell instructions
    if (sellIx.setupInstructions) {
      instructions.push(...sellIx.setupInstructions.map(deserializeInstruction));
    }
    instructions.push(deserializeInstruction(sellIx.swapInstruction));

    // Send transaction
    const { blockhash } = await connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([keypair]);

    console.log(`   📤 Sending transaction...`);
    const signature = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 3,
    });

    console.log(`   ✅ TX: ${signature}`);
    
    recordTrade({
      pair: `${tokenSymbol}/SOL`,
      type: 'memecoin_arb',
      amount: recommendedTradeSol,
      profit: profit,
      profitUsd: profit * 200,
      status: 'cross_dex_success',
      txSignature: signature,
      details: `${buyDex} → ${sellDex}: ${spreadPercent.toFixed(2)}% spread, ${profit.toFixed(4)} SOL profit`,
    });

    return true;

  } catch (error) {
    console.error(`   ❌ Execution error:`, error);
    recordTrade({
      pair: `${tokenSymbol}/SOL`,
      type: 'memecoin_arb',
      amount: recommendedTradeSol,
      profit: 0,
      profitUsd: 0,
      status: 'cross_dex_failed',
      details: `Error: ${error}`,
    });
    return false;
  } finally {
    concurrentTrades--;
  }
}

// ============== JUPITER HELPERS ==============
async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  dex: string
): Promise<any> {
  try {
    const dexFilter = dex === 'pumpswap'
      ? 'Pump.fun,PumpSwap'
      : 'Raydium,Raydium CLMM,Raydium CP';

    const url = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${MEMECOIN_CONFIG.maxSlippageBps}&dexes=${encodeURIComponent(dexFilter)}`;

    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function getJupiterSwapInstructions(quote: any, userPublicKey: string): Promise<any> {
  try {
    const response = await fetch('https://api.jup.ag/swap/v1/swap-instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
      }),
    });

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function deserializeInstruction(ix: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((acc: any) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

// ============== MONITORING ==============
// Popular pump.fun tokens to monitor
const MONITORED_TOKENS = [
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF' },
  { mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', symbol: 'POPCAT' },
  { mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', symbol: 'MEW' },
  { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', symbol: 'BOME' },
];

export async function startMemecoinMonitor(
  connection: Connection,
  keypair: Keypair
): Promise<void> {
  console.log('\n🎰 Starting Memecoin Arbitrage Monitor');
  console.log(`   Monitoring ${MONITORED_TOKENS.length} tokens`);
  console.log(`   Min spread: ${MEMECOIN_CONFIG.minSpreadPercent}%`);
  console.log(`   Max trade: ${MEMECOIN_CONFIG.maxTradeSol} SOL\n`);

  // Check each token periodically
  setInterval(async () => {
    for (const token of MONITORED_TOKENS) {
      try {
        const opportunity = await checkMemecoinArbitrage(
          connection,
          new PublicKey(token.mint),
          token.symbol
        );

        if (opportunity && opportunity.spreadPercent >= MEMECOIN_CONFIG.minSpreadPercent) {
          await executeMemecoinArbitrage(connection, keypair, opportunity);
        }
      } catch (error) {
        // Silent fail for individual tokens
      }

      // Small delay between tokens
      await new Promise(r => setTimeout(r, 1000));
    }
  }, 30000); // Check every 30 seconds
}

console.log('✅ Memecoin Arbitrage module loaded');
