/**
 * DEX Integrations Index
 * Exports all DEX clients for unified access
 */

export { RaydiumClient, type RaydiumPriceQuote } from './raydium.js';
export { OrcaClient, type OrcaPriceQuote } from './orca.js';
export { MeteoraClient, type MeteoraPriceQuote } from './meteora.js';
export { PhoenixClient, type PhoenixPriceQuote } from './phoenix.js';

// Common price quote interface for all DEXes
export interface UnifiedPriceQuote {
  dex: 'raydium' | 'orca' | 'meteora' | 'phoenix';
  pair: string;
  price: number;
  liquidity: number;
  timestamp: number;
}
