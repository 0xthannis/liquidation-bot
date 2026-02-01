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
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import BN from 'bn.js';

// Helper: compute ATA address
function getATA(mint: PublicKey, owner: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

// Helper: create ATA instruction
function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

// ============== POOL ADDRESSES ==============
// SOL/USDC pools on each DEX
export const POOLS = {
  // Raydium AMM V4 SOL/USDC (using SwapBaseInV2 - no OpenBook needed)
  raydium: {
    programId: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
    poolId: new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'),
    authority: new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'),
    coinVault: new PublicKey('DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz'), // SOL
    pcVault: new PublicKey('HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz'), // USDC
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
  // PumpSwap AMM - SOL/USDC pool (if exists)
  pumpswap: {
    programId: new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'),
    // PumpSwap pools are discovered dynamically per token
    // Global fee config
    feeConfig: new PublicKey('FeeVaVkgFbFAqPcRPxzbuJKjjyZmKvnqjSPNgCxC2Pn'),
    feeProgram: new PublicKey('FeeRV5cDLKH5WFrrKJ7WDYXmGNnJrEyy1LYLC3aHQdu'),
  },
};

// WSOL mint for PumpSwap
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

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
  const userSolAta = await getATA(TOKENS.SOL, userPubkey);
  const userUsdcAta = await getATA(TOKENS.USDC, userPubkey);

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
  // Instruction 16 = SwapBaseInV2 (without OpenBook orderbook - simpler & faster)
  // Data layout: instruction(1) + amount_in(8) + minimum_amount_out(8) = 17 bytes
  const dataLayout = Buffer.alloc(17);
  dataLayout.writeUInt8(16, 0); // instruction index for SwapBaseInV2
  new BN(amountIn.toString()).toArrayLike(Buffer, 'le', 8).copy(dataLayout, 1);
  new BN(minimumAmountOut.toString()).toArrayLike(Buffer, 'le', 8).copy(dataLayout, 9);

  const [userSource, userDest] = swapDirection === 'SOL_TO_USDC' 
    ? [userSolAta, userUsdcAta]
    : [userUsdcAta, userSolAta];

  // SwapBaseInV2 accounts (simplified - no OpenBook):
  // 0. Token program
  // 1. AMM Account (writable)
  // 2. AMM Authority
  // 3. AMM coin vault (writable)
  // 4. AMM pc vault (writable)
  // 5. User source token (writable)
  // 6. User destination token (writable)
  // 7. User wallet (signer)
  const keys: AccountMeta[] = [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: pool.poolId, isSigner: false, isWritable: true },
    { pubkey: pool.authority, isSigner: false, isWritable: false },
    { pubkey: pool.coinVault, isSigner: false, isWritable: true },
    { pubkey: pool.pcVault, isSigner: false, isWritable: true },
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
  const userSolAta = await getATA(TOKENS.SOL, userPubkey);
  const userUsdcAta = await getATA(TOKENS.USDC, userPubkey);

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
  
  // Data layout (from Whirlpool IDL):
  // - discriminator: 8 bytes
  // - amount: u64 (8 bytes)
  // - other_amount_threshold: u64 (8 bytes) 
  // - sqrt_price_limit: u128 (16 bytes)
  // - amount_specified_is_input: bool (1 byte)
  // - a_to_b: bool (1 byte)
  // Total: 42 bytes
  const dataLayout = Buffer.alloc(8 + 8 + 8 + 16 + 1 + 1);
  discriminator.copy(dataLayout, 0);
  new BN(amountIn.toString()).toArrayLike(Buffer, 'le', 8).copy(dataLayout, 8);
  new BN(minimumAmountOut.toString()).toArrayLike(Buffer, 'le', 8).copy(dataLayout, 16);
  // sqrt_price_limit: u128 (0 = no limit) - for a_to_b use MIN, for b_to_a use MAX
  const sqrtPriceLimit = aToB 
    ? new BN('4295048016') // MIN_SQRT_PRICE
    : new BN('79226673515401279992447579055'); // MAX_SQRT_PRICE
  sqrtPriceLimit.toArrayLike(Buffer, 'le', 16).copy(dataLayout, 24);
  dataLayout.writeUInt8(1, 40); // amount_specified_is_input = true (we specify input amount)
  dataLayout.writeUInt8(aToB ? 1 : 0, 41); // a_to_b

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
      // Orca Whirlpool uses sqrtPrice, not simple reserves
      // sqrtPrice is stored at offset 65 in the Whirlpool account data (u128)
      const pool = POOLS.orca;
      const whirlpoolAccount = await connection.getAccountInfo(pool.poolId);
      
      if (!whirlpoolAccount) return null;
      
      // Read sqrtPrice from offset 65 (u128 = 16 bytes)
      const sqrtPriceX64 = whirlpoolAccount.data.readBigUInt64LE(65);
      const sqrtPriceX64High = whirlpoolAccount.data.readBigUInt64LE(73);
      
      // Combine to get full u128 sqrtPrice
      const sqrtPrice = Number(sqrtPriceX64) + Number(sqrtPriceX64High) * 2**64;
      
      // Price = (sqrtPrice / 2^64)^2 * 10^(decimalsB - decimalsA)
      // For SOL/USDC: decimalsB=6, decimalsA=9, so multiply by 10^-3
      const price = Math.pow(sqrtPrice / 2**64, 2) * 1e-3;
      
      return price;
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
    let reserveIn: bigint, reserveOut: bigint;
    
    if (dex === 'raydium') {
      const raydiumPool = POOLS.raydium;
      const [coinVault, pcVault] = await Promise.all([
        connection.getTokenAccountBalance(raydiumPool.coinVault),
        connection.getTokenAccountBalance(raydiumPool.pcVault),
      ]);
      
      if (swapDirection === 'SOL_TO_USDC') {
        reserveIn = BigInt(coinVault.value.amount);
        reserveOut = BigInt(pcVault.value.amount);
      } else {
        reserveIn = BigInt(pcVault.value.amount);
        reserveOut = BigInt(coinVault.value.amount);
      }
    } else {
      const orcaPool = POOLS.orca;
      const [vaultA, vaultB] = await Promise.all([
        connection.getTokenAccountBalance(orcaPool.tokenVaultA),
        connection.getTokenAccountBalance(orcaPool.tokenVaultB),
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

// ============== PUMPSWAP DIRECT SWAP ==============
// PumpSwap instruction discriminators (from IDL)
const PUMPSWAP_BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]); // buy
const PUMPSWAP_SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]); // sell

/**
 * Find PumpSwap pool address for a token
 */
export async function findPumpSwapPool(
  tokenMint: PublicKey
): Promise<PublicKey> {
  const [poolAddress] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('pool'),
      tokenMint.toBuffer(),
      WSOL_MINT.toBuffer(),
    ],
    POOLS.pumpswap.programId
  );
  return poolAddress;
}

/**
 * Get PumpSwap pool reserves
 */
export async function getPumpSwapReserves(
  connection: Connection,
  poolAddress: PublicKey
): Promise<{ solReserve: bigint; tokenReserve: bigint } | null> {
  try {
    const poolAccount = await connection.getAccountInfo(poolAddress);
    if (!poolAccount || poolAccount.data.length < 200) return null;

    // Parse pool data - offsets based on PumpSwap IDL
    // Pool structure: discriminator(8) + pool_bump(1) + index(2) + creator(32) + base_mint(32) + quote_mint(32) + lp_mint(32) + pool_base_token_account(32) + pool_quote_token_account(32) + ...
    const data = poolAccount.data;
    
    // Get token accounts from pool data
    const poolBaseTokenAccount = new PublicKey(data.slice(107, 139));
    const poolQuoteTokenAccount = new PublicKey(data.slice(139, 171));

    const [baseBalance, quoteBalance] = await Promise.all([
      connection.getTokenAccountBalance(poolBaseTokenAccount),
      connection.getTokenAccountBalance(poolQuoteTokenAccount),
    ]);

    return {
      tokenReserve: BigInt(baseBalance.value.amount),
      solReserve: BigInt(quoteBalance.value.amount),
    };
  } catch (error) {
    console.error('Error getting PumpSwap reserves:', error);
    return null;
  }
}

/**
 * Create PumpSwap buy instruction (SOL -> Token)
 */
export async function createPumpSwapBuyInstruction(
  connection: Connection,
  userPubkey: PublicKey,
  tokenMint: PublicKey,
  solAmountIn: bigint,
  minTokensOut: bigint
): Promise<TransactionInstruction[]> {
  const instructions: TransactionInstruction[] = [];
  const poolAddress = await findPumpSwapPool(tokenMint);

  // Get pool account to extract token accounts
  const poolAccount = await connection.getAccountInfo(poolAddress);
  if (!poolAccount) throw new Error('Pool not found');

  const data = poolAccount.data;
  const poolBaseTokenAccount = new PublicKey(data.slice(107, 139));
  const poolQuoteTokenAccount = new PublicKey(data.slice(139, 171));

  // User token accounts
  const userTokenAta = await getATA(tokenMint, userPubkey);
  const userWsolAta = await getATA(WSOL_MINT, userPubkey);

  // Check if ATAs exist
  const tokenAccount = await connection.getAccountInfo(userTokenAta);
  if (!tokenAccount) {
    instructions.push(
      createAssociatedTokenAccountInstruction(userPubkey, userTokenAta, userPubkey, tokenMint)
    );
  }

  // Build buy instruction data
  // buy(base_amount_out: u64, max_quote_amount_in: u64)
  const buyData = Buffer.alloc(8 + 8 + 8);
  PUMPSWAP_BUY_DISCRIMINATOR.copy(buyData, 0);
  buyData.writeBigUInt64LE(minTokensOut, 8);  // base_amount_out (tokens)
  buyData.writeBigUInt64LE(solAmountIn, 16);   // max_quote_amount_in (SOL)

  const keys: AccountMeta[] = [
    { pubkey: poolAddress, isSigner: false, isWritable: true },
    { pubkey: userPubkey, isSigner: true, isWritable: true },
    { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true },  // pool token vault
    { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true }, // pool SOL vault
    { pubkey: userTokenAta, isSigner: false, isWritable: true },          // user token account
    { pubkey: userWsolAta, isSigner: false, isWritable: true },           // user WSOL account
    { pubkey: tokenMint, isSigner: false, isWritable: false },            // token mint
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },            // WSOL mint
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },     // token program 2022 fallback
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: POOLS.pumpswap.feeConfig, isSigner: false, isWritable: false },
    { pubkey: POOLS.pumpswap.feeProgram, isSigner: false, isWritable: false },
  ];

  instructions.push(
    new TransactionInstruction({
      programId: POOLS.pumpswap.programId,
      keys,
      data: buyData,
    })
  );

  return instructions;
}

/**
 * Create PumpSwap sell instruction (Token -> SOL)
 */
export async function createPumpSwapSellInstruction(
  connection: Connection,
  userPubkey: PublicKey,
  tokenMint: PublicKey,
  tokenAmountIn: bigint,
  minSolOut: bigint
): Promise<TransactionInstruction[]> {
  const instructions: TransactionInstruction[] = [];
  const poolAddress = await findPumpSwapPool(tokenMint);

  // Get pool account
  const poolAccount = await connection.getAccountInfo(poolAddress);
  if (!poolAccount) throw new Error('Pool not found');

  const data = poolAccount.data;
  const poolBaseTokenAccount = new PublicKey(data.slice(107, 139));
  const poolQuoteTokenAccount = new PublicKey(data.slice(139, 171));

  // User token accounts
  const userTokenAta = await getATA(tokenMint, userPubkey);
  const userWsolAta = await getATA(WSOL_MINT, userPubkey);

  // Build sell instruction data
  // sell(base_amount_in: u64, min_quote_amount_out: u64)
  const sellData = Buffer.alloc(8 + 8 + 8);
  PUMPSWAP_SELL_DISCRIMINATOR.copy(sellData, 0);
  sellData.writeBigUInt64LE(tokenAmountIn, 8);  // base_amount_in (tokens)
  sellData.writeBigUInt64LE(minSolOut, 16);      // min_quote_amount_out (SOL)

  const keys: AccountMeta[] = [
    { pubkey: poolAddress, isSigner: false, isWritable: true },
    { pubkey: userPubkey, isSigner: true, isWritable: true },
    { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenAta, isSigner: false, isWritable: true },
    { pubkey: userWsolAta, isSigner: false, isWritable: true },
    { pubkey: tokenMint, isSigner: false, isWritable: false },
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: POOLS.pumpswap.feeConfig, isSigner: false, isWritable: false },
    { pubkey: POOLS.pumpswap.feeProgram, isSigner: false, isWritable: false },
  ];

  instructions.push(
    new TransactionInstruction({
      programId: POOLS.pumpswap.programId,
      keys,
      data: sellData,
    })
  );

  return instructions;
}

/**
 * Create direct PumpSwap swap
 */
export async function createPumpSwapDirectSwap(
  connection: Connection,
  userPubkey: PublicKey,
  tokenMint: PublicKey,
  amountIn: bigint,
  direction: 'BUY' | 'SELL', // BUY = SOL->Token, SELL = Token->SOL
  slippageBps: number = 300 // 3% default for memecoins
): Promise<{ instructions: TransactionInstruction[]; expectedOutput: bigint } | null> {
  try {
    const poolAddress = await findPumpSwapPool(tokenMint);
    const reserves = await getPumpSwapReserves(connection, poolAddress);
    
    if (!reserves) {
      console.log('   PumpSwap pool not found or empty');
      return null;
    }

    const { solReserve, tokenReserve } = reserves;
    
    // Calculate output using constant product formula
    // PumpSwap fee is 1% (100 bps)
    const feeNumerator = 100n;
    const feeDenominator = 10000n;
    
    let expectedOutput: bigint;
    let minOutput: bigint;
    let instructions: TransactionInstruction[];

    if (direction === 'BUY') {
      // SOL -> Token
      expectedOutput = calculateSwapOutput(amountIn, solReserve, tokenReserve, feeNumerator, feeDenominator);
      minOutput = expectedOutput * BigInt(10000 - slippageBps) / 10000n;
      instructions = await createPumpSwapBuyInstruction(connection, userPubkey, tokenMint, amountIn, minOutput);
    } else {
      // Token -> SOL
      expectedOutput = calculateSwapOutput(amountIn, tokenReserve, solReserve, feeNumerator, feeDenominator);
      minOutput = expectedOutput * BigInt(10000 - slippageBps) / 10000n;
      instructions = await createPumpSwapSellInstruction(connection, userPubkey, tokenMint, amountIn, minOutput);
    }

    console.log(`   PumpSwap ${direction}: ${amountIn} -> ${expectedOutput} (min: ${minOutput})`);
    
    return { instructions, expectedOutput };
  } catch (error) {
    console.error('Error creating PumpSwap swap:', error);
    return null;
  }
}

console.log('✅ AMM Direct Swap module loaded');
console.log('   Supported DEXes: Raydium, Orca Whirlpool, PumpSwap');
console.log('   Fees: Raydium 0.25%, Orca 0.3%, PumpSwap 1%');
