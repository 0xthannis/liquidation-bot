/**
 * Raydium DEX Integration
 * Uses official Raydium Trade API
 * Documentation: https://docs.raydium.io/raydium/traders/trade-api
 */

import { Connection, PublicKey, VersionedTransaction, Transaction } from '@solana/web3.js';

const RAYDIUM_API_URL = 'https://transaction-v1.raydium.io';
const RAYDIUM_PRIORITY_FEE_URL = 'https://api-v3.raydium.io/main/auto-fee';

// Token mint addresses and decimals
const TOKEN_INFO: Record<string, { mint: string; decimals: number }> = {
  'SOL': { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  'USDC': { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  'JUP': { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
  'JTO': { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', decimals: 9 },
  'BONK': { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
  'WIF': { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
};

export interface RaydiumPriceQuote {
  pair: string;
  price: number;
  liquidity: number;
  poolId: string;
  poolType: string;
}

/**
 * Raydium DEX client using Trade API
 * https://docs.raydium.io/raydium/traders/trade-api
 */
export class RaydiumClient {
  private connection: Connection;
  private initialized = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    console.log('[Raydium] SDK initialized');
  }

  /**
   * Get price using Raydium Trade API swap quote
   * Returns price in quote tokens (USDC) per 1 base token
   */
  async getPrice(pair: string): Promise<RaydiumPriceQuote | null> {
    const [base, quote] = pair.split('/');
    const baseInfo = TOKEN_INFO[base];
    const quoteInfo = TOKEN_INFO[quote];

    if (!baseInfo || !quoteInfo) {
      console.error(`[Raydium] Unknown tokens in pair: ${pair}`);
      return null;
    }

    try {
      // Use larger amount for tokens with very low prices to get accurate quotes
      // BONK and similar meme coins need larger amounts to avoid minimum output issues
      const tokenMultiplier = baseInfo.decimals <= 6 ? 1000 : 1; // Use 1000 tokens for low decimal tokens
      const inputAmount = Math.pow(10, baseInfo.decimals) * tokenMultiplier;
      
      const url = `${RAYDIUM_API_URL}/compute/swap-base-in?inputMint=${baseInfo.mint}&outputMint=${quoteInfo.mint}&amount=${inputAmount}&slippageBps=50&txVersion=V0`;
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      
      if (!data.success || !data.data) {
        console.error(`[Raydium] ${pair}: API returned no data`);
        return null;
      }

      // Calculate price from output amount
      // outputAmount is in quote token base units
      // Divide by tokenMultiplier to get price per 1 token
      const outputAmount = Number(data.data.outputAmount);
      const price = (outputAmount / Math.pow(10, quoteInfo.decimals)) / tokenMultiplier;

      // Debug: show raw values for verification
      console.log(`[Raydium] ${pair}: inputTokens=${tokenMultiplier}, outputAmount=${outputAmount}, price=${price}`);

      return {
        pair,
        price,
        liquidity: 0, // Not available from this API
        poolId: data.data.routePlan?.[0]?.poolId || '',
        poolType: 'swap',
      };

    } catch (e) {
      console.error(`[Raydium] Error fetching price for ${pair}:`, e);
      return null;
    }
  }

  async getPrices(pairs: string[]): Promise<Map<string, RaydiumPriceQuote>> {
    const results = new Map<string, RaydiumPriceQuote>();
    for (const pair of pairs) {
      const quote = await this.getPrice(pair);
      if (quote) {
        results.set(pair, quote);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return results;
  }

  /**
   * Build swap transaction using Raydium Trade API
   * @param inputMint Input token mint address
   * @param outputMint Output token mint address  
   * @param amountIn Amount in base units (lamports)
   * @param walletPubkey Wallet public key
   * @param slippageBps Slippage in basis points (default 50 = 0.5%)
   * @returns Serialized transaction buffer or null
   */
  async buildSwapTransaction(
    inputMint: string,
    outputMint: string,
    amountIn: number,
    walletPubkey: PublicKey,
    slippageBps: number = 50
  ): Promise<Buffer | null> {
    try {
      // Step 1: Get swap quote
      const quoteUrl = `${RAYDIUM_API_URL}/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountIn}&slippageBps=${slippageBps}&txVersion=V0`;
      
      const quoteResponse = await fetch(quoteUrl);
      if (!quoteResponse.ok) {
        console.error(`[Raydium] Quote API error: ${quoteResponse.status}`);
        return null;
      }
      
      const quoteData = await quoteResponse.json();
      if (!quoteData.success || !quoteData.data) {
        console.error('[Raydium] Quote API returned no data');
        return null;
      }

      // Step 2: Get priority fee
      let priorityFee = 100000; // Default 0.0001 SOL
      try {
        const feeResponse = await fetch(RAYDIUM_PRIORITY_FEE_URL);
        if (feeResponse.ok) {
          const feeData = await feeResponse.json();
          priorityFee = feeData.data?.default?.h || 100000;
        }
      } catch (e) {
        // Use default fee
      }

      // Step 3: Build transaction
      const txResponse = await fetch(`${RAYDIUM_API_URL}/transaction/swap-base-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          computeUnitPriceMicroLamports: String(priorityFee),
          swapResponse: quoteData,
          txVersion: 'V0',
          wallet: walletPubkey.toBase58(),
          wrapSol: inputMint === TOKEN_INFO['SOL'].mint,
          unwrapSol: outputMint === TOKEN_INFO['SOL'].mint,
        }),
      });

      if (!txResponse.ok) {
        console.error(`[Raydium] Transaction API error: ${txResponse.status}`);
        return null;
      }

      const txData = await txResponse.json();
      if (!txData.success || !txData.data || txData.data.length === 0) {
        console.error('[Raydium] Transaction API returned no data');
        return null;
      }

      // Return first transaction (usually only one for simple swaps)
      return Buffer.from(txData.data[0].transaction, 'base64');

    } catch (e) {
      console.error('[Raydium] Error building swap transaction:', e);
      return null;
    }
  }

  /**
   * Get token info by symbol
   */
  getTokenInfo(symbol: string): { mint: string; decimals: number } | null {
    return TOKEN_INFO[symbol] || null;
  }
}
