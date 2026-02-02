/**
 * Kamino Flash Loan Integration
 * Uses official @kamino-finance/klend-sdk
 * Documentation: https://kamino.com/build/borrow/operations/advanced-concepts/flash-loans
 */

import { 
  Connection, 
  PublicKey, 
  Keypair, 
  Transaction, 
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import { 
  KaminoMarket, 
  PROGRAM_ID as KAMINO_PROGRAM_ID,
  getFlashLoanInstructions,
} from '@kamino-finance/klend-sdk';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import Decimal from 'decimal.js';

// Helper to derive ATA (compatible with all spl-token versions)
function getATA(mint: PublicKey, owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

// Kamino Main Market address
const KAMINO_MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

// Token mint addresses
const TOKEN_MINTS: Record<string, PublicKey> = {
  'SOL': new PublicKey('So11111111111111111111111111111111111111112'),
  'USDC': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  'JUP': new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
  'JTO': new PublicKey('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'),
  'BONK': new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
  'WIF': new PublicKey('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'),
};

export interface FlashLoanParams {
  tokenSymbol: string;
  amountLamports: bigint;
  borrowerKeypair: Keypair;
  customInstructions: TransactionInstruction[];
}

export interface FlashLoanResult {
  success: boolean;
  signature?: string;
  error?: string;
  flashFee?: number;
}

/**
 * Kamino Flash Loan Client
 * Provides flash loan functionality using Kamino Lending protocol
 */
export class KaminoFlashLoanClient {
  private connection: Connection;
  private market: KaminoMarket | null = null;
  private initialized = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Initialize the Kamino market
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      console.log('[Kamino] Loading market...');
      this.market = await KaminoMarket.load(
        this.connection,
        KAMINO_MAIN_MARKET,
        400 // Recent slot duration
      );
      
      if (!this.market) {
        throw new Error('Failed to load Kamino market');
      }

      // Load reserves
      await this.market.loadReserves();
      
      this.initialized = true;
      console.log('[Kamino] Market initialized with', this.market.reserves.size, 'reserves');
    } catch (e) {
      console.error('[Kamino] Failed to initialize:', e);
      throw e;
    }
  }

  /**
   * Get the flash loan fee for a token (0.001% = 0.00001)
   */
  getFlashLoanFee(): number {
    return 0.00001; // 0.001% fee
  }

  /**
   * Calculate the flash loan fee in lamports
   */
  calculateFee(amountLamports: bigint): bigint {
    return amountLamports / 100000n; // 0.001%
  }

  /**
   * Build flash loan instructions
   * Returns the borrow and repay instructions to wrap around custom logic
   */
  async buildFlashLoanInstructions(
    tokenSymbol: string,
    amountLamports: bigint,
    borrowerKeypair: Keypair
  ): Promise<{
    flashBorrowIx: TransactionInstruction;
    flashRepayIx: TransactionInstruction;
    destinationAta: PublicKey;
  } | null> {
    if (!this.market) {
      await this.initialize();
    }

    const tokenMint = TOKEN_MINTS[tokenSymbol];
    if (!tokenMint) {
      console.error(`[Kamino] Unknown token: ${tokenSymbol}`);
      return null;
    }

    try {
      // Get reserve for the token
      const reserve = this.market!.getReserveByMint(tokenMint);
      if (!reserve) {
        console.error(`[Kamino] No reserve found for ${tokenSymbol}`);
        return null;
      }

      // Get borrower's ATA for this token
      const destinationAta = getATA(tokenMint, borrowerKeypair.publicKey);

      // Get lending market authority
      const lendingMarketAuthority = await this.market!.getLendingMarketAuthority();

      // Build flash loan instructions using SDK
      const { flashBorrowIxn, flashRepayIxn } = getFlashLoanInstructions({
        borrowIxnIndex: 0, // Flash borrow will be first instruction
        walletPublicKey: borrowerKeypair.publicKey,
        lendingMarketAuthority,
        lendingMarketAddress: KAMINO_MAIN_MARKET,
        reserve,
        amountLamports: new Decimal(amountLamports.toString()),
        destinationAta,
        referrerAccount: PublicKey.default,
        referrerTokenState: PublicKey.default,
        programId: KAMINO_PROGRAM_ID,
      });

      return {
        flashBorrowIx: flashBorrowIxn,
        flashRepayIx: flashRepayIxn,
        destinationAta,
      };

    } catch (e) {
      console.error(`[Kamino] Error building flash loan instructions:`, e);
      return null;
    }
  }

  /**
   * Execute a flash loan with custom instructions in between
   * Flow: Flash Borrow → Custom Instructions → Flash Repay
   */
  async executeFlashLoan(params: FlashLoanParams): Promise<FlashLoanResult> {
    const { tokenSymbol, amountLamports, borrowerKeypair, customInstructions } = params;

    try {
      // Build flash loan instructions
      const flashLoanIxs = await this.buildFlashLoanInstructions(
        tokenSymbol,
        amountLamports,
        borrowerKeypair
      );

      if (!flashLoanIxs) {
        return { success: false, error: 'Failed to build flash loan instructions' };
      }

      const { flashBorrowIx, flashRepayIx } = flashLoanIxs;

      // Combine all instructions: borrow → custom → repay
      const allInstructions = [
        flashBorrowIx,
        ...customInstructions,
        flashRepayIx,
      ];

      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('finalized');

      // Build versioned transaction
      const messageV0 = new TransactionMessage({
        payerKey: borrowerKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions: allInstructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([borrowerKeypair]);

      // Send transaction
      const signature = await this.connection.sendTransaction(transaction, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      // Confirm transaction
      const confirmation = await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      }, 'confirmed');

      if (confirmation.value.err) {
        return { 
          success: false, 
          error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
          signature,
        };
      }

      const flashFee = Number(this.calculateFee(amountLamports));

      return {
        success: true,
        signature,
        flashFee,
      };

    } catch (e) {
      console.error('[Kamino] Flash loan execution error:', e);
      return { success: false, error: String(e) };
    }
  }

  /**
   * Get available liquidity for a token in the Kamino reserve
   */
  async getAvailableLiquidity(tokenSymbol: string): Promise<number> {
    if (!this.market) {
      await this.initialize();
    }

    const tokenMint = TOKEN_MINTS[tokenSymbol];
    if (!tokenMint) return 0;

    try {
      const reserve = this.market!.getReserveByMint(tokenMint);
      if (!reserve) return 0;

      // Get available liquidity from reserve stats
      const availableLiquidity = (reserve as any).stats?.availableLiquidity || (reserve as any).liquidity?.availableAmount || 0;
      return Number(availableLiquidity);
    } catch (e) {
      console.error(`[Kamino] Error getting liquidity for ${tokenSymbol}:`, e);
      return 0;
    }
  }
}
