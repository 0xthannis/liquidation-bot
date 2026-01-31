/**
 * Flash Loan Arbitrage Bot - WITH KAMINO FLASH LOANS
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
  LAMPORTS_PER_SOL,
  SYSVAR_INSTRUCTIONS_PUBKEY
} from '@solana/web3.js';
import { 
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount
} from '@solana/spl-token';
import bs58 from 'bs58';
import 'dotenv/config';

// ============== CONFIGURATION ==============
const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';

// Kamino Main Market
const KAMINO_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const KAMINO_PROGRAM = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

// Known Kamino reserves (Main Market)
const KAMINO_RESERVES = {
  SOL: new PublicKey('d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q'),
  USDC: new PublicKey('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59'),
  USDT: new PublicKey('H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S'),
  JitoSOL: new PublicKey('EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpV3KYjKsktW'),
};

// Token mints
const TOKENS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  JitoSOL: new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'),
};

// Jupiter API
const JUPITER_API = 'https://quote-api.jup.ag/v6';

// Jito tip
const JITO_TIP_ACCOUNT = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');

// ============== KAMINO FLASH LOAN INSTRUCTIONS ==============
const FLASH_BORROW_DISCRIMINATOR = Buffer.from([0x87, 0xe7, 0x34, 0xa7, 0x07, 0x34, 0xd4, 0xc1]);
const FLASH_REPAY_DISCRIMINATOR = Buffer.from([0xb9, 0x75, 0x00, 0xcb, 0x60, 0xf5, 0xb4, 0xba]);

function deriveLendingMarketAuthority(): PublicKey {
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from('lma'), KAMINO_MARKET.toBuffer()],
    KAMINO_PROGRAM
  );
  return authority;
}

function deriveReserveLiquiditySupply(reserve: PublicKey): PublicKey {
  const [supply] = PublicKey.findProgramAddressSync(
    [Buffer.from('liquidity'), reserve.toBuffer()],
    KAMINO_PROGRAM
  );
  return supply;
}

function deriveReserveFeeReceiver(reserve: PublicKey): PublicKey {
  const [feeReceiver] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_receiver'), reserve.toBuffer()],
    KAMINO_PROGRAM
  );
  return feeReceiver;
}

function buildFlashBorrowIx(
  reserve: PublicKey,
  reserveMint: PublicKey,
  userAta: PublicKey,
  amount: bigint
): TransactionInstruction {
  const lendingMarketAuthority = deriveLendingMarketAuthority();
  const reserveLiquiditySupply = deriveReserveLiquiditySupply(reserve);
  
  const data = Buffer.alloc(16);
  FLASH_BORROW_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  
  return new TransactionInstruction({
    programId: KAMINO_PROGRAM,
    keys: [
      { pubkey: KAMINO_MARKET, isSigner: false, isWritable: false },
      { pubkey: lendingMarketAuthority, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: reserveMint, isSigner: false, isWritable: false },
      { pubkey: reserveLiquiditySupply, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildFlashRepayIx(
  reserve: PublicKey,
  userAta: PublicKey,
  userAuthority: PublicKey,
  amount: bigint,
  borrowIxIndex: number
): TransactionInstruction {
  const reserveLiquiditySupply = deriveReserveLiquiditySupply(reserve);
  const reserveFeeReceiver = deriveReserveFeeReceiver(reserve);
  
  const data = Buffer.alloc(17);
  FLASH_REPAY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeUInt8(borrowIxIndex, 16);
  
  return new TransactionInstruction({
    programId: KAMINO_PROGRAM,
    keys: [
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: reserveLiquiditySupply, isSigner: false, isWritable: true },
      { pubkey: reserveFeeReceiver, isSigner: false, isWritable: true },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: KAMINO_MARKET, isSigner: false, isWritable: false },
      { pubkey: userAuthority, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ============== JUPITER HELPERS ==============
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

async function getJupiterQuote(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: number,
  slippageBps: number = 100
): Promise<JupiterQuote | null> {
  try {
    const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
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
    if (!response.ok) return null;
    const data = await response.json();
    if (data.error) return null;
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

// ============== HELPERS ==============
function loadKeypair(): Keypair {
  if (!PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY not set');
  return Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
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

// ============== FLASH LOAN ARBITRAGE ==============
async function executeFlashLoanArbitrage(
  connection: Connection,
  keypair: Keypair,
  flashLoanToken: 'USDC' | 'SOL',
  swapToken: PublicKey,
  flashLoanAmount: bigint
): Promise<string | null> {
  console.log(`\n🚀 Flash Loan Arbitrage: ${flashLoanToken}`);
  console.log(`   Amount: ${Number(flashLoanAmount) / (flashLoanToken === 'SOL' ? LAMPORTS_PER_SOL : 1_000_000)}`);
  
  const flashMint = TOKENS[flashLoanToken];
  const flashReserve = KAMINO_RESERVES[flashLoanToken];
  
  // 1. Get Jupiter quotes for round-trip
  const quoteForward = await getJupiterQuote(flashMint, swapToken, Number(flashLoanAmount), 100);
  if (!quoteForward) {
    console.log('   ❌ No quote for forward swap');
    return null;
  }
  
  const amountMid = parseInt(quoteForward.outAmount);
  const quoteReturn = await getJupiterQuote(swapToken, flashMint, amountMid, 100);
  if (!quoteReturn) {
    console.log('   ❌ No quote for return swap');
    return null;
  }
  
  const amountOut = BigInt(quoteReturn.outAmount);
  const flashLoanFee = flashLoanAmount * 9n / 10000n; // 0.09%
  const repayAmount = flashLoanAmount + flashLoanFee;
  
  if (amountOut <= repayAmount) {
    const loss = Number(repayAmount - amountOut);
    console.log(`   ❌ Not profitable: would lose ${loss}`);
    return null;
  }
  
  const profit = Number(amountOut - repayAmount);
  const profitPercent = (profit / Number(flashLoanAmount)) * 100;
  console.log(`   💰 Expected profit: ${profit} (${profitPercent.toFixed(4)}%)`);
  
  // 2. Get swap instructions
  const swapIx1 = await getJupiterSwapInstructions(quoteForward, keypair.publicKey);
  const swapIx2 = await getJupiterSwapInstructions(quoteReturn, keypair.publicKey);
  
  if (!swapIx1 || !swapIx2) {
    console.log('   ❌ Failed to get swap instructions');
    return null;
  }
  
  // 3. Get lookup tables
  const altAddresses = [...new Set([
    ...swapIx1.addressLookupTableAddresses,
    ...swapIx2.addressLookupTableAddresses,
  ])];
  const lookupTables = await getAddressLookupTableAccounts(connection, altAddresses);
  
  // 4. Ensure ATAs exist
  const { ata: flashAta, createIx: createFlashAtaIx } = await ensureAta(connection, keypair, flashMint);
  
  // 5. Build instruction list
  const instructions: TransactionInstruction[] = [];
  
  // Compute budget
  instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }));
  instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }));
  
  // Jito tip
  instructions.push(SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: JITO_TIP_ACCOUNT,
    lamports: 5000,
  }));
  
  // Create ATA if needed
  if (createFlashAtaIx) instructions.push(createFlashAtaIx);
  
  // FLASH BORROW (index will be after compute + tip + ata creation)
  const flashBorrowIndex = instructions.length;
  instructions.push(buildFlashBorrowIx(flashReserve, flashMint, flashAta, flashLoanAmount));
  
  // Swap 1: Flash token -> Swap token
  for (const ix of swapIx1.setupInstructions) {
    instructions.push(deserializeInstruction(ix));
  }
  instructions.push(deserializeInstruction(swapIx1.swapInstruction));
  if (swapIx1.cleanupInstruction) {
    instructions.push(deserializeInstruction(swapIx1.cleanupInstruction));
  }
  
  // Swap 2: Swap token -> Flash token
  for (const ix of swapIx2.setupInstructions) {
    instructions.push(deserializeInstruction(ix));
  }
  instructions.push(deserializeInstruction(swapIx2.swapInstruction));
  if (swapIx2.cleanupInstruction) {
    instructions.push(deserializeInstruction(swapIx2.cleanupInstruction));
  }
  
  // FLASH REPAY
  instructions.push(buildFlashRepayIx(
    flashReserve,
    flashAta,
    keypair.publicKey,
    repayAmount,
    flashBorrowIndex
  ));
  
  // 6. Build transaction
  const blockhash = await connection.getLatestBlockhash('finalized');
  const messageV0 = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([keypair]);
  
  // 7. Simulate
  console.log('   Simulating...');
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    console.log('   ❌ Simulation failed:', JSON.stringify(simulation.value.err));
    if (simulation.value.logs) {
      const errorLogs = simulation.value.logs.filter(l => l.includes('Error') || l.includes('failed'));
      errorLogs.forEach(l => console.log('      ', l));
    }
    return null;
  }
  console.log('   ✅ Simulation OK');
  
  // 8. Send
  console.log('   Sending transaction...');
  const signature = await connection.sendTransaction(transaction, {
    maxRetries: 3,
    skipPreflight: true,
  });
  console.log(`   📤 Sent: ${signature}`);
  
  // 9. Confirm
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  }, 'confirmed');
  
  if (confirmation.value.err) {
    console.log('   ❌ Failed:', confirmation.value.err);
    return null;
  }
  
  console.log(`   ✅ SUCCESS! Profit: ~${profit}`);
  return signature;
}

// ============== MAIN ==============
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   ⚡ FLASH LOAN ARBITRAGE BOT - KAMINO + JUPITER          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  
  const keypair = loadKeypair();
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);
  
  // Flash loan amounts to try (USDC has 6 decimals)
  const usdcAmounts = [
    100_000_000n,      // 100 USDC
    1_000_000_000n,    // 1,000 USDC
    10_000_000_000n,   // 10,000 USDC
    100_000_000_000n,  // 100,000 USDC
  ];
  
  // Tokens to arb against
  const arbTokens = [
    TOKENS.SOL,
    TOKENS.USDT,
    TOKENS.JitoSOL,
  ];
  
  console.log('🔍 Scanning for flash loan arbitrage opportunities...\n');
  
  while (true) {
    for (const amount of usdcAmounts) {
      for (const token of arbTokens) {
        try {
          const result = await executeFlashLoanArbitrage(
            connection,
            keypair,
            'USDC',
            token,
            amount
          );
          
          if (result) {
            console.log(`\n🎉 ARBITRAGE EXECUTED! Signature: ${result}\n`);
          }
        } catch (e: any) {
          // Silently continue on errors
        }
        
        // Small delay
        await new Promise(r => setTimeout(r, 200));
      }
    }
    
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 3000));
  }
}

main().catch(console.error);
