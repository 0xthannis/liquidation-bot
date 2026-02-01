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
import { startApiServer, recordTrade, recordScan, updateWalletBalance } from './api-server';

// ============== CONFIGURATION ==============
const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';

// Kamino Main Market
const KAMINO_MARKET_ADDRESS = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';

// Token mints - MASSIVE list for maximum opportunities
const TOKENS: Record<string, string> = {
  // Core tokens
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  
  // Liquid Staking Tokens (LSTs) - High volume, stable
  JitoSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  mSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  bSOL: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  stSOL: '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',
  INF: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',
  jupSOL: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
  
  // Memecoins - VERY volatile = MORE opportunities
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  POPCAT: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  MEW: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
  BOME: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
  SLERF: '7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3',
  MYRO: 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4',
  WEN: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk',
  SAMO: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  
  // DeFi tokens - Good liquidity
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
  JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  MNDE: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey',
  LDO: 'HZRCwxP2Vq9PCpPXooayhJ2bxTB5AMqS52gsRkVjGxzL',
  RENDER: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',
  HNT: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',
  MOBILE: 'mb1eu7TzEc71KxDpsmsKoucSSuuoGLv1drys1oP2jh6',
  IOT: 'iotEVVZLEywoTn1QdwNPddxPWszn3zFhEot3MfL9fns',
  
  // Stablecoins - For triangular arb
  UXD: '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT',
  USDH: 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',
  PAI: 'Ea5SjE2Y6yvCeW5dYTn7PYMuW5ikXkvbGdcmSnXeaLjS',
  
  // Gaming/NFT tokens
  ATLAS: 'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx',
  POLIS: 'poLisWXnNRwC6oBu1vHiuKQzFjGL4XDSu4g9qjz9qVk',
  DUST: 'DUSTawucrTsGU8hcqRdHDCbuYhCPADMLM2VcCb8VnFnQ',
  FORGE: 'FoRGERiW7odcCBGU1bztZi16osPBHjxharvDathL5eds',
  
  // Other high-volume tokens
  STEP: 'StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT',
  SBR: 'Saber2gLauYim4Mvftnrasomsv6NvAuncvMEZwcLpD1',
  COPE: '8HGyAAB1yoM1ttS7pXjHMa3dukTFGQggnFFH3hJZgzQh',
  FIDA: 'EchesyfXePKdLtoiZSL8pBe8Myagyy8ZRqsACNCFGnvp',
  MEDIA: 'ETAtLmCmsoiEEKfNrHKJ2kYy3MoABhU6NQvpSfij5tDs',
  TULIP: 'TuLipcqtGVXP9XR62wM8WWCm6a9vhLs7T1uoWBk6FDs',
  SLND: 'SLNDpmoWTVADgEdndyvWzroNL7zSi1dF9PC3xHGtPwp',
  PORT: 'PoRTjZMPXb9T7dyU7tpLEZRQj7e6ssfAE62j2oQuc6y',
  GENE: 'GENEtH5amGSi8kHAtQoezp1XEXwZJ8vcuePYnXdKrMYz',
  DFL: 'DFL1zNkaGPWm1BqAVqRjCZvHmwTFrEaJtbzJWgseoNJh',
  SHDW: 'SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y',
  GST: 'AFbX8oGjGpmVFywbVouvhQSRmiW2aR1mohfahi4Y2AdB',
  GMT: '7i5KKsX2weiTkry7jA4ZwSuXGhs5eJBEjY8vVxR4pfRx',
};

// Jupiter API (requires free API key from portal.jup.ag)
const JUPITER_QUOTE_API = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://api.jup.ag/swap/v1/swap-instructions';

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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (JUPITER_API_KEY) {
      headers['x-api-key'] = JUPITER_API_KEY;
    }
    const response = await fetch(url, { headers });
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (JUPITER_API_KEY) {
      headers['x-api-key'] = JUPITER_API_KEY;
    }
    const response = await fetch(JUPITER_SWAP_API, {
      method: 'POST',
      headers,
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
  } catch (e: any) {
    console.log(`   Swap instructions exception: ${e.message?.slice(0, 80)}`);
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
  // Use tighter slippage for larger amounts
  const slippageBps = Number(flashLoanAmount) > 100_000_000_000n ? 50 : 100; // 0.5% for >100K, else 1%
  const quoteForward = await getJupiterQuote(flashMint, swapMint, Number(flashLoanAmount), slippageBps);
  if (!quoteForward) {
    console.log('   ❌ No quote forward');
    recordTrade({
      pair: `${flashTokenSymbol} → ${swapTokenSymbol} → ${flashTokenSymbol}`,
      amount: displayAmount,
      token: flashTokenSymbol,
      profit: 0,
      profitUsd: 0,
      status: 'no_route',
      reason: `Pas de route Jupiter: ${flashTokenSymbol} → ${swapTokenSymbol}`,
    });
    return null;
  }
  
  const amountMid = parseInt(quoteForward.outAmount);
  if (amountMid === 0) {
    console.log('   ❌ Zero mid amount');
    return null;
  }
  
  const quoteReturn = await getJupiterQuote(swapMint, flashMint, amountMid, slippageBps);
  if (!quoteReturn) {
    console.log('   ❌ No quote return');
    recordTrade({
      pair: `${flashTokenSymbol} → ${swapTokenSymbol} → ${flashTokenSymbol}`,
      amount: displayAmount,
      token: flashTokenSymbol,
      profit: 0,
      profitUsd: 0,
      status: 'no_route',
      reason: `Pas de route retour: ${swapTokenSymbol} → ${flashTokenSymbol}`,
    });
    return null;
  }
  
  const amountOut = BigInt(quoteReturn.outAmount);
  const flashLoanFee = flashLoanAmount * 9n / 10000n; // 0.09% Kamino fee
  const totalRepay = flashLoanAmount + flashLoanFee;
  
  // Check profitability - need buffer for gas (~0.001 SOL = 1M lamports worth)
  const gasBuffer = decimals === 9 ? 1_000_000n : 1000n; // 0.001 SOL or 0.001 USDC
  if (amountOut <= totalRepay + gasBuffer) {
    const diff = Number(totalRepay - amountOut);
    const loss = diff / Math.pow(10, decimals);
    const lossUsd = (flashTokenSymbol === 'SOL' || flashTokenSymbol === 'JitoSOL') ? loss * 200 : loss;
    console.log(`   ❌ Not profitable: -${loss} ${flashTokenSymbol}`);
    recordTrade({
      pair: `${flashTokenSymbol} → ${swapTokenSymbol} → ${flashTokenSymbol}`,
      amount: displayAmount,
      token: flashTokenSymbol,
      profit: -loss,
      profitUsd: -lossUsd,
      status: 'not_profitable',
      reason: `Perte: -${loss.toFixed(4)} ${flashTokenSymbol} (-$${lossUsd.toFixed(2)})`,
      quoteIn: displayAmount,
      quoteOut: Number(amountOut) / Math.pow(10, decimals),
    });
    return null;
  }
  
  const profit = Number(amountOut - totalRepay);
  const profitDisplay = profit / Math.pow(10, decimals);
  const profitPercent = (profit / Number(flashLoanAmount)) * 100;
  
  console.log(`   💰 Profit: ${profitDisplay.toFixed(6)} ${flashTokenSymbol} (${profitPercent.toFixed(4)}%)`);
  
  // Only execute if profit > $1 equivalent (skip dust)
  // For USDC: profit is in micro-USDC, so 1$ = 1_000_000
  // For SOL: profit is in lamports, 1$ ≈ 0.005 SOL = 5_000_000 lamports
  const minProfitUsd = 1.0; // Minimum $1 profit
  const profitInUsd = (flashTokenSymbol === 'SOL' || flashTokenSymbol === 'JitoSOL') 
    ? profit / 200_000_000 // ~$200/SOL, so lamports / 200M = USD
    : profit / 1_000_000;  // micro-USDC / 1M = USD
  
  if (profitInUsd < minProfitUsd) {
    console.log(`   ⏭️ Profit too small: $${profitInUsd.toFixed(2)} < $${minProfitUsd}`);
    recordTrade({
      pair: `${flashTokenSymbol} → ${swapTokenSymbol} → ${flashTokenSymbol}`,
      amount: displayAmount,
      token: flashTokenSymbol,
      profit: profitDisplay,
      profitUsd: profitInUsd,
      status: 'skipped',
      reason: `Profit trop petit: $${profitInUsd.toFixed(2)} < seuil $${minProfitUsd}`,
      quoteIn: displayAmount,
      quoteOut: Number(amountOut) / Math.pow(10, decimals),
    });
    return null;
  }
  
  // 3. Get swap instructions from Jupiter (with rate limit delays)
  await new Promise(r => setTimeout(r, 1100)); // Wait for rate limit
  const swapIx1 = await getJupiterSwapInstructions(quoteForward, keypair.publicKey);
  await new Promise(r => setTimeout(r, 1100)); // Wait for rate limit
  const swapIx2 = await getJupiterSwapInstructions(quoteReturn, keypair.publicKey);
  
  if (!swapIx1 || !swapIx2) {
    console.log('   ❌ Failed to get swap instructions');
    return null;
  }
  
  // 4. Get user's ATAs for both tokens
  const userFlashAta = await getAssociatedTokenAddress(new PublicKey(flashMint), keypair.publicKey);
  const userSwapAta = await getAssociatedTokenAddress(new PublicKey(swapMint), keypair.publicKey);
  
  // 5. Build flash loan instructions using Kamino SDK
  const lendingMarketAuthority = await market.getLendingMarketAuthority();
  
  const { flashBorrowIx, flashRepayIx } = getFlashLoanInstructions({
    borrowIxIndex: 0, // Will be adjusted below
    userTransferAuthority: keypair.publicKey,
    lendingMarketAuthority,
    lendingMarketAddress: market.getAddress(),
    reserve,
    amountLamports: flashLoanAmount,
    destinationAta: userFlashAta,
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
  
  // Jito tip for faster inclusion - DYNAMIC based on profit
  // Tip is part of atomic tx: if tx fails, tip is NOT paid
  // If tx succeeds, profit covers the tip
  // Strategy: 20% of profit to outbid competition, capped at 0.05 SOL
  let tipLamports: number;
  if (flashTokenSymbol === 'SOL' || flashTokenSymbol === 'JitoSOL') {
    // Profit is already in lamports
    tipLamports = Math.floor(profit * 0.20); // 20% of profit
  } else {
    // Profit is in micro-USDC, convert roughly to lamports
    // Assume 1 SOL ≈ 200 USDC, so 1 USDC ≈ 0.005 SOL = 5M lamports / 1M micro = 5 lamports per micro
    tipLamports = Math.floor(profit * 5 * 0.20); // 20% of profit in lamports
  }
  // Minimum 0.001 SOL, maximum 0.05 SOL
  tipLamports = Math.max(1_000_000, Math.min(tipLamports, 50_000_000));
  
  console.log(`   💸 Jito tip: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  
  instructions.push(SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: JITO_TIP_ACCOUNT,
    lamports: tipLamports,
  }));
  
  // Create ATAs if needed for both tokens
  const { createIx: createFlashAtaIx } = await ensureAta(connection, keypair, new PublicKey(flashMint));
  const { createIx: createSwapAtaIx } = await ensureAta(connection, keypair, new PublicKey(swapMint));
  if (createFlashAtaIx) {
    instructions.push(createFlashAtaIx);
  }
  if (createSwapAtaIx) {
    instructions.push(createSwapAtaIx);
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
  // Note: Kamino SDK calculates the fee internally, we pass the original borrow amount
  const { flashRepayIx: flashRepayIxCorrected } = getFlashLoanInstructions({
    borrowIxIndex: flashBorrowIndex,
    userTransferAuthority: keypair.publicKey,
    lendingMarketAuthority,
    lendingMarketAddress: market.getAddress(),
    reserve,
    amountLamports: flashLoanAmount, // Original amount - SDK adds fee
    destinationAta: userFlashAta,
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
    let errorReason = JSON.stringify(simulation.value.err);
    if (simulation.value.logs) {
      const errorLogs = simulation.value.logs.filter((l: string) => 
        l.toLowerCase().includes('error') || 
        l.toLowerCase().includes('failed') ||
        l.includes('Program log:')
      ).slice(-5);
      errorLogs.forEach((l: string) => console.log('      ', l));
      if (errorLogs.length > 0) errorReason = errorLogs[errorLogs.length - 1];
    }
    recordTrade({
      pair: `${flashTokenSymbol} → ${swapTokenSymbol} → ${flashTokenSymbol}`,
      amount: displayAmount,
      token: flashTokenSymbol,
      profit: profitDisplay,
      profitUsd: profitInUsd,
      status: 'simulation_failed',
      reason: `Simulation échouée: ${errorReason.slice(0, 100)}`,
    });
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
      recordTrade({
        pair: `${flashTokenSymbol} → ${swapTokenSymbol} → ${flashTokenSymbol}`,
        amount: displayAmount,
        token: flashTokenSymbol,
        profit: profitDisplay,
        profitUsd: profitInUsd,
        status: 'failed',
        reason: `Transaction échouée: ${JSON.stringify(confirmation.value.err).slice(0, 100)}`,
        txHash: signature,
      });
      return null;
    }
    
    console.log(`   ✅ SUCCESS! Sig: ${signature}`);
    console.log(`   💵 Profit: ~${profitDisplay.toFixed(6)} ${flashTokenSymbol}`);
    recordTrade({
      pair: `${flashTokenSymbol} → ${swapTokenSymbol} → ${flashTokenSymbol}`,
      amount: displayAmount,
      token: flashTokenSymbol,
      profit: profitDisplay,
      profitUsd: profitInUsd,
      status: 'success',
      txHash: signature,
    });
    return signature;
    
  } catch (e: any) {
    console.log('   ❌ Send error:', e.message?.slice(0, 100));
    recordTrade({
      pair: `${flashTokenSymbol} → ${swapTokenSymbol} → ${flashTokenSymbol}`,
      amount: displayAmount,
      token: flashTokenSymbol,
      profit: profitDisplay,
      profitUsd: profitInUsd,
      status: 'failed',
      reason: `Erreur envoi: ${e.message?.slice(0, 80) || 'Unknown'}`,
    });
    return null;
  }
}

// ============== MAIN ==============
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   ⚡ KAMINO FLASH LOAN ARBITRAGE BOT                      ║');
  console.log('║   Using Official Kamino SDK + Jupiter API                 ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  
  // Start API server for dashboard
  startApiServer(3001);
  
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
  updateWalletBalance(balance / LAMPORTS_PER_SOL);
  
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
  
  // Arbitrage configurations - MASSIVE list for maximum opportunities
  // Flash loans have NO collateral requirement - borrow as much as Kamino has liquidity
  const arbConfigs = [
    // ============ USDC FLASH LOANS ============
    // Core pairs - high volume
    { flash: 'USDC', swap: 'SOL', amounts: [10000n, 50000n, 100000n, 500000n, 1000000n] },
    { flash: 'USDC', swap: 'USDT', amounts: [10000n, 100000n, 500000n] },
    
    // LST pairs - very stable, good for arb
    { flash: 'USDC', swap: 'JitoSOL', amounts: [10000n, 50000n, 100000n, 500000n] },
    { flash: 'USDC', swap: 'mSOL', amounts: [10000n, 50000n, 100000n, 500000n] },
    { flash: 'USDC', swap: 'bSOL', amounts: [10000n, 50000n, 100000n] },
    { flash: 'USDC', swap: 'stSOL', amounts: [10000n, 50000n, 100000n] },
    { flash: 'USDC', swap: 'jupSOL', amounts: [10000n, 50000n, 100000n] },
    
    // MEMECOINS - volatile = MORE opportunities!
    { flash: 'USDC', swap: 'BONK', amounts: [5000n, 10000n, 50000n, 100000n] },
    { flash: 'USDC', swap: 'WIF', amounts: [5000n, 10000n, 50000n, 100000n] },
    { flash: 'USDC', swap: 'POPCAT', amounts: [5000n, 10000n, 50000n] },
    { flash: 'USDC', swap: 'MEW', amounts: [5000n, 10000n, 50000n] },
    { flash: 'USDC', swap: 'BOME', amounts: [5000n, 10000n, 50000n] },
    { flash: 'USDC', swap: 'SLERF', amounts: [5000n, 10000n, 25000n] },
    { flash: 'USDC', swap: 'WEN', amounts: [5000n, 10000n, 25000n] },
    { flash: 'USDC', swap: 'SAMO', amounts: [5000n, 10000n, 25000n] },
    
    // DeFi tokens - good liquidity
    { flash: 'USDC', swap: 'RAY', amounts: [10000n, 50000n, 100000n] },
    { flash: 'USDC', swap: 'ORCA', amounts: [10000n, 50000n, 100000n] },
    { flash: 'USDC', swap: 'JTO', amounts: [10000n, 50000n, 100000n] },
    { flash: 'USDC', swap: 'JUP', amounts: [10000n, 50000n, 100000n, 500000n] },
    { flash: 'USDC', swap: 'PYTH', amounts: [10000n, 50000n, 100000n] },
    { flash: 'USDC', swap: 'RENDER', amounts: [10000n, 50000n, 100000n] },
    { flash: 'USDC', swap: 'HNT', amounts: [10000n, 50000n, 100000n] },
    
    // Stablecoin triangular arb
    { flash: 'USDC', swap: 'UXD', amounts: [50000n, 100000n, 500000n] },
    { flash: 'USDC', swap: 'USDH', amounts: [50000n, 100000n, 500000n] },
    
    // Gaming tokens
    { flash: 'USDC', swap: 'ATLAS', amounts: [5000n, 10000n, 50000n] },
    { flash: 'USDC', swap: 'DUST', amounts: [5000n, 10000n, 50000n] },
    { flash: 'USDC', swap: 'GMT', amounts: [10000n, 50000n, 100000n] },
    
    // Other DeFi
    { flash: 'USDC', swap: 'MNDE', amounts: [5000n, 10000n, 50000n] },
    { flash: 'USDC', swap: 'SLND', amounts: [5000n, 10000n, 50000n] },
    { flash: 'USDC', swap: 'SHDW', amounts: [5000n, 10000n, 50000n] },
    
    // ============ SOL FLASH LOANS ============
    // Core pairs
    { flash: 'SOL', swap: 'USDC', amounts: [10n, 50n, 100n, 500n, 1000n] },
    { flash: 'SOL', swap: 'USDT', amounts: [10n, 50n, 100n, 500n] },
    
    // LST pairs - SOL<->LST very profitable!
    { flash: 'SOL', swap: 'JitoSOL', amounts: [10n, 50n, 100n, 500n, 1000n] },
    { flash: 'SOL', swap: 'mSOL', amounts: [10n, 50n, 100n, 500n, 1000n] },
    { flash: 'SOL', swap: 'bSOL', amounts: [10n, 50n, 100n, 500n] },
    { flash: 'SOL', swap: 'stSOL', amounts: [10n, 50n, 100n, 500n] },
    { flash: 'SOL', swap: 'jupSOL', amounts: [10n, 50n, 100n, 500n] },
    
    // Memecoins via SOL
    { flash: 'SOL', swap: 'BONK', amounts: [10n, 25n, 50n, 100n] },
    { flash: 'SOL', swap: 'WIF', amounts: [10n, 25n, 50n, 100n] },
    { flash: 'SOL', swap: 'POPCAT', amounts: [10n, 25n, 50n] },
    { flash: 'SOL', swap: 'MEW', amounts: [10n, 25n, 50n] },
    
    // DeFi via SOL
    { flash: 'SOL', swap: 'RAY', amounts: [10n, 50n, 100n] },
    { flash: 'SOL', swap: 'JUP', amounts: [10n, 50n, 100n, 500n] },
    { flash: 'SOL', swap: 'JTO', amounts: [10n, 50n, 100n] },
    { flash: 'SOL', swap: 'PYTH', amounts: [10n, 50n, 100n] },
    { flash: 'SOL', swap: 'RENDER', amounts: [10n, 50n, 100n] },
  ];
  
  console.log('🔍 Starting MEGA arbitrage scanner...\n');
  console.log(`📊 ${arbConfigs.length} pair configurations loaded!`);
  console.log('Categories: Core, LSTs, Memecoins, DeFi, Stables, Gaming');
  console.log('Flash tokens: USDC (up to 1M) | SOL (up to 1000)\n');
  
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
          recordScan(); // Track scan for dashboard
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
        
        // Delay to respect Jupiter rate limit (1 RPS on free tier)
        await new Promise(r => setTimeout(r, 1100));
      }
    }
    
    // Progress indicator
    if (scanCount % 10 === 0) {
      const newBalance = await connection.getBalance(keypair.publicKey);
      updateWalletBalance(newBalance / LAMPORTS_PER_SOL);
      console.log(`\n[Scan #${scanCount}] Balance: ${(newBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);
    } else {
      process.stdout.write('.');
    }
    
    // Delay between full scans
    await new Promise(r => setTimeout(r, 5000));
  }
}

// Run
main().catch(console.error);
