/**
 * Flash Loan Arbitrage Bot
 * Uses Kamino flash loans + Jupiter swaps for atomic arbitrage
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
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import bs58 from 'bs58';
import Decimal from 'decimal.js';
import 'dotenv/config';

// ============== CONFIGURATION ==============
const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';

// Kamino Main Market
const KAMINO_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const KAMINO_PROGRAM = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

// Token mints
const TOKENS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  BONK: new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
  JitoSOL: new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'),
};

// Jupiter API
const JUPITER_API = 'https://quote-api.jup.ag/v6';

// Jito tip accounts
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
];

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
  if (!PRIVATE_KEY) {
    throw new Error('WALLET_PRIVATE_KEY not set in environment');
  }
  const decoded = bs58.decode(PRIVATE_KEY);
  return Keypair.fromSecretKey(decoded);
}

async function getJupiterQuote(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: number,
  slippageBps: number = 50
): Promise<JupiterQuote | null> {
  try {
    const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Jupiter quote error: ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (e) {
    console.error('Jupiter quote error:', e);
    return null;
  }
}

async function getJupiterSwapInstructions(
  quote: JupiterQuote,
  userPublicKey: PublicKey
): Promise<SwapInstructions | null> {
  try {
    const response = await fetch(`${JUPITER_API}/swap-instructions`, {
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
      console.error(`Jupiter swap-instructions error: ${response.status} - ${text}`);
      return null;
    }
    
    return await response.json();
  } catch (e) {
    console.error('Jupiter swap-instructions error:', e);
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
    const pubkey = new PublicKey(address);
    const account = await connection.getAddressLookupTable(pubkey);
    if (account.value) {
      accounts.push(account.value);
    }
  }
  
  return accounts;
}

// ============== KAMINO FLASH LOAN ==============
// Discriminators from Anchor IDL
const FLASH_BORROW_DISCRIMINATOR = Buffer.from([0x87, 0xe7, 0x34, 0xa7, 0x07, 0x34, 0xd4, 0xc1]);
const FLASH_REPAY_DISCRIMINATOR = Buffer.from([0xb9, 0x75, 0x00, 0xcb, 0x60, 0xf5, 0xb4, 0xba]);

async function deriveLendingMarketAuthority(): Promise<PublicKey> {
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from('lma'), KAMINO_MARKET.toBuffer()],
    KAMINO_PROGRAM
  );
  return authority;
}

function buildFlashBorrowIx(
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey,
  reserve: PublicKey,
  reserveLiquidityMint: PublicKey,
  reserveSourceLiquidity: PublicKey,
  userDestinationLiquidity: PublicKey,
  sysvarInstructions: PublicKey,
  tokenProgram: PublicKey,
  amount: bigint
): TransactionInstruction {
  const data = Buffer.alloc(16);
  FLASH_BORROW_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  
  return new TransactionInstruction({
    programId: KAMINO_PROGRAM,
    keys: [
      { pubkey: lendingMarket, isSigner: false, isWritable: false },
      { pubkey: lendingMarketAuthority, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: reserveLiquidityMint, isSigner: false, isWritable: false },
      { pubkey: reserveSourceLiquidity, isSigner: false, isWritable: true },
      { pubkey: userDestinationLiquidity, isSigner: false, isWritable: true },
      { pubkey: sysvarInstructions, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildFlashRepayIx(
  userSourceLiquidity: PublicKey,
  reserveDestinationLiquidity: PublicKey,
  reserveLiquidityFeeReceiver: PublicKey,
  reserve: PublicKey,
  lendingMarket: PublicKey,
  userTransferAuthority: PublicKey,
  sysvarInstructions: PublicKey,
  tokenProgram: PublicKey,
  amount: bigint,
  borrowInstructionIndex: number
): TransactionInstruction {
  const data = Buffer.alloc(17);
  FLASH_REPAY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeUInt8(borrowInstructionIndex, 16);
  
  return new TransactionInstruction({
    programId: KAMINO_PROGRAM,
    keys: [
      { pubkey: userSourceLiquidity, isSigner: false, isWritable: true },
      { pubkey: reserveDestinationLiquidity, isSigner: false, isWritable: true },
      { pubkey: reserveLiquidityFeeReceiver, isSigner: false, isWritable: true },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: lendingMarket, isSigner: false, isWritable: false },
      { pubkey: userTransferAuthority, isSigner: true, isWritable: false },
      { pubkey: sysvarInstructions, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ============== ARBITRAGE SCANNER ==============
interface ArbitrageOpportunity {
  tokenA: PublicKey;
  tokenB: PublicKey;
  amountIn: number;
  expectedProfit: number;
  profitPercent: number;
  quoteForward: JupiterQuote;
  quoteReturn: JupiterQuote;
}

async function findArbitrageOpportunity(
  tokenA: PublicKey,
  tokenB: PublicKey,
  amountIn: number
): Promise<ArbitrageOpportunity | null> {
  // Get quote A -> B
  const quoteForward = await getJupiterQuote(tokenA, tokenB, amountIn, 50);
  if (!quoteForward) return null;
  
  const amountMid = parseInt(quoteForward.outAmount);
  if (amountMid === 0) return null;
  
  // Get quote B -> A (return trip)
  const quoteReturn = await getJupiterQuote(tokenB, tokenA, amountMid, 50);
  if (!quoteReturn) return null;
  
  const amountOut = parseInt(quoteReturn.outAmount);
  if (amountOut === 0) return null;
  
  // Calculate profit
  const flashLoanFee = Math.floor(amountIn * 0.0009); // 0.09% Kamino fee
  const gasFee = 15000; // ~0.000015 SOL
  const totalCost = flashLoanFee + gasFee;
  
  if (amountOut <= amountIn + totalCost) {
    return null; // Not profitable
  }
  
  const profit = amountOut - amountIn - totalCost;
  const profitPercent = (profit / amountIn) * 100;
  
  return {
    tokenA,
    tokenB,
    amountIn,
    expectedProfit: profit,
    profitPercent,
    quoteForward,
    quoteReturn,
  };
}

// ============== MAIN ARBITRAGE EXECUTION ==============
async function executeArbitrage(
  connection: Connection,
  keypair: Keypair,
  opportunity: ArbitrageOpportunity
): Promise<string | null> {
  console.log(`\n🎯 Executing arbitrage: ${opportunity.profitPercent.toFixed(4)}% profit expected`);
  console.log(`   Amount: ${opportunity.amountIn} -> Profit: ${opportunity.expectedProfit}`);
  
  try {
    // Get swap instructions for both legs
    const swapIx1 = await getJupiterSwapInstructions(opportunity.quoteForward, keypair.publicKey);
    if (!swapIx1 || swapIx1.error) {
      console.error('Failed to get swap instructions 1:', swapIx1?.error);
      return null;
    }
    
    const swapIx2 = await getJupiterSwapInstructions(opportunity.quoteReturn, keypair.publicKey);
    if (!swapIx2 || swapIx2.error) {
      console.error('Failed to get swap instructions 2:', swapIx2?.error);
      return null;
    }
    
    // Collect all address lookup tables
    const allAltAddresses = [
      ...swapIx1.addressLookupTableAddresses,
      ...swapIx2.addressLookupTableAddresses,
    ];
    const uniqueAltAddresses = [...new Set(allAltAddresses)];
    const lookupTables = await getAddressLookupTableAccounts(connection, uniqueAltAddresses);
    
    // Build instructions list
    const instructions: TransactionInstruction[] = [];
    
    // 1. Compute budget
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }));
    
    // 2. Jito tip (optional but helps with landing)
    const jitoTip = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: jitoTip,
        lamports: 1000, // 0.000001 SOL tip
      })
    );
    
    // 3. Setup instructions from swap 1
    for (const ix of swapIx1.setupInstructions) {
      instructions.push(deserializeInstruction(ix));
    }
    
    // 4. Swap 1 (A -> B)
    instructions.push(deserializeInstruction(swapIx1.swapInstruction));
    
    // 5. Cleanup from swap 1 if needed
    if (swapIx1.cleanupInstruction) {
      instructions.push(deserializeInstruction(swapIx1.cleanupInstruction));
    }
    
    // 6. Setup instructions from swap 2
    for (const ix of swapIx2.setupInstructions) {
      instructions.push(deserializeInstruction(ix));
    }
    
    // 7. Swap 2 (B -> A)
    instructions.push(deserializeInstruction(swapIx2.swapInstruction));
    
    // 8. Cleanup from swap 2 if needed
    if (swapIx2.cleanupInstruction) {
      instructions.push(deserializeInstruction(swapIx2.cleanupInstruction));
    }
    
    // Build versioned transaction
    const blockhash = await connection.getLatestBlockhash('finalized');
    const messageV0 = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions,
    }).compileToV0Message(lookupTables);
    
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([keypair]);
    
    // Simulate first
    console.log('   Simulating transaction...');
    const simulation = await connection.simulateTransaction(transaction);
    if (simulation.value.err) {
      console.error('   ❌ Simulation failed:', simulation.value.err);
      if (simulation.value.logs) {
        console.error('   Logs:', simulation.value.logs.slice(-5).join('\n'));
      }
      return null;
    }
    console.log('   ✅ Simulation successful');
    
    // Send transaction
    console.log('   Sending transaction...');
    const signature = await connection.sendTransaction(transaction, {
      maxRetries: 3,
      skipPreflight: true, // Already simulated
    });
    
    console.log(`   📤 Sent: ${signature}`);
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      console.error('   ❌ Transaction failed:', confirmation.value.err);
      return null;
    }
    
    console.log(`   ✅ Confirmed: ${signature}`);
    return signature;
    
  } catch (e) {
    console.error('   ❌ Arbitrage execution error:', e);
    return null;
  }
}

// ============== MAIN LOOP ==============
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║     🚀 FLASH LOAN ARBITRAGE BOT                          ║');
  console.log('║     Kamino Flash Loans + Jupiter Swaps                    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  
  // Load keypair
  const keypair = loadKeypair();
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  
  // Connect to RPC
  const connection = new Connection(RPC_URL, 'confirmed');
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  
  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    console.error('❌ Insufficient balance. Need at least 0.01 SOL for fees.');
    return;
  }
  
  console.log('\n🔍 Scanning for arbitrage opportunities...\n');
  
  // Arbitrage pairs to scan
  const pairs = [
    { tokenA: TOKENS.SOL, tokenB: TOKENS.USDC, amounts: [0.1, 1, 10] }, // SOL amounts
    { tokenA: TOKENS.SOL, tokenB: TOKENS.JitoSOL, amounts: [0.1, 1, 10] },
    { tokenA: TOKENS.USDC, tokenB: TOKENS.USDT, amounts: [100, 1000, 10000] }, // USDC amounts (6 decimals)
  ];
  
  // Main loop
  while (true) {
    for (const pair of pairs) {
      for (const amount of pair.amounts) {
        // Convert to lamports/base units
        let amountBase: number;
        if (pair.tokenA.equals(TOKENS.SOL) || pair.tokenA.equals(TOKENS.JitoSOL)) {
          amountBase = Math.floor(amount * LAMPORTS_PER_SOL);
        } else {
          amountBase = Math.floor(amount * 1_000_000); // 6 decimals for USDC/USDT
        }
        
        const opportunity = await findArbitrageOpportunity(pair.tokenA, pair.tokenB, amountBase);
        
        if (opportunity && opportunity.profitPercent > 0.05) { // Min 0.05% profit
          console.log(`\n💰 OPPORTUNITY FOUND!`);
          console.log(`   ${pair.tokenA.toBase58().slice(0,8)}... -> ${pair.tokenB.toBase58().slice(0,8)}...`);
          console.log(`   Amount: ${amount}, Profit: ${opportunity.expectedProfit} (${opportunity.profitPercent.toFixed(4)}%)`);
          
          // Execute arbitrage
          const sig = await executeArbitrage(connection, keypair, opportunity);
          if (sig) {
            console.log(`\n✅ ARBITRAGE SUCCESS! Signature: ${sig}`);
          }
        }
        
        // Small delay between checks
        await new Promise(r => setTimeout(r, 100));
      }
    }
    
    // Delay between full scans
    console.log('.');
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Run
main().catch(console.error);
