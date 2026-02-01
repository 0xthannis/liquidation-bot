/**
 * Direct AMM Swap Instructions
 * Bypasses Jupiter for lower fees and better execution
 * Supports: Raydium, Orca Whirlpool, PumpSwap
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  AccountMeta,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import BN from 'bn.js';

// ============== POOL ADDRESSES ==============
// SOL/USDC pools on each DEX
export const POOLS = {
  // Raydium AMM V4 SOL/USDC
  raydium: {
    programId: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
    poolId: new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'),
    authority: new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'),
    openOrders: new PublicKey('HRk9CMrpq7Jn9sh7mzxE8CChHG8dneX9p475QKz4Fsfc'),
    targetOrders: new PublicKey('CZza3Ej4Mc58MnxWA385itCC9jCo3L1D7zc3LKBqgUFf'),
    coinVault: new PublicKey('DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz'), // SOL
    pcVault: new PublicKey('HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz'), // USDC
    serumProgram: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
    serumMarket: new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'),
    serumBids: new PublicKey('5jWUncPNBMZJ3sTHKmMLszypVkoRK6bfEQMQUHweeQnh'),
    serumAsks: new PublicKey('EaXdHx7x3mdGA38j5RSmKYSXMzAFzzUXCLNBEDXDn1d5'),
    serumEventQueue: new PublicKey('8CvwxZ9Db6XbLD46NZwwmVDZZRDy7eydFcAGkXKh9axa'),
    serumCoinVault: new PublicKey('CKxTHwM9fPMRRvZmFnFoqKNd9pQR21c5Aq9bh5h9oghX'),
    serumPcVault: new PublicKey('6A5NHCj1yF6urc9wZNe6Bcjj4LVszQNj5DwAWG97yzMu'),
    serumVaultSigner: new PublicKey('CTz5UMLQm2SRWHzQnU62Pi4yJqbNGjgRBHqqp6oDHfF7'),
  },
  // Orca Whirlpool SOL/USDC (64 tick spacing)
  orca: {
    programId: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
    poolId: new PublicKey('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ'),
    tokenVaultA: new PublicKey('9RfZwn2Prux6QesG1Noo4HzMEBv3rPndJ2bN2Wwd6a7p'), // SOL
    tokenVaultB: new PublicKey('BVNo8ftg2LkkssnWT4ZWdtoFaevnfD6ExYeramwM27pe'), // USDC
    tickArray0: new PublicKey('2B48L1ACPvVb67UKeSMkUGdzrnhvNMm6pFt2nspGKxs4'),
    tickArray1: new PublicKey('9opqNK3dWUijw8VNLtvne8A9sRXYwDFhHL4C4j7oHBe7'),
    tickArray2: new PublicKey('7jtgQfyCHXkj94AMeRPqkVNt9AGdDgiJZmNmkwcU36iN'),
    oracle: new PublicKey('4GkRbcYg1VKsZropgai4dMf2Nj2PkXNLf43knFpavrSi'),
  },
  // PumpSwap AMM
  pumpswap: {
    programId: new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'),
    // PumpSwap uses dynamic pool discovery - we'll fetch at runtime
  },
};

// Token mints
export const TOKENS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
};

// ============== RAYDIUM SWAP ==============
export async function createRaydiumSwapInstruction(
  connection: Connection,
  userPubkey: PublicKey,
  amountIn: bigint,
  minimumAmountOut: bigint,
  swapDirection: 'SOL_TO_USDC' | 'USDC_TO_SOL'
): Promise<TransactionInstruction[]> {
  const pool = POOLS.raydium;
  const instructions: TransactionInstruction[] = [];

  // Get user token accounts
  const userSolAta = await getAssociatedTokenAddress(TOKENS.SOL, userPubkey);
  const userUsdcAta = await getAssociatedTokenAddress(TOKENS.USDC, userPubkey);

  // Check if ATAs exist, create if needed
  const solAccount = await connection.getAccountInfo(userSolAta);
  if (!solAccount) {
    instructions.push(
      createAssociatedTokenAccountInstruction(userPubkey, userSolAta, userPubkey, TOKENS.SOL)
    );
  }
  const usdcAccount = await connection.getAccountInfo(userUsdcAta);
  if (!usdcAccount) {
    instructions.push(
      createAssociatedTokenAccountInstruction(userPubkey, userUsdcAta, userPubkey, TOKENS.USDC)
    );
  }

  // Raydium swap instruction data
  // Instruction 9 = swap
  const dataLayout = Buffer.alloc(17);
  dataLayout.writeUInt8(9, 0); // instruction index
  new BN(amountIn.toString()).toArrayLike(Buffer, 'le', 8).copy(dataLayout, 1);
  new BN(minimumAmountOut.toString()).toArrayLike(Buffer, 'le', 8).copy(dataLayout, 9);

  const [userSource, userDest] = swapDirection === 'SOL_TO_USDC' 
    ? [userSolAta, userUsdcAta]
    : [userUsdcAta, userSolAta];

  const keys: AccountMeta[] = [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: pool.poolId, isSigner: false, isWritable: true },
    { pubkey: pool.authority, isSigner: false, isWritable: false },
    { pubkey: pool.openOrders, isSigner: false, isWritable: true },
    { pubkey: pool.targetOrders, isSigner: false, isWritable: true },
    { pubkey: pool.coinVault, isSigner: false, isWritable: true },
    { pubkey: pool.pcVault, isSigner: false, isWritable: true },
    { pubkey: pool.serumProgram, isSigner: false, isWritable: false },
    { pubkey: pool.serumMarket, isSigner: false, isWritable: true },
    { pubkey: pool.serumBids, isSigner: false, isWritable: true },
    { pubkey: pool.serumAsks, isSigner: false, isWritable: true },
    { pubkey: pool.serumEventQueue, isSigner: false, isWritable: true },
    { pubkey: pool.serumCoinVault, isSigner: false, isWritable: true },
    { pubkey: pool.serumPcVault, isSigner: false, isWritable: true },
    { pubkey: pool.serumVaultSigner, isSigner: false, isWritable: false },
    { pubkey: userSource, isSigner: false, isWritable: true },
    { pubkey: userDest, isSigner: false, isWritable: true },
    { pubkey: userPubkey, isSigner: true, isWritable: false },
  ];

  instructions.push(
    new TransactionInstruction({
      programId: pool.programId,
      keys,
      data: dataLayout,
    })
  );

  return instructions;
}

// ============== ORCA WHIRLPOOL SWAP ==============
export async function createOrcaSwapInstruction(
  connection: Connection,
  userPubkey: PublicKey,
  amountIn: bigint,
  minimumAmountOut: bigint,
  swapDirection: 'SOL_TO_USDC' | 'USDC_TO_SOL'
): Promise<TransactionInstruction[]> {
  const pool = POOLS.orca;
  const instructions: TransactionInstruction[] = [];

  // Get user token accounts
  const userSolAta = await getAssociatedTokenAddress(TOKENS.SOL, userPubkey);
  const userUsdcAta = await getAssociatedTokenAddress(TOKENS.USDC, userPubkey);

  // Check if ATAs exist
  const solAccount = await connection.getAccountInfo(userSolAta);
  if (!solAccount) {
    instructions.push(
      createAssociatedTokenAccountInstruction(userPubkey, userSolAta, userPubkey, TOKENS.SOL)
    );
  }
  const usdcAccount = await connection.getAccountInfo(userUsdcAta);
  if (!usdcAccount) {
    instructions.push(
      createAssociatedTokenAccountInstruction(userPubkey, userUsdcAta, userPubkey, TOKENS.USDC)
    );
  }

  // Whirlpool swap instruction
  // a_to_b: true if swapping token A (SOL) to token B (USDC)
  const aToB = swapDirection === 'SOL_TO_USDC';
  
  // Instruction discriminator for "swap" = [248, 198, 158, 145, 225, 117, 135, 200]
  const discriminator = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
  
  const dataLayout = Buffer.alloc(8 + 8 + 8 + 1 + 16);
  discriminator.copy(dataLayout, 0);
  new BN(amountIn.toString()).toArrayLike(Buffer, 'le', 8).copy(dataLayout, 8);
  new BN(minimumAmountOut.toString()).toArrayLike(Buffer, 'le', 8).copy(dataLayout, 16);
  dataLayout.writeUInt8(aToB ? 1 : 0, 24);
  // sqrt_price_limit (0 = no limit)
  Buffer.alloc(16).copy(dataLayout, 25);

  const [tokenOwnerAccountA, tokenOwnerAccountB, tokenVaultA, tokenVaultB] = aToB
    ? [userSolAta, userUsdcAta, pool.tokenVaultA, pool.tokenVaultB]
    : [userUsdcAta, userSolAta, pool.tokenVaultB, pool.tokenVaultA];

  const keys: AccountMeta[] = [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: userPubkey, isSigner: true, isWritable: false },
    { pubkey: pool.poolId, isSigner: false, isWritable: true },
    { pubkey: tokenOwnerAccountA, isSigner: false, isWritable: true },
    { pubkey: tokenVaultA, isSigner: false, isWritable: true },
    { pubkey: tokenOwnerAccountB, isSigner: false, isWritable: true },
    { pubkey: tokenVaultB, isSigner: false, isWritable: true },
    { pubkey: pool.tickArray0, isSigner: false, isWritable: true },
    { pubkey: pool.tickArray1, isSigner: false, isWritable: true },
    { pubkey: pool.tickArray2, isSigner: false, isWritable: true },
    { pubkey: pool.oracle, isSigner: false, isWritable: true },
  ];

  instructions.push(
    new TransactionInstruction({
      programId: pool.programId,
      keys,
      data: dataLayout,
    })
  );

  return instructions;
}

// ============== GET POOL PRICE ==============
export async function getPoolPrice(
  connection: Connection,
  dex: 'raydium' | 'orca' | 'pumpswap'
): Promise<number | null> {
  try {
    if (dex === 'raydium') {
      // Fetch Raydium pool reserves
      const pool = POOLS.raydium;
      const [coinVaultInfo, pcVaultInfo] = await Promise.all([
        connection.getTokenAccountBalance(pool.coinVault),
        connection.getTokenAccountBalance(pool.pcVault),
      ]);
      
      const solReserve = Number(coinVaultInfo.value.amount) / 1e9;
      const usdcReserve = Number(pcVaultInfo.value.amount) / 1e6;
      
      return usdcReserve / solReserve; // Price of SOL in USDC
    }
    
    if (dex === 'orca') {
      // Fetch Orca Whirlpool reserves
      const pool = POOLS.orca;
      const [vaultAInfo, vaultBInfo] = await Promise.all([
        connection.getTokenAccountBalance(pool.tokenVaultA),
        connection.getTokenAccountBalance(pool.tokenVaultB),
      ]);
      
      const solReserve = Number(vaultAInfo.value.amount) / 1e9;
      const usdcReserve = Number(vaultBInfo.value.amount) / 1e6;
      
      return usdcReserve / solReserve;
    }
    
    // PumpSwap - use Jupiter for price discovery for now
    return null;
  } catch (error) {
    console.error(`Error getting ${dex} price:`, error);
    return null;
  }
}

// ============== CALCULATE OUTPUT AMOUNT ==============
export function calculateSwapOutput(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeNumerator: bigint = 25n, // 0.25% default Raydium fee
  feeDenominator: bigint = 10000n
): bigint {
  // AMM constant product formula: x * y = k
  // output = (reserveOut * amountIn * (1 - fee)) / (reserveIn + amountIn * (1 - fee))
  const amountInWithFee = amountIn * (feeDenominator - feeNumerator);
  const numerator = reserveOut * amountInWithFee;
  const denominator = reserveIn * feeDenominator + amountInWithFee;
  return numerator / denominator;
}

// ============== CREATE DIRECT SWAP ==============
export async function createDirectSwapInstructions(
  connection: Connection,
  userPubkey: PublicKey,
  dex: 'raydium' | 'orca',
  amountIn: bigint,
  swapDirection: 'SOL_TO_USDC' | 'USDC_TO_SOL',
  slippageBps: number = 50 // 0.5% default slippage
): Promise<{ instructions: TransactionInstruction[]; expectedOutput: bigint } | null> {
  try {
    // Get pool reserves for output calculation
    const pool = dex === 'raydium' ? POOLS.raydium : POOLS.orca;
    
    let reserveIn: bigint, reserveOut: bigint;
    
    if (dex === 'raydium') {
      const [coinVault, pcVault] = await Promise.all([
        connection.getTokenAccountBalance(pool.coinVault as PublicKey),
        connection.getTokenAccountBalance(pool.pcVault as PublicKey),
      ]);
      
      if (swapDirection === 'SOL_TO_USDC') {
        reserveIn = BigInt(coinVault.value.amount);
        reserveOut = BigInt(pcVault.value.amount);
      } else {
        reserveIn = BigInt(pcVault.value.amount);
        reserveOut = BigInt(coinVault.value.amount);
      }
    } else {
      const [vaultA, vaultB] = await Promise.all([
        connection.getTokenAccountBalance((pool as any).tokenVaultA),
        connection.getTokenAccountBalance((pool as any).tokenVaultB),
      ]);
      
      if (swapDirection === 'SOL_TO_USDC') {
        reserveIn = BigInt(vaultA.value.amount);
        reserveOut = BigInt(vaultB.value.amount);
      } else {
        reserveIn = BigInt(vaultB.value.amount);
        reserveOut = BigInt(vaultA.value.amount);
      }
    }

    // Calculate expected output
    const feeNumerator = dex === 'raydium' ? 25n : 30n; // Raydium 0.25%, Orca 0.3%
    const expectedOutput = calculateSwapOutput(amountIn, reserveIn, reserveOut, feeNumerator);
    
    // Apply slippage
    const minOutput = expectedOutput * BigInt(10000 - slippageBps) / 10000n;

    // Create swap instructions
    const instructions = dex === 'raydium'
      ? await createRaydiumSwapInstruction(connection, userPubkey, amountIn, minOutput, swapDirection)
      : await createOrcaSwapInstruction(connection, userPubkey, amountIn, minOutput, swapDirection);

    return { instructions, expectedOutput };
  } catch (error) {
    console.error(`Error creating ${dex} swap:`, error);
    return null;
  }
}

console.log('✅ AMM Direct Swap module loaded');
console.log('   Supported DEXes: Raydium, Orca Whirlpool');
console.log('   Fees: Raydium 0.25%, Orca 0.3%');
