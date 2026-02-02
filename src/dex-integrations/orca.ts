/**
 * Orca Whirlpools DEX Integration
 * Uses official @orca-so/whirlpools SDK
 * Documentation: https://dev.orca.so/ts/
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { 
  WhirlpoolContext, 
  buildWhirlpoolClient, 
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil,
  PoolUtil,
  PriceMath,
  swapQuoteByInputToken,
} from '@orca-so/whirlpools-sdk';
import { Wallet } from '@coral-xyz/anchor';
import Decimal from 'decimal.js';

// Token mint addresses
const TOKEN_MINTS: Record<string, PublicKey> = {
  'SOL': new PublicKey('So11111111111111111111111111111111111111112'),
  'USDC': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  'JUP': new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
  'JTO': new PublicKey('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'),
  'BONK': new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
  'WIF': new PublicKey('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'),
};

// Known Orca Whirlpool addresses for common pairs
// These are the most liquid whirlpools for each pair
const WHIRLPOOL_ADDRESSES: Record<string, string> = {
  'SOL/USDC': 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ',
  'JUP/USDC': '2QdhepnKRTLjjSqPL1PtKNwqrUkoLee5Gqs8bvZhRdMv',
  'JTO/USDC': '63mqKmR3LkrQReod89m8HHnFToNrLQRjukFSxCNqJQXK',
  'BONK/USDC': '2nAAsYdXF3eTQzaeUQS3fr4o782dDg8L28mX39Wr5j8N',
  'WIF/USDC': 'EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx',
};

export interface OrcaPriceQuote {
  pair: string;
  price: number;
  liquidity: number;
  sqrtPrice: string;
  tickCurrentIndex: number;
}

/**
 * Orca Whirlpools client for fetching pool prices
 */
export class OrcaClient {
  private connection: Connection;
  private ctx: WhirlpoolContext | null = null;
  private client: any = null;
  private initialized = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Initialize the Orca Whirlpools SDK
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create a read-only context (no wallet needed for price queries)
      this.ctx = WhirlpoolContext.withProvider(
        { connection: this.connection } as any,
        ORCA_WHIRLPOOL_PROGRAM_ID
      );
      this.client = buildWhirlpoolClient(this.ctx);
      this.initialized = true;
      console.log('[Orca] Whirlpools SDK initialized');
    } catch (e) {
      console.error('[Orca] Failed to initialize SDK:', e);
      throw e;
    }
  }

  /**
   * Get price for a trading pair from Orca Whirlpool
   * Returns price in quote tokens (USDC) per 1 base token
   */
  async getPrice(pair: string): Promise<OrcaPriceQuote | null> {
    if (!this.client) {
      await this.initialize();
    }

    const whirlpoolAddress = WHIRLPOOL_ADDRESSES[pair];
    if (!whirlpoolAddress) {
      console.error(`[Orca] No whirlpool found for pair: ${pair}`);
      return null;
    }

    try {
      // Fetch the whirlpool account
      const whirlpool = await this.client.getPool(new PublicKey(whirlpoolAddress));
      const whirlpoolData = whirlpool.getData();

      // Get token info
      const tokenA = whirlpool.getTokenAInfo();
      const tokenB = whirlpool.getTokenBInfo();

      // Calculate price from sqrtPrice
      // sqrtPrice is stored as a Q64.64 fixed-point number
      const sqrtPriceX64 = whirlpoolData.sqrtPrice;
      const price = PriceMath.sqrtPriceX64ToPrice(
        sqrtPriceX64,
        tokenA.decimals,
        tokenB.decimals
      );

      // Determine if we need to invert the price based on token order
      const [base, quote] = pair.split('/');
      const baseMint = TOKEN_MINTS[base];
      const isBaseTokenA = tokenA.mint.equals(baseMint);

      // Price is always tokenB/tokenA in Whirlpool
      // If base is tokenA, price is correct (USDC per base)
      // If base is tokenB, we need to invert
      const finalPrice = isBaseTokenA 
        ? price.toNumber() 
        : 1 / price.toNumber();

      // Estimate liquidity from token amounts
      const liquidity = whirlpoolData.liquidity.toNumber();

      return {
        pair,
        price: finalPrice,
        liquidity,
        sqrtPrice: sqrtPriceX64.toString(),
        tickCurrentIndex: whirlpoolData.tickCurrentIndex,
      };

    } catch (e) {
      console.error(`[Orca] Error fetching price for ${pair}:`, e);
      return null;
    }
  }

  /**
   * Get prices for multiple pairs
   */
  async getPrices(pairs: string[]): Promise<Map<string, OrcaPriceQuote>> {
    const results = new Map<string, OrcaPriceQuote>();

    for (const pair of pairs) {
      const quote = await this.getPrice(pair);
      if (quote) {
        results.set(pair, quote);
      }
      // Small delay between RPC calls
      await new Promise(r => setTimeout(r, 50));
    }

    return results;
  }
}
