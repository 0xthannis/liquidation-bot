/**
 * Dynamic Flash Loan Amount Calculator
 * Calculates optimal trade size based on liquidity, spread, and slippage
 */

/**
 * Default starting amounts per pair (USD)
 */
export const DEFAULT_AMOUNTS: Record<string, number> = {
  'SOL/USDC': 500_000,   // Very liquid
  'JUP/USDC': 100_000,
  'JTO/USDC': 100_000,
  'WIF/USDC': 50_000,
};

/**
 * Absolute limits - no hard limits, adapts to available liquidity
 */
export const MIN_AMOUNT = 100;           // $100 minimum (just for safety)
export const MAX_AMOUNT = 100_000_000;   // $100M maximum (effectively no limit)

/**
 * Liquidity ratio - max % of pool we can use
 */
export const MAX_LIQUIDITY_RATIO = 0.10; // 10% of smallest pool

/**
 * Slippage thresholds
 */
export const HIGH_SLIPPAGE_THRESHOLD = 0.003; // 0.3%
export const LOW_SLIPPAGE_THRESHOLD = 0.001;  // 0.1%

/**
 * Spread multipliers
 */
export const HIGH_SPREAD_THRESHOLD = 0.01;    // 1%
export const SPREAD_MULTIPLIER = 1.5;         // Increase amount by 50% for high spread

export interface SizingResult {
  amount: number;
  reason: string;
  liquidityLimit: number;
  spreadAdjustment: number;
  slippageAdjustment: number;
}

/**
 * Calculate optimal flash loan amount for an arbitrage opportunity
 */
export function calculateOptimalAmount(
  pair: string,
  minPoolLiquidity: number,
  spreadPercent: number,
  currentSlippageEstimate: number = 0.001
): SizingResult {
  // Start with default amount for this pair
  let baseAmount = DEFAULT_AMOUNTS[pair] || 100_000;
  
  // 1. Liquidity constraint - max 10% of smallest pool
  const liquidityLimit = minPoolLiquidity * MAX_LIQUIDITY_RATIO;
  
  // 2. Spread adjustment
  let spreadAdjustment = 1.0;
  if (spreadPercent > HIGH_SPREAD_THRESHOLD) {
    // High spread = more profit potential, can go bigger
    spreadAdjustment = SPREAD_MULTIPLIER;
  } else if (spreadPercent < 0.005) {
    // Low spread = reduce size to minimize slippage impact
    spreadAdjustment = 0.7;
  }
  
  // 3. Slippage adjustment
  let slippageAdjustment = 1.0;
  if (currentSlippageEstimate > HIGH_SLIPPAGE_THRESHOLD) {
    // High slippage = reduce size
    slippageAdjustment = 0.5;
  } else if (currentSlippageEstimate < LOW_SLIPPAGE_THRESHOLD) {
    // Low slippage = can increase size
    slippageAdjustment = 1.2;
  }
  
  // Calculate adjusted amount
  let adjustedAmount = baseAmount * spreadAdjustment * slippageAdjustment;
  
  // Apply liquidity limit
  adjustedAmount = Math.min(adjustedAmount, liquidityLimit);
  
  // Apply absolute limits
  adjustedAmount = Math.max(adjustedAmount, MIN_AMOUNT);
  adjustedAmount = Math.min(adjustedAmount, MAX_AMOUNT);
  
  // Round to nearest $1000
  adjustedAmount = Math.round(adjustedAmount / 1000) * 1000;
  
  // Determine reason
  let reason = 'default';
  if (adjustedAmount === liquidityLimit) {
    reason = 'liquidity_limited';
  } else if (spreadAdjustment > 1) {
    reason = 'high_spread_boost';
  } else if (slippageAdjustment < 1) {
    reason = 'slippage_reduced';
  }
  
  return {
    amount: adjustedAmount,
    reason,
    liquidityLimit,
    spreadAdjustment,
    slippageAdjustment,
  };
}

/**
 * Calculate profit for a given amount considering slippage
 * Slippage model: slippage % = (amount / liquidity)^2 * 200
 */
export function estimateNetProfit(
  amount: number,
  spreadPercent: number,
  minPoolLiquidity: number,
  totalFeesPercent: number = 0.008 // 0.8% default (flash + dex fees)
): number {
  // Gross profit from spread
  const grossProfit = amount * spreadPercent;
  
  // Fixed fees (flash loan + DEX fees)
  const fees = amount * totalFeesPercent;
  
  // Slippage increases quadratically with size relative to liquidity
  // Formula: slippage% = (amount/liquidity)^2 * 2
  const sizeRatio = amount / minPoolLiquidity;
  const slippagePercent = sizeRatio * sizeRatio * 2;
  const slippageCost = amount * slippagePercent;
  
  return grossProfit - fees - slippageCost;
}

/**
 * Find the optimal flash loan amount that maximizes profit
 * Tests multiple amounts and picks the one with highest net profit
 */
export function findOptimalAmountIterative(
  pair: string,
  minPoolLiquidity: number,
  spreadPercent: number,
  totalFeesPercent: number = 0.008
): { amount: number; expectedProfit: number; slippagePercent: number } {
  // Test amounts from $1K to 10% of pool liquidity
  const maxAmount = minPoolLiquidity * MAX_LIQUIDITY_RATIO;
  const testAmounts = [
    1_000,
    5_000,
    10_000,
    25_000,
    50_000,
    100_000,
    250_000,
    500_000,
    1_000_000,
    2_500_000,
    5_000_000,
    10_000_000,
  ].filter(a => a <= maxAmount);
  
  let bestAmount = testAmounts[0] || 1000;
  let bestProfit = -Infinity;
  let bestSlippage = 0;
  
  for (const amount of testAmounts) {
    const profit = estimateNetProfit(amount, spreadPercent, minPoolLiquidity, totalFeesPercent);
    
    if (profit > bestProfit) {
      bestProfit = profit;
      bestAmount = amount;
      bestSlippage = Math.pow(amount / minPoolLiquidity, 2) * 2;
    }
  }
  
  // If no profitable amount found, return minimum
  if (bestProfit <= 0) {
    return { amount: 0, expectedProfit: 0, slippagePercent: 0 };
  }
  
  return { 
    amount: bestAmount, 
    expectedProfit: bestProfit,
    slippagePercent: bestSlippage,
  };
}

/**
 * Get a simple sizing function for use in profit calculator
 */
export function getSimpleSizer(pair: string): (minLiquidity: number, spreadPercent: number) => number {
  return (minLiquidity: number, spreadPercent: number): number => {
    const result = calculateOptimalAmount(pair, minLiquidity, spreadPercent);
    return result.amount;
  };
}
