/**
 * Cross-DEX Executor - Real execution with Kamino Flash Loans
 * Atomic: Flash Borrow -> Swap on DEX1 -> Swap on DEX2 -> Repay -> Profit
 */

import { 
  Connection, 
  Keypair, 
  PublicKey, 
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { 
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// Helper: compute ATA address (compatible with all spl-token versions)
function getATA(mint: PublicKey, owner: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}
import { KaminoMarket, KaminoReserve, getFlashLoanInstructions, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import Decimal from 'decimal.js';
import fetch from 'node-fetch';
import { CrossDexOpportunity, crossDexStats } from './cross-dex-monitor';
import { recordTrade, botStats } from './api-server';
import { createDirectSwapInstructions, getPoolPrice, POOLS, TOKENS as AMM_TOKENS } from './amm-swap';

// Configuration - AMM Direct mode (bypass Jupiter for lower fees)
const USE_DIRECT_AMM = true; // Set to false to use Jupiter instead
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '1605a29f-3095-43b5-ab87-cbb29975bd36';
const JUPITER_QUOTE_API = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://api.jup.ag/swap/v1/swap-instructions';

// Jito tip account
const JITO_TIP_ACCOUNT = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');

// Token mints
const TOKENS: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

// DEX labels for Jupiter API filtering
const DEX_LABELS: Record<string, string> = {
  raydium: 'Raydium,Raydium CLMM,Raydium CP',
  orca: 'Orca,Orca V2,Whirlpool',
  pumpswap: 'Pump.fun,PumpSwap',
};

// PumpSwap AMM Program ID
const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

interface SwapInstructions {
  setupInstructions: any[];
  swapInstruction: any;
  cleanupInstruction?: any;
  addressLookupTableAddresses: string[];
}

export class CrossDexExecutor {
  private connection: Connection;
  private keypair: Keypair;
  private market: KaminoMarket | null = null;
  private lastKaminoLiquidity: bigint = 0n;
  private lastLiquidityCheck: number = 0;
  private readonly LIQUIDITY_CACHE_MS = 30000; // 30s cache

  constructor(connection: Connection, keypair: Keypair) {
    this.connection = connection;
    this.keypair = keypair;
  }

  async initialize(market: KaminoMarket): Promise<void> {
    this.market = market;
    await this.refreshKaminoLiquidity();
    console.log('✅ Cross-DEX Executor initialized');
    console.log(`   Kamino USDC available: $${(Number(this.lastKaminoLiquidity) / 1_000_000).toLocaleString()}`);
  }

  /**
   * Get available liquidity from Kamino USDC reserve
   */
  private async refreshKaminoLiquidity(): Promise<bigint> {
    if (!this.market) return 0n;
    
    // Use cache if recent
    if (Date.now() - this.lastLiquidityCheck < this.LIQUIDITY_CACHE_MS) {
      return this.lastKaminoLiquidity;
    }

    try {
      const usdcMint = new PublicKey(TOKENS.USDC);
      const reserve = this.market.getReserveByMint(usdcMint);
      if (!reserve) return 0n;

      // Get reserve liquidity from Kamino
      const reserveState = reserve.state;
      const availableLiquidity = reserveState.liquidity?.availableAmount || 0n;
      
      this.lastKaminoLiquidity = BigInt(availableLiquidity.toString());
      this.lastLiquidityCheck = Date.now();
      
      return this.lastKaminoLiquidity;
    } catch (error) {
      console.log(`   ⚠️ Error fetching Kamino liquidity: ${error}`);
      return this.lastKaminoLiquidity;
    }
  }

  /**
   * JARED MODE: Take EVERYTHING - big and small opportunities
   * Dynamically adapt amount based on spread and liquidity
   * Big spread = MAX borrow | Small spread = adapted amount
   */
  private async calculateOptimalAmounts(
    spreadPercent: number,
    buyDex: string,
    sellDex: string
  ): Promise<number[]> {
    // Refresh Kamino liquidity
    const kaminoLiquidity = await this.refreshKaminoLiquidity();
    const kaminoLiquidityUsd = Number(kaminoLiquidity) / 1_000_000;
    
    // Max we can borrow from Kamino (leave 10% buffer)
    const maxKaminoBorrow = kaminoLiquidityUsd * 0.9;
    
    // Get DEX pool liquidity - be more aggressive for bigger spreads
    let poolLiquidity = 10_000_000; // Default 10M
    
    try {
      if (buyDex === 'raydium' || sellDex === 'raydium') {
        const balance = await this.connection.getTokenAccountBalance(POOLS.raydium.pcVault);
        poolLiquidity = Math.min(poolLiquidity, Number(balance.value.amount) / 1_000_000);
      }
      if (buyDex === 'orca' || sellDex === 'orca') {
        const balance = await this.connection.getTokenAccountBalance(POOLS.orca.tokenVaultB);
        poolLiquidity = Math.min(poolLiquidity, Number(balance.value.amount) / 1_000_000);
      }
    } catch (error) {
      poolLiquidity = 500_000; // Fallback
    }
    
    // DYNAMIC POOL PERCENT based on spread - bigger spread = more aggressive
    // Spread 0.5%+ = take 10% of pool (big opportunity)
    // Spread 0.1%+ = take 5% of pool
    // Spread < 0.1% = take 2% of pool (small opportunity, be careful)
    let poolPercent: number;
    if (spreadPercent >= 0.5) {
      poolPercent = 0.10; // 10% - GO BIG
    } else if (spreadPercent >= 0.1) {
      poolPercent = 0.05; // 5%
    } else {
      poolPercent = 0.02; // 2% - careful on small spreads
    }
    
    const maxDexTrade = poolLiquidity * poolPercent;
    
    // Calculate max safe amount
    const maxSafeAmount = Math.min(maxKaminoBorrow, maxDexTrade);
    
    // JARED MODE: Generate amounts from MAX down to minimum profitable
    // Always include max, then scale down
    const amounts: number[] = [];
    
    // Start with MAX
    if (maxSafeAmount >= 1000) {
      amounts.push(Math.floor(maxSafeAmount));
    }
    
    // Add scaled amounts: 75%, 50%, 25%, 10%
    const scales = [0.75, 0.5, 0.25, 0.1];
    for (const scale of scales) {
      const scaled = Math.floor(maxSafeAmount * scale);
      if (scaled >= 1000 && !amounts.includes(scaled)) {
        amounts.push(scaled);
      }
    }
    
    // Add fixed amounts if they fit
    const fixedAmounts = [500_000, 250_000, 100_000, 50_000, 25_000, 10_000, 5_000, 2_000, 1_000];
    for (const fixed of fixedAmounts) {
      if (fixed <= maxSafeAmount && !amounts.includes(fixed)) {
        amounts.push(fixed);
      }
    }
    
    // Sort descending - try biggest first
    amounts.sort((a, b) => b - a);
    
    // Keep top 8 amounts to test (performance)
    const validAmounts = amounts.slice(0, 8);
    
    if (validAmounts.length === 0) {
      console.log(`   ⚠️ Pool too small (liquidity: $${poolLiquidity.toLocaleString()})`);
      return [];
    }
    
    console.log(`   🎯 JARED MODE: Spread ${spreadPercent.toFixed(3)}% → ${(poolPercent*100).toFixed(0)}% pool | Testing $${validAmounts[0].toLocaleString()} → $${validAmounts[validAmounts.length-1].toLocaleString()}`);
    
    return validAmounts;
  }

  /**
   * Execute cross-DEX arbitrage with Kamino flash loan
   */
  async execute(opportunity: CrossDexOpportunity): Promise<boolean> {
    if (!this.market) {
      console.log('❌ Market not initialized');
      return false;
    }

    // Check wallet has enough SOL for fees (need ~0.005 SOL minimum)
    const MIN_SOL_FOR_FEES = 0.005 * LAMPORTS_PER_SOL; // 0.005 SOL
    const walletBalance = await this.connection.getBalance(this.keypair.publicKey);
    if (walletBalance < MIN_SOL_FOR_FEES) {
      console.log(`❌ Insufficient SOL for fees: ${walletBalance / LAMPORTS_PER_SOL} SOL`);
      return false;
    }

    const { pair, dex1, dex2, direction, spreadPercent, potentialProfitUsd, swapAmountUsd } = opportunity;
    
    console.log(`\n🔄 Executing Cross-DEX Arbitrage:`);
    console.log(`   Wallet: ${(walletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    console.log(`   Pair: ${pair}`);
    console.log(`   DEXes: ${dex1} ↔ ${dex2}`);
    console.log(`   Direction: ${direction}`);
    console.log(`   Spread: ${spreadPercent.toFixed(3)}%`);
    console.log(`   Swap Amount: $${swapAmountUsd.toLocaleString()}`);
    console.log(`   Potential Profit: $${potentialProfitUsd.toFixed(2)}`);

    try {
      // Determine DEX order based on direction (buy on cheaper, sell on more expensive)
      const [buyDex, sellDex] = direction.includes('_to_') 
        ? direction.split('_to_') 
        : [dex1, dex2];

      // Get USDC reserve
      const usdcMint = new PublicKey(TOKENS.USDC);
      const reserve = this.market.getReserveByMint(usdcMint);
      if (!reserve) {
        console.log('   ❌ USDC reserve not found');
        return false;
      }

      // DYNAMIC OPTIMAL AMOUNT: Test multiple amounts based on Kamino + DEX liquidity
      console.log(`   🔍 Finding optimal flash loan amount...`);
      console.log(`   Buy on: ${buyDex} -> Sell on: ${sellDex}`);
      console.log(`   Mode: ${USE_DIRECT_AMM ? '🚀 DIRECT AMM (low fees)' : '🔄 Jupiter'}`);
      
      // Calculate optimal test amounts based on available liquidity
      const testAmounts = await this.calculateOptimalAmounts(spreadPercent, buyDex, sellDex);
      
      if (testAmounts.length === 0) {
        console.log(`   ❌ No valid amounts to test (insufficient Kamino liquidity)`);
        return false;
      }
      
      let bestAmount = 0;
      let bestProfit = 0;
      let bestSwap1: any = null;
      let bestSwap2: any = null;

      for (const amountUsd of testAmounts) {
        const amount = BigInt(Math.floor(amountUsd * 1_000_000)); // USDC amount (6 decimals)
        
        if (USE_DIRECT_AMM && (buyDex === 'raydium' || buyDex === 'orca') && (sellDex === 'raydium' || sellDex === 'orca')) {
          // DIRECT AMM SWAP - Much lower fees!
          const swap1 = await createDirectSwapInstructions(
            this.connection,
            this.keypair.publicKey,
            buyDex as 'raydium' | 'orca',
            amount,
            'USDC_TO_SOL',
            30 // 0.3% slippage
          );
          if (!swap1) continue;

          const swap2 = await createDirectSwapInstructions(
            this.connection,
            this.keypair.publicKey,
            sellDex as 'raydium' | 'orca',
            swap1.expectedOutput,
            'SOL_TO_USDC',
            30
          );
          if (!swap2) continue;

          const returned = swap2.expectedOutput;
          const fee = amount * 1n / 100000n; // 0.001% Kamino fee
          const profit = Number(returned - amount - fee) / 1_000_000;
          
          console.log(`   💰 $${amountUsd.toLocaleString()} → profit: $${profit.toFixed(2)} (DIRECT)`);
          
          if (profit > bestProfit) {
            bestProfit = profit;
            bestAmount = amountUsd;
            bestSwap1 = swap1;
            bestSwap2 = swap2;
          }
        } else {
          // JUPITER FALLBACK (for PumpSwap or if direct AMM disabled)
          const q1 = await this.getQuoteFromDex(TOKENS.USDC, TOKENS.SOL, amount, buyDex);
          if (!q1) continue;
          
          const solAmount = BigInt(q1.outAmount);
          
          const q2 = await this.getQuoteFromDex(TOKENS.SOL, TOKENS.USDC, solAmount, sellDex);
          if (!q2) continue;
          
          const returned = BigInt(q2.outAmount);
          const fee = amount * 1n / 100000n;
          const profit = Number(returned - amount - fee) / 1_000_000;
          
          console.log(`   💰 $${amountUsd.toLocaleString()} → profit: $${profit.toFixed(2)} (Jupiter)`);
          
          if (profit > bestProfit) {
            bestProfit = profit;
            bestAmount = amountUsd;
            bestSwap1 = { quote: q1 };
            bestSwap2 = { quote: q2 };
          }
        }
      }

      // Lower profit threshold for direct AMM (fees are much lower)
      const minProfit = USE_DIRECT_AMM ? 0.01 : 0.10; // $0.01 for direct, $0.10 for Jupiter
      
      if (bestProfit < minProfit || !bestSwap1 || !bestSwap2) {
        console.log(`   ❌ No profitable amount found (best: $${bestProfit.toFixed(2)}, need >$${minProfit})`);
        crossDexStats.missedReasons.spreadTooLow++;
        recordTrade({
          pair,
          type: 'cross_dex',
          amount: bestAmount,
          profit: bestProfit,
          profitUsd: bestProfit,
          status: 'opportunity_detected',
          details: `${buyDex} → ${sellDex}: Spread ${spreadPercent.toFixed(3)}% but real profit $${bestProfit.toFixed(2)}`,
        });
        return false;
      }

      // Use the best amount found
      const flashAmountUsd = bestAmount;
      const flashAmountRaw = Math.floor(flashAmountUsd * 1_000_000);
      const flashAmount = BigInt(flashAmountRaw); // Use BigInt, cast to any for SDK
      const profitUsd = bestProfit;

      console.log(`   ✅ OPTIMAL: $${flashAmountUsd.toLocaleString()} → profit: $${profitUsd.toFixed(2)}`);

      // Get swap instructions
      let swapIx1: SwapInstructions | null = null;
      let swapIx2: SwapInstructions | null = null;

      if (USE_DIRECT_AMM && bestSwap1.instructions) {
        // Direct AMM instructions - wrap in SwapInstructions format
        swapIx1 = {
          setupInstructions: [],
          swapInstruction: bestSwap1.instructions,
          addressLookupTableAddresses: [],
        };
        swapIx2 = {
          setupInstructions: [],
          swapInstruction: bestSwap2.instructions,
          addressLookupTableAddresses: [],
        };
      } else {
        // Jupiter instructions
        swapIx1 = await this.getSwapInstructions(bestSwap1.quote);
        swapIx2 = await this.getSwapInstructions(bestSwap2.quote);
      }

      if (!swapIx1 || !swapIx2) {
        console.log('   ❌ Failed to get swap instructions');
        return false;
      }

      // Build the atomic transaction
      const result = await this.buildAndExecuteTransaction(
        reserve,
        flashAmount,
        swapIx1,
        swapIx2,
        profitUsd,
        pair,
        buyDex,
        sellDex
      );

      return result;

    } catch (error) {
      console.log(`   ❌ Execution error: ${error}`);
      crossDexStats.opportunitiesMissed++;
      crossDexStats.missedReasons.other++;
      return false;
    }
  }

  private async getQuoteFromDex(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    dex: string // 'raydium', 'orca', or 'pumpswap'
  ): Promise<any> {
    try {
      const dexFilter = DEX_LABELS[dex];
      const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100&dexes=${encodeURIComponent(dexFilter)}`;
      
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (JUPITER_API_KEY) {
        headers['x-api-key'] = JUPITER_API_KEY;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        console.log(`   Quote error from ${dex}: ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.log(`   Quote fetch error: ${error}`);
      return null;
    }
  }

  private async getSwapInstructions(quote: any): Promise<SwapInstructions | null> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (JUPITER_API_KEY) {
        headers['x-api-key'] = JUPITER_API_KEY;
      }

      const response = await fetch(JUPITER_SWAP_API, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.keypair.publicKey.toString(),
          dynamicComputeUnitLimit: true,
          dynamicSlippage: true,
          prioritizationFeeLamports: 'auto',
        }),
      });

      if (!response.ok) {
        console.log(`   Swap instructions error: ${response.status}`);
        return null;
      }

      return await response.json() as SwapInstructions;
    } catch (error) {
      console.log(`   Swap instructions fetch error: ${error}`);
      return null;
    }
  }

  private async buildAndExecuteTransaction(
    reserve: KaminoReserve,
    flashAmount: bigint,
    swapIx1: SwapInstructions,
    swapIx2: SwapInstructions,
    profitUsd: number,
    pair: string,
    buyDex: string,
    sellDex: string
  ): Promise<boolean> {
    if (!this.market) return false;

    // Get user's USDC ATA
    const usdcMint = new PublicKey(TOKENS.USDC);
    const solMint = new PublicKey(TOKENS.SOL);
    const userUsdcAta = getATA(usdcMint, this.keypair.publicKey);
    const userSolAta = getATA(solMint, this.keypair.publicKey);

    // Get lending market authority
    const lendingMarketAuthority = await this.market.getLendingMarketAuthority();

    // Build flash loan instructions
    const { flashBorrowIxn, flashRepayIxn } = getFlashLoanInstructions({
      borrowIxnIndex: 0, // Will be adjusted
      walletPublicKey: this.keypair.publicKey,
      lendingMarketAuthority,
      lendingMarketAddress: this.market.getAddress(),
      reserve,
      amountLamports: flashAmount as any, // Cast to any - SDK type mismatch
      destinationAta: userUsdcAta,
      referrerAccount: this.keypair.publicKey, // Use wallet as placeholder
      referrerTokenState: this.keypair.publicKey, // Use wallet as placeholder
      programId: PROGRAM_ID,
    });

    // Collect all lookup tables
    const altAddresses = [...new Set([
      ...swapIx1.addressLookupTableAddresses,
      ...swapIx2.addressLookupTableAddresses,
    ])];
    const lookupTables = await this.getAddressLookupTableAccounts(altAddresses);

    // Build instruction list
    const instructions: TransactionInstruction[] = [];

    // Compute budget
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 })); // Lower priority fee

    // Smart Jito tip strategy:
    // - Minimum: 0.001 SOL (enough to get noticed)
    // - Maximum: 30% of profit (keep 70% for yourself)
    // - Scale: tip more for bigger profits
    const SOL_PRICE_USD = 100; // Approximate SOL price
    const profitInSol = profitUsd / SOL_PRICE_USD;
    const tipSol = Math.min(
      profitInSol * 0.30, // Max 30% of profit
      0.05 // Cap at 0.05 SOL (~$5)
    );
    const tipLamports = Math.max(
      1_000_000, // Min 0.001 SOL
      Math.floor(tipSol * LAMPORTS_PER_SOL)
    );
    const tipUsd = (tipLamports / LAMPORTS_PER_SOL) * SOL_PRICE_USD;
    const netProfitUsd = profitUsd - tipUsd;
    
    console.log(`   💸 Jito tip: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL (~$${tipUsd.toFixed(2)})`);
    console.log(`   💰 Net profit after tip: $${netProfitUsd.toFixed(2)}`);
    console.log(`   🔧 Building transaction...`);

    instructions.push(SystemProgram.transfer({
      fromPubkey: this.keypair.publicKey,
      toPubkey: JITO_TIP_ACCOUNT,
      lamports: tipLamports,
    }));

    // Ensure ATAs exist (with retry for rate limiting)
    try {
      await this.ensureAta(instructions, usdcMint);
      await this.ensureAta(instructions, solMint);
    } catch (ataError) {
      console.log(`   ⚠️ ATA check failed, continuing: ${ataError}`);
    }

    // Record flash borrow index
    const flashBorrowIndex = instructions.length;

    // FLASH BORROW
    instructions.push(flashBorrowIxn);

    // SWAP 1: USDC -> SOL (buy on cheaper DEX)
    for (const ix of swapIx1.setupInstructions || []) {
      instructions.push(this.deserializeInstruction(ix));
    }
    instructions.push(this.deserializeInstruction(swapIx1.swapInstruction));
    if (swapIx1.cleanupInstruction) {
      instructions.push(this.deserializeInstruction(swapIx1.cleanupInstruction));
    }

    // SWAP 2: SOL -> USDC (sell on more expensive DEX)
    for (const ix of swapIx2.setupInstructions || []) {
      instructions.push(this.deserializeInstruction(ix));
    }
    instructions.push(this.deserializeInstruction(swapIx2.swapInstruction));
    if (swapIx2.cleanupInstruction) {
      instructions.push(this.deserializeInstruction(swapIx2.cleanupInstruction));
    }

    // FLASH REPAY with correct borrow index
    const { flashRepayIxn: flashRepayIxnCorrected } = getFlashLoanInstructions({
      borrowIxnIndex: flashBorrowIndex,
      walletPublicKey: this.keypair.publicKey,
      lendingMarketAuthority,
      lendingMarketAddress: this.market.getAddress(),
      reserve,
      amountLamports: flashAmount as any, // Cast to any - SDK type mismatch
      destinationAta: userUsdcAta,
      referrerAccount: this.keypair.publicKey, // Use wallet as placeholder
      referrerTokenState: this.keypair.publicKey, // Use wallet as placeholder
      programId: PROGRAM_ID,
    });
    instructions.push(flashRepayIxnCorrected);

    // Build versioned transaction (with retry for rate limiting)
    console.log(`   📦 Getting blockhash...`);
    let blockhash;
    for (let retry = 0; retry < 3; retry++) {
      try {
        blockhash = await this.connection.getLatestBlockhash('finalized');
        break;
      } catch (e) {
        if (retry < 2) {
          console.log(`   ⏳ RPC rate limited, waiting ${(retry + 1) * 500}ms...`);
          await new Promise(r => setTimeout(r, (retry + 1) * 500));
        } else {
          throw e;
        }
      }
    }
    if (!blockhash) throw new Error('Failed to get blockhash');
    
    const messageV0 = new TransactionMessage({
      payerKey: this.keypair.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions,
    }).compileToV0Message(lookupTables);

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([this.keypair]);

    // Simulate first
    console.log('   🔄 Simulating...');
    const simulation = await this.connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });

    if (simulation.value.err) {
      console.log('   ❌ Simulation failed:', JSON.stringify(simulation.value.err));
      if (simulation.value.logs) {
        const errorLogs = simulation.value.logs.filter((l: string) => 
          l.toLowerCase().includes('error') || 
          l.toLowerCase().includes('failed')
        ).slice(-3);
        errorLogs.forEach((l: string) => console.log('      ', l));
      }
      
      recordTrade({
        pair,
        type: 'cross_dex',
        amount: Number(flashAmount) / 1_000_000,
        profit: profitUsd,
        profitUsd,
        status: 'simulation_failed',
        details: `${buyDex} -> ${sellDex}`,
      });
      
      return false;
    }

    console.log('   ✅ Simulation OK! Sending...');

    // Send transaction
    try {
      const signature = await this.connection.sendTransaction(transaction, {
        maxRetries: 3,
        skipPreflight: true,
      });
      console.log(`   📤 Sent: ${signature}`);

      // Wait for confirmation
      const confirmation = await this.connection.confirmTransaction({
        signature,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      }, 'confirmed');

      if (confirmation.value.err) {
        console.log('   ❌ Tx failed:', confirmation.value.err);
        recordTrade({
          pair,
          type: 'cross_dex',
          amount: Number(flashAmount) / 1_000_000,
          profit: profitUsd,
          profitUsd,
          status: 'failed',
          details: `TX failed: ${confirmation.value.err}`,
        });
        return false;
      }

      console.log(`   ✅ SUCCESS! Profit: $${profitUsd.toFixed(2)}`);
      console.log(`   🔗 https://solscan.io/tx/${signature}`);

      // Update stats
      crossDexStats.opportunitiesExecuted++;
      crossDexStats.totalProfitUsd += profitUsd;
      botStats.totalProfitUsd += profitUsd;
      botStats.opportunitiesFound++;
      botStats.successfulTrades++;

      recordTrade({
        pair,
        type: 'cross_dex',
        amount: Number(flashAmount) / 1_000_000,
        profit: profitUsd,
        profitUsd,
        status: 'cross_dex_success',
        details: `${buyDex} -> ${sellDex}, TX: ${signature}`,
      });

      return true;

    } catch (error) {
      console.log(`   ❌ Send error: ${error}`);
      crossDexStats.opportunitiesMissed++;
      crossDexStats.missedReasons.latency++;
      return false;
    }
  }

  private async getAddressLookupTableAccounts(addresses: string[]): Promise<AddressLookupTableAccount[]> {
    const accounts: AddressLookupTableAccount[] = [];
    
    for (const address of addresses) {
      try {
        const account = await this.connection.getAddressLookupTable(new PublicKey(address));
        if (account.value) {
          accounts.push(account.value);
        }
      } catch (error) {
        // Skip invalid lookup tables
      }
    }
    
    return accounts;
  }

  private async ensureAta(instructions: TransactionInstruction[], mint: PublicKey): Promise<void> {
    const ata = getATA(mint, this.keypair.publicKey);
    
    try {
      const accountInfo = await this.connection.getAccountInfo(ata);
      if (!accountInfo) {
        // ATA doesn't exist, create it manually
        instructions.push(
          new TransactionInstruction({
            programId: ASSOCIATED_TOKEN_PROGRAM_ID,
            keys: [
              { pubkey: this.keypair.publicKey, isSigner: true, isWritable: true },
              { pubkey: ata, isSigner: false, isWritable: true },
              { pubkey: this.keypair.publicKey, isSigner: false, isWritable: false },
              { pubkey: mint, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: Buffer.alloc(0),
          })
        );
      }
    } catch {
      // Error checking, skip ATA creation
    }
  }

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
}

export default CrossDexExecutor;
