/**
 * New Token Discovery Module
 * Automatically discovers new tokens listed in the last 24h with volume > $100K
 * Sources: DexScreener API (free, no API key needed)
 */

import { PublicKey } from '@solana/web3.js';

// Minimum requirements for a token to be monitored
const MIN_VOLUME_24H = 100_000; // $100K minimum volume
const MIN_LIQUIDITY = 50_000; // $50K minimum liquidity
const MAX_AGE_HOURS = 24; // Listed in last 24 hours
const MAX_TOKENS_TO_TRACK = 10; // Limit to avoid rate limits

// Token info from discovery
export interface DiscoveredToken {
  name: string;
  symbol: string;
  mint: string;
  decimals: number;
  priceUsd: number;
  volume24h: number;
  liquidity: number;
  pairAddress: string;
  dex: 'raydium' | 'orca' | 'pumpswap' | 'meteora';
  createdAt: number;
  ageHours: number;
}

// Dynamic trading pair
export interface DynamicTradingPair {
  name: string;
  tokenA: string;
  tokenB: string;
  decimalsA: number;
  decimalsB: number;
  mintA: PublicKey;
  mintB: PublicKey;
  volume24h: number;
  source: 'static' | 'discovered';
}

// Cache for discovered tokens
let discoveredTokens: DiscoveredToken[] = [];
let lastDiscoveryTime = 0;
const DISCOVERY_INTERVAL = 5 * 60 * 1000; // Refresh every 5 minutes

// SOL mint for pairing
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;

/**
 * Fetch new tokens from DexScreener API
 * DexScreener is free and provides good data for Solana DEXes
 */
async function fetchFromDexScreener(): Promise<DiscoveredToken[]> {
  try {
    // DexScreener API - get latest Solana token profiles (new listings)
    // Try multiple endpoints for better coverage
    const endpoints = [
      'https://api.dexscreener.com/token-profiles/latest/v1',
      'https://api.dexscreener.com/token-boosts/latest/v1',
    ];
    
    const allTokens: DiscoveredToken[] = [];
    
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, { 
          headers: { 'Accept': 'application/json' } 
        });
        
        if (!response.ok) continue;
        
        const profiles = await response.json() as Array<{
          chainId: string;
          tokenAddress: string;
          description?: string;
          icon?: string;
        }>;
        
        // Filter Solana tokens and fetch their pair data
        const solanaTokens = profiles.filter(p => p.chainId === 'solana').slice(0, 20);
        
        for (const token of solanaTokens) {
          const pairData = await fetchTokenPairs(token.tokenAddress);
          if (pairData) allTokens.push(...pairData);
        }
      } catch (e) {
        // Continue to next endpoint
      }
    }
    
    // Also try the pairs endpoint for Solana
    try {
      const pairsResponse = await fetch(
        'https://api.dexscreener.com/latest/dex/pairs/solana',
        { headers: { 'Accept': 'application/json' } }
      );
      
      if (pairsResponse.ok) {
        const data = await pairsResponse.json() as { pairs?: any[] };
        if (data.pairs) {
          const filtered = filterPairs(data.pairs);
          allTokens.push(...filtered);
        }
      }
    } catch (e) {}
    
    // Deduplicate by mint
    const uniqueTokens = new Map<string, DiscoveredToken>();
    for (const token of allTokens) {
      if (!uniqueTokens.has(token.mint) || token.volume24h > (uniqueTokens.get(token.mint)?.volume24h || 0)) {
        uniqueTokens.set(token.mint, token);
      }
    }
    
    return Array.from(uniqueTokens.values());
  } catch (error) {
    console.error('DexScreener fetch error:', error);
    return [];
  }
}

/**
 * Fetch pair data for a specific token
 */
async function fetchTokenPairs(tokenAddress: string): Promise<DiscoveredToken[]> {
  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (!response.ok) return [];
    
    const data = await response.json() as { pairs?: any[] };
    if (!data.pairs) return [];
    
    return filterPairs(data.pairs);
  } catch (e) {
    return [];
  }
}

/**
 * Filter pairs by our criteria
 */
function filterPairs(pairs: any[]): DiscoveredToken[] {
  const now = Date.now();
  const tokens: DiscoveredToken[] = [];

  for (const pair of pairs) {
    // Only Solana pairs
    if (pair.chainId !== 'solana') continue;

    // Only pairs with SOL as quote token
    if (pair.quoteToken?.address !== SOL_MINT && pair.quoteToken?.symbol !== 'SOL') continue;

    // Calculate age
    const ageMs = now - (pair.pairCreatedAt || 0);
    const ageHours = ageMs / (1000 * 60 * 60);

    // Filter by age (allow older tokens if they have high volume)
    const volume24h = pair.volume?.h24 || 0;
    const liquidity = pair.liquidity?.usd || 0;
    
    // Relaxed criteria: either new (<24h) OR high volume (>$500k)
    if (ageHours > MAX_AGE_HOURS && volume24h < 500000) continue;

    // Filter by volume
    if (volume24h < MIN_VOLUME_24H) continue;

    // Filter by liquidity
    if (liquidity < MIN_LIQUIDITY) continue;

    // Map DEX ID
    let dex: DiscoveredToken['dex'];
    const dexId = pair.dexId || '';
    if (dexId.includes('raydium')) dex = 'raydium';
    else if (dexId.includes('orca')) dex = 'orca';
    else if (dexId.includes('pump')) dex = 'pumpswap';
    else if (dexId.includes('meteora')) dex = 'meteora';
    else continue; // Skip unknown DEXes

    tokens.push({
      name: pair.baseToken?.name || 'Unknown',
      symbol: pair.baseToken?.symbol || 'UNK',
      mint: pair.baseToken?.address || '',
      decimals: 6,
      priceUsd: parseFloat(pair.priceUsd) || 0,
      volume24h,
      liquidity,
      pairAddress: pair.pairAddress,
      dex,
      createdAt: pair.pairCreatedAt,
      ageHours: Math.round(ageHours * 10) / 10,
    });
  }

  // Sort by volume and limit
  tokens.sort((a, b) => b.volume24h - a.volume24h);
  return tokens.slice(0, MAX_TOKENS_TO_TRACK);
}

/**
 * Fetch trending tokens from Jupiter
 */
async function fetchFromJupiter(): Promise<DiscoveredToken[]> {
  try {
    const apiKey = process.env.JUPITER_API_KEY || '1605a29f-3095-43b5-ab87-cbb29975bd36';
    
    // Jupiter tokens API - get verified tokens
    const response = await fetch(
      'https://tokens.jup.ag/tokens?tags=verified',
      { headers: { 'Accept': 'application/json', 'x-api-key': apiKey } }
    );

    if (!response.ok) return [];

    // Jupiter doesn't provide volume/age directly, so we'll rely on DexScreener
    // This is just a backup for token metadata
    return [];

  } catch (error) {
    console.error('Jupiter fetch error:', error);
    return [];
  }
}

/**
 * Discover new tokens from all sources
 */
export async function discoverNewTokens(): Promise<DiscoveredToken[]> {
  const now = Date.now();

  // Use cache if recent
  if (now - lastDiscoveryTime < DISCOVERY_INTERVAL && discoveredTokens.length > 0) {
    return discoveredTokens;
  }

  console.log('\n🔍 Discovering new tokens (24h, volume >$100K)...');

  // Fetch from all sources
  const [dexScreenerTokens] = await Promise.all([
    fetchFromDexScreener(),
    // fetchFromJupiter(), // Disabled - DexScreener is enough
  ]);

  // Combine and deduplicate by mint
  const tokenMap = new Map<string, DiscoveredToken>();
  
  for (const token of dexScreenerTokens) {
    const existing = tokenMap.get(token.mint);
    if (!existing || token.volume24h > existing.volume24h) {
      tokenMap.set(token.mint, token);
    }
  }

  discoveredTokens = Array.from(tokenMap.values());
  lastDiscoveryTime = now;

  // Log discovered tokens
  if (discoveredTokens.length > 0) {
    console.log(`   ✅ Found ${discoveredTokens.length} new tokens:`);
    for (const token of discoveredTokens.slice(0, 5)) {
      console.log(`      - ${token.symbol}: $${(token.volume24h / 1000).toFixed(0)}K vol, ${token.ageHours}h old, ${token.dex}`);
    }
    if (discoveredTokens.length > 5) {
      console.log(`      ... and ${discoveredTokens.length - 5} more`);
    }
  } else {
    console.log('   ⚠️ No new tokens found matching criteria');
  }

  return discoveredTokens;
}

/**
 * Convert discovered tokens to trading pairs
 */
export function getDiscoveredTradingPairs(): DynamicTradingPair[] {
  return discoveredTokens.map(token => ({
    name: `${token.symbol}/SOL`,
    tokenA: token.symbol,
    tokenB: 'SOL',
    decimalsA: token.decimals,
    decimalsB: SOL_DECIMALS,
    mintA: new PublicKey(token.mint),
    mintB: new PublicKey(SOL_MINT),
    volume24h: token.volume24h,
    source: 'discovered' as const,
  }));
}

/**
 * Get all trading pairs (static + discovered)
 */
export function getAllTradingPairs(staticPairs: DynamicTradingPair[]): DynamicTradingPair[] {
  const discoveredPairs = getDiscoveredTradingPairs();
  
  // Combine, avoiding duplicates
  const allPairs = [...staticPairs];
  
  for (const discovered of discoveredPairs) {
    const exists = allPairs.some(p => p.name === discovered.name);
    if (!exists) {
      allPairs.push(discovered);
    }
  }
  
  return allPairs;
}

/**
 * Get discovered tokens list
 */
export function getDiscoveredTokens(): DiscoveredToken[] {
  return [...discoveredTokens];
}

/**
 * Force refresh token discovery
 */
export async function refreshTokenDiscovery(): Promise<DiscoveredToken[]> {
  lastDiscoveryTime = 0; // Reset cache
  return discoverNewTokens();
}

export default {
  discoverNewTokens,
  getDiscoveredTradingPairs,
  getAllTradingPairs,
  getDiscoveredTokens,
  refreshTokenDiscovery,
};
