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
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount
} from '@solana/spl-token';
import { KaminoMarket, KaminoReserve, getFlashLoanInstructions, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import fetch from 'node-fetch';
import { CrossDexOpportunity, crossDexStats } from './cross-dex-monitor';
import { recordTrade, botStats } from './api-server';

// Configuration
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

// DEX labels for Jupiter
const DEX_LABELS = {
  raydium: 'Raydium,Raydium+CLMM,Raydium+CPMM',
  orca: 'Orca,Orca+V2,Orca+Whirlpool',
};

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

  constructor(connection: Connection, keypair: Keypair) {
    this.connection = connection;
    this.keypair = keypair;
  }

  async initialize(market: KaminoMarket): Promise<void> {
    this.market = market;
    console.log('✅ Cross-DEX Executor initialized');
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

    const { pair, direction, spreadPercent, potentialProfitUsd, swapAmountUsd } = opportunity;
    
    console.log(`\n🔄 Executing Cross-DEX Arbitrage:`);
    console.log(`   Wallet: ${(walletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    console.log(`   Pair: ${pair}`);
    console.log(`   Direction: ${direction}`);
    console.log(`   Spread: ${spreadPercent.toFixed(3)}%`);
    console.log(`   Swap Amount: $${swapAmountUsd.toLocaleString()}`);
    console.log(`   Potential Profit: $${potentialProfitUsd.toFixed(2)}`);

    try {
      // Determine DEX order based on direction
      const buyDex = direction === 'raydium_to_orca' ? 'raydium' : 'orca';
      const sellDex = direction === 'raydium_to_orca' ? 'orca' : 'raydium';

      // Calculate flash loan amount (in USDC micro-units)
      // Flash loans are FREE capital from Kamino - we don't need our own money!
      // The only cost is: Kamino fee (0.001%) + Jito tip + priority fees
      // 
      // MAXIMIZE PROFIT: Borrow as much as possible!
      // Limit: Kamino USDC reserve liquidity (~$50M available)
      // But also consider slippage - larger amounts = more slippage
      // Sweet spot: $50k-$500k depending on pool depth
      const flashAmountUsd = Math.min(500000, Math.max(50000, swapAmountUsd * 0.5));
      const flashAmount = BigInt(Math.floor(flashAmountUsd * 1_000_000)); // USDC has 6 decimals

      console.log(`   Flash Loan: $${flashAmountUsd.toLocaleString()} USDC`);
      console.log(`   Buy on: ${buyDex} -> Sell on: ${sellDex}`);

      // Get USDC reserve
      const usdcMint = new PublicKey(TOKENS.USDC);
      const reserve = this.market.getReserveByMint(usdcMint);
      if (!reserve) {
        console.log('   ❌ USDC reserve not found');
        return false;
      }

      // Get quotes from both DEXes
      const quote1 = await this.getQuoteFromDex(
        TOKENS.USDC,
        TOKENS.SOL,
        flashAmount,
        buyDex
      );

      if (!quote1) {
        console.log(`   ❌ No quote from ${buyDex}`);
        return false;
      }

      const solAmount = BigInt(quote1.outAmount);
      console.log(`   Quote 1 (${buyDex}): ${flashAmountUsd} USDC -> ${Number(solAmount) / LAMPORTS_PER_SOL} SOL`);

      const quote2 = await this.getQuoteFromDex(
        TOKENS.SOL,
        TOKENS.USDC,
        solAmount,
        sellDex
      );

      if (!quote2) {
        console.log(`   ❌ No quote from ${sellDex}`);
        return false;
      }

      const returnedUsdc = BigInt(quote2.outAmount);
      const flashLoanFee = flashAmount * 1n / 100000n; // 0.001% Kamino fee
      const totalToRepay = flashAmount + flashLoanFee;
      const profit = returnedUsdc - totalToRepay;
      const profitUsd = Number(profit) / 1_000_000;

      console.log(`   Quote 2 (${sellDex}): ${Number(solAmount) / LAMPORTS_PER_SOL} SOL -> ${Number(returnedUsdc) / 1_000_000} USDC`);
      console.log(`   Flash loan + fee: ${Number(totalToRepay) / 1_000_000} USDC`);
      console.log(`   Net profit: $${profitUsd.toFixed(2)}`);

      // Check profitability (need at least $1 after all fees)
      if (profitUsd < 1.0) {
        console.log('   ❌ Not profitable after fees');
        crossDexStats.missedReasons.spreadTooLow++;
        recordTrade({
          pair,
          type: 'cross_dex',
          amount: flashAmountUsd,
          profit: profitUsd,
          profitUsd,
          status: 'not_profitable',
          details: `Spread too low: ${spreadPercent.toFixed(3)}%`,
        });
        return false;
      }

      // Get swap instructions
      const swapIx1 = await this.getSwapInstructions(quote1);
      const swapIx2 = await this.getSwapInstructions(quote2);

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
    dex: 'raydium' | 'orca'
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
    const userUsdcAta = await getAssociatedTokenAddress(usdcMint, this.keypair.publicKey);
    const userSolAta = await getAssociatedTokenAddress(solMint, this.keypair.publicKey);

    // Get lending market authority
    const lendingMarketAuthority = await this.market.getLendingMarketAuthority();

    // Build flash loan instructions
    const { flashBorrowIx, flashRepayIx } = getFlashLoanInstructions({
      borrowIxIndex: 0, // Will be adjusted
      userTransferAuthority: this.keypair.publicKey,
      lendingMarketAuthority,
      lendingMarketAddress: this.market.getAddress(),
      reserve,
      amountLamports: flashAmount,
      destinationAta: userUsdcAta,
      referrerAccount: undefined,
      referrerTokenState: undefined,
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

    instructions.push(SystemProgram.transfer({
      fromPubkey: this.keypair.publicKey,
      toPubkey: JITO_TIP_ACCOUNT,
      lamports: tipLamports,
    }));

    // Ensure ATAs exist
    await this.ensureAta(instructions, usdcMint);
    await this.ensureAta(instructions, solMint);

    // Record flash borrow index
    const flashBorrowIndex = instructions.length;

    // FLASH BORROW
    instructions.push(flashBorrowIx);

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
    const { flashRepayIx: flashRepayIxCorrected } = getFlashLoanInstructions({
      borrowIxIndex: flashBorrowIndex,
      userTransferAuthority: this.keypair.publicKey,
      lendingMarketAuthority,
      lendingMarketAddress: this.market.getAddress(),
      reserve,
      amountLamports: flashAmount,
      destinationAta: userUsdcAta,
      referrerAccount: undefined,
      referrerTokenState: undefined,
      programId: PROGRAM_ID,
    });
    instructions.push(flashRepayIxCorrected);

    // Build versioned transaction
    const blockhash = await this.connection.getLatestBlockhash('finalized');
    
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
    const ata = await getAssociatedTokenAddress(mint, this.keypair.publicKey);
    
    try {
      await getAccount(this.connection, ata);
    } catch {
      // ATA doesn't exist, create it
      instructions.push(
        createAssociatedTokenAccountInstruction(
          this.keypair.publicKey,
          ata,
          this.keypair.publicKey,
          mint
        )
      );
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
