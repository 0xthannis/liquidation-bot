/**
 * Flash Loan Arbitrage Bot - Using Official Kamino SDK
 * Atomic: Flash Borrow -> Swap A->B -> Swap B->A -> Flash Repay -> Keep Profit
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
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount
} from '@solana/spl-token';
import { KaminoMarket, KaminoReserve, getFlashLoanInstructions, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import 'dotenv/config';

// ============== CONFIGURATION ==============
const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';

// Kamino Main Market
const KAMINO_MARKET_ADDRESS = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';

// Token mints
const TOKENS: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JitoSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
};

// Jupiter API (public v6 - no API key required)
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap-instructions';

// Jito tip account
const JITO_TIP_ACCOUNT = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');

// ============== TYPES ==============
interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
}

interface SwapInstructions {
  computeBudgetInstructions: any[];
  setupInstructions: any[];
  swapInstruction: any;
  cleanupInstruction: any;
  addressLookupTableAddresses: string[];
  error?: string;
}

// ============== HELPERS ==============
function loadKeypair(): Keypair {
  if (!PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY not set in .env');
  return Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
}

async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 100
): Promise<JupiterQuote | null> {
  try {
    const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      console.log(`   Quote error ${response.status}: ${text.slice(0, 80)}`);
      return null;
    }
    const data = await response.json();
    if (data.error) {
      console.log(`   Quote API error: ${data.error}`);
      return null;
    }
    return data;
  } catch (e: any) {
    console.log(`   Quote exception: ${e.message?.slice(0, 50)}`);
    return null;
  }
}

async function getJupiterSwapInstructions(
  quote: JupiterQuote,
  userPublicKey: PublicKey
): Promise<SwapInstructions | null> {
  try {
    const response = await fetch(JUPITER_SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: userPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.log(`   Swap instructions error: ${text.slice(0, 100)}`);
      return null;
    }
    const data = await response.json();
    if (data.error) {
      console.log(`   Swap error: ${data.error}`);
      return null;
    }
    return data;
  } catch (e) {
    return null;
  }
}

function deserializeInstruction(instruction: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((acc: any) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(instruction.data, 'base64'),
  });
}

async function getAddressLookupTableAccounts(
  connection: Connection,
  addresses: string[]
): Promise<AddressLookupTableAccount[]> {
  const accounts: AddressLookupTableAccount[] = [];
  for (const address of addresses) {
    try {
      const account = await connection.getAddressLookupTable(new PublicKey(address));
      if (account.value) accounts.push(account.value);
    } catch {}
  }
  return accounts;
}

async function ensureAta(
  connection: Connection,
  keypair: Keypair,
  mint: PublicKey
): Promise<{ ata: PublicKey; createIx: TransactionInstruction | null }> {
  const ata = await getAssociatedTokenAddress(mint, keypair.publicKey);
  try {
    await getAccount(connection, ata);
    return { ata, createIx: null };
  } catch {
    const createIx = createAssociatedTokenAccountInstruction(
      keypair.publicKey,
      ata,
      keypair.publicKey,
      mint
    );
    return { ata, createIx };
  }
}

// ============== FLASH LOAN ARBITRAGE WITH KAMINO SDK ==============
async function executeFlashLoanArbitrage(
  connection: Connection,
  keypair: Keypair,
  market: KaminoMarket,
  flashTokenSymbol: string,
  swapTokenSymbol: string,
  flashLoanAmount: bigint
): Promise<string | null> {
  const flashMint = TOKENS[flashTokenSymbol];
  const swapMint = TOKENS[swapTokenSymbol];
  
  if (!flashMint || !swapMint) {
    console.log(`   ❌ Unknown token: ${flashTokenSymbol} or ${swapTokenSymbol}`);
    return null;
  }
  
  const decimals = flashTokenSymbol === 'SOL' || flashTokenSymbol === 'JitoSOL' ? 9 : 6;
  const displayAmount = Number(flashLoanAmount) / Math.pow(10, decimals);
  
  console.log(`\n⚡ Flash Arb: ${displayAmount} ${flashTokenSymbol} <-> ${swapTokenSymbol}`);
  
  // 1. Get reserve from Kamino market
  const reserve = market.getReserveByMint(new PublicKey(flashMint));
  if (!reserve) {
    console.log(`   ❌ No Kamino reserve for ${flashTokenSymbol}`);
    return null;
  }
  
  // 2. Get Jupiter quotes for round-trip
  const quoteForward = await getJupiterQuote(flashMint, swapMint, Number(flashLoanAmount), 100);
  if (!quoteForward) {
    console.log('   ❌ No quote forward');
    return null;
  }
  
  const amountMid = parseInt(quoteForward.outAmount);
  if (amountMid === 0) {
    console.log('   ❌ Zero mid amount');
    return null;
  }
  
  const quoteReturn = await getJupiterQuote(swapMint, flashMint, amountMid, 100);
  if (!quoteReturn) {
    console.log('   ❌ No quote return');
    return null;
  }
  
  const amountOut = BigInt(quoteReturn.outAmount);
  const flashLoanFee = flashLoanAmount * 9n / 10000n; // 0.09% Kamino fee
  const totalRepay = flashLoanAmount + flashLoanFee;
  
  // Check profitability
  if (amountOut <= totalRepay + 20000n) { // Need some buffer for gas
    const diff = Number(totalRepay - amountOut);
    console.log(`   ❌ Not profitable: -${diff / Math.pow(10, decimals)} ${flashTokenSymbol}`);
    return null;
  }
  
  const profit = Number(amountOut - totalRepay);
  const profitDisplay = profit / Math.pow(10, decimals);
  const profitPercent = (profit / Number(flashLoanAmount)) * 100;
  
  console.log(`   💰 Profit: ${profitDisplay.toFixed(6)} ${flashTokenSymbol} (${profitPercent.toFixed(4)}%)`);
  
  // Only execute if profit > 0.01%
  if (profitPercent < 0.01) {
    console.log('   ⏭️ Profit too small, skipping');
    return null;
  }
  
  // 3. Get swap instructions from Jupiter
  const swapIx1 = await getJupiterSwapInstructions(quoteForward, keypair.publicKey);
  const swapIx2 = await getJupiterSwapInstructions(quoteReturn, keypair.publicKey);
  
  if (!swapIx1 || !swapIx2) {
    console.log('   ❌ Failed to get swap instructions');
    return null;
  }
  
  // 4. Get user's ATA for the flash loan token
  const userAta = await getAssociatedTokenAddress(new PublicKey(flashMint), keypair.publicKey);
  
  // 5. Build flash loan instructions using Kamino SDK
  const lendingMarketAuthority = await market.getLendingMarketAuthority();
  
  const { flashBorrowIx, flashRepayIx } = getFlashLoanInstructions({
    borrowIxIndex: 0, // Will be adjusted below
    userTransferAuthority: keypair.publicKey,
    lendingMarketAuthority,
    lendingMarketAddress: market.getAddress(),
    reserve,
    amountLamports: flashLoanAmount,
    destinationAta: userAta,
    referrerAccount: undefined,
    referrerTokenState: undefined,
    programId: PROGRAM_ID,
  });
  
  // 6. Collect all lookup tables
  const altAddresses = [...new Set([
    ...swapIx1.addressLookupTableAddresses,
    ...swapIx2.addressLookupTableAddresses,
  ])];
  const lookupTables = await getAddressLookupTableAccounts(connection, altAddresses);
  
  // 7. Build instruction list
  const instructions: TransactionInstruction[] = [];
  
  // Compute budget (high limit for flash loan + 2 swaps)
  instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
  instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })); // Higher priority
  
  // Jito tip for faster inclusion
  instructions.push(SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: JITO_TIP_ACCOUNT,
    lamports: 10000, // 0.00001 SOL
  }));
  
  // Create ATA if needed
  const { createIx: createAtaIx } = await ensureAta(connection, keypair, new PublicKey(flashMint));
  if (createAtaIx) {
    instructions.push(createAtaIx);
  }
  
  // Record flash borrow index (after compute budget + tip + maybe ATA)
  const flashBorrowIndex = instructions.length;
  
  // FLASH BORROW
  instructions.push(flashBorrowIx);
  
  // SWAP 1: flashToken -> swapToken
  for (const ix of swapIx1.setupInstructions || []) {
    instructions.push(deserializeInstruction(ix));
  }
  instructions.push(deserializeInstruction(swapIx1.swapInstruction));
  if (swapIx1.cleanupInstruction) {
    instructions.push(deserializeInstruction(swapIx1.cleanupInstruction));
  }
  
  // SWAP 2: swapToken -> flashToken
  for (const ix of swapIx2.setupInstructions || []) {
    instructions.push(deserializeInstruction(ix));
  }
  instructions.push(deserializeInstruction(swapIx2.swapInstruction));
  if (swapIx2.cleanupInstruction) {
    instructions.push(deserializeInstruction(swapIx2.cleanupInstruction));
  }
  
  // FLASH REPAY - need to rebuild with correct borrow index
  const { flashRepayIx: flashRepayIxCorrected } = getFlashLoanInstructions({
    borrowIxIndex: flashBorrowIndex,
    userTransferAuthority: keypair.publicKey,
    lendingMarketAuthority,
    lendingMarketAddress: market.getAddress(),
    reserve,
    amountLamports: totalRepay, // Include fee
    destinationAta: userAta,
    referrerAccount: undefined,
    referrerTokenState: undefined,
    programId: PROGRAM_ID,
  });
  instructions.push(flashRepayIxCorrected);
  
  // 8. Build versioned transaction
  const blockhash = await connection.getLatestBlockhash('finalized');
  
  const messageV0 = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([keypair]);
  
  // 9. Simulate first
  console.log('   🔄 Simulating...');
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  
  if (simulation.value.err) {
    console.log('   ❌ Simulation failed:', JSON.stringify(simulation.value.err));
    if (simulation.value.logs) {
      const errorLogs = simulation.value.logs.filter((l: string) => 
        l.toLowerCase().includes('error') || 
        l.toLowerCase().includes('failed') ||
        l.includes('Program log:')
      ).slice(-5);
      errorLogs.forEach((l: string) => console.log('      ', l));
    }
    return null;
  }
  
  console.log('   ✅ Simulation OK! Sending...');
  
  // 10. Send transaction
  try {
    const signature = await connection.sendTransaction(transaction, {
      maxRetries: 3,
      skipPreflight: true,
    });
    console.log(`   📤 Sent: ${signature}`);
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      console.log('   ❌ Tx failed:', confirmation.value.err);
      return null;
    }
    
    console.log(`   ✅ SUCCESS! Sig: ${signature}`);
    console.log(`   💵 Profit: ~${profitDisplay.toFixed(6)} ${flashTokenSymbol}`);
    return signature;
    
  } catch (e: any) {
    console.log('   ❌ Send error:', e.message?.slice(0, 100));
    return null;
  }
}

// ============== MAIN ==============
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   ⚡ KAMINO FLASH LOAN ARBITRAGE BOT                      ║');
  console.log('║   Using Official Kamino SDK + Jupiter API                 ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  
  // Load wallet
  const keypair = loadKeypair();
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  
  // Connect
  const connection = new Connection(RPC_URL, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  });
  
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  
  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    console.error('❌ Need at least 0.01 SOL for fees');
    return;
  }
  
  // Load Kamino market
  console.log('\nLoading Kamino market...');
  const market = await KaminoMarket.load(connection, new PublicKey(KAMINO_MARKET_ADDRESS));
  if (!market) {
    console.error('❌ Failed to load Kamino market');
    return;
  }
  console.log('✅ Kamino market loaded');
  
  // Load reserves
  await market.loadReserves();
  console.log(`✅ ${market.reserves.size} reserves loaded\n`);
  
  // Arbitrage configurations
  const arbConfigs = [
    // USDC flash loans
    { flash: 'USDC', swap: 'SOL', amounts: [100n, 1000n, 10000n, 100000n] }, // USDC amounts
    { flash: 'USDC', swap: 'USDT', amounts: [1000n, 10000n, 100000n] },
    { flash: 'USDC', swap: 'JitoSOL', amounts: [100n, 1000n, 10000n] },
    // SOL flash loans
    { flash: 'SOL', swap: 'USDC', amounts: [1n, 10n, 100n] }, // SOL amounts
    { flash: 'SOL', swap: 'JitoSOL', amounts: [1n, 10n, 100n] },
  ];
  
  console.log('🔍 Starting arbitrage scanner...\n');
  console.log('Pairs: USDC<->SOL, USDC<->USDT, USDC<->JitoSOL, SOL<->USDC, SOL<->JitoSOL');
  console.log('Amounts: 100 to 100,000 USDC | 1 to 100 SOL\n');
  
  let scanCount = 0;
  
  // Main loop
  while (true) {
    scanCount++;
    
    for (const config of arbConfigs) {
      for (const baseAmount of config.amounts) {
        // Convert to base units
        const decimals = config.flash === 'SOL' || config.flash === 'JitoSOL' ? 9 : 6;
        const amount = baseAmount * BigInt(Math.pow(10, decimals));
        
        try {
          await executeFlashLoanArbitrage(
            connection,
            keypair,
            market,
            config.flash,
            config.swap,
            amount
          );
        } catch (e: any) {
          // Silently continue
        }
        
        // Small delay between checks
        await new Promise(r => setTimeout(r, 100));
      }
    }
    
    // Progress indicator
    if (scanCount % 10 === 0) {
      const newBalance = await connection.getBalance(keypair.publicKey);
      console.log(`\n[Scan #${scanCount}] Balance: ${(newBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);
    } else {
      process.stdout.write('.');
    }
    
    // Delay between full scans
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Run
main().catch(console.error);
