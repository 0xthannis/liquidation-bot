import Decimal from 'decimal.js';

/**
 * DEX fee structures (as decimals)
 */
export const DEX_FEES: Record<string, number> = {
  raydium: 0.0025,   // 0.25%
  orca: 0.0025,      // 0.25%
  meteora: 0.0020,   // 0.20%
  phoenix: 0.0010,   // 0.10%
};

/**
 * Kamino flash loan fee
 */
export const FLASH_LOAN_FEE = 0.00001; // 0.001%

/**
 * Jito tip configuration
 * Dynamic tip = percentage of expected profit to ensure priority while staying profitable
 */
export const JITO_TIP_CONFIG = {
  MIN_TIP_SOL: 0.0001,      // Minimum tip: 0.0001 SOL (~$0.01)
  MAX_TIP_SOL: 0.1,         // Maximum tip: 0.1 SOL (~$10)
  PROFIT_SHARE: 0.15,       // Use 15% of expected profit as tip
};

/**
 * Calculate dynamic Jito tip based on expected profit
 * @param expectedProfitUsd Expected profit in USD
 * @param solPriceUsd Current SOL price in USD
 * @returns Tip amount in SOL
 */
export function calculateJitoTip(expectedProfitUsd: number, solPriceUsd: number): number {
  // Calculate tip as percentage of profit
  const tipUsd = expectedProfitUsd * JITO_TIP_CONFIG.PROFIT_SHARE;
  const tipSol = tipUsd / solPriceUsd;
  
  // Apply min/max bounds
  return Math.min(
    Math.max(tipSol, JITO_TIP_CONFIG.MIN_TIP_SOL),
    JITO_TIP_CONFIG.MAX_TIP_SOL
  );
}

/**
 * Calculate final profit after Jito tip
 */
export function calculateNetProfitAfterTip(
  grossNetProfit: number,
  jitoTipSol: number,
  solPriceUsd: number
): number {
  const tipCostUsd = jitoTipSol * solPriceUsd;
  return grossNetProfit - tipCostUsd;
}

/**
 * Minimum spread thresholds for profitability
 */
export const MIN_SPREAD_THRESHOLDS: Record<string, number> = {
  'phoenix-meteora': 0.0030,      // 0.30%
  'phoenix-raydium': 0.0035,      // 0.35%
  'phoenix-orca': 0.0035,         // 0.35%
  'meteora-phoenix': 0.0030,      // 0.30%
  'meteora-raydium': 0.0050,      // 0.50%
  'meteora-orca': 0.0050,         // 0.50%
  'raydium-orca': 0.0060,         // 0.60%
  'orca-raydium': 0.0060,         // 0.60%
};

export interface ProfitCalculation {
  grossProfit: number;
  flashLoanFee: number;
  buyFee: number;
  sellFee: number;
  slippageCost: number;
  netProfit: number;
  profitPercent: number;
  isProfitable: boolean;
}

export interface ArbitrageOpportunity {
  pair: string;
  buyDex: string;
  sellDex: string;
  buyPrice: number;
  sellPrice: number;
  spread: number;
  spreadPercent: number;
  flashAmount: number;
  calculation: ProfitCalculation;
  buyLiquidity: number;
  sellLiquidity: number;
  timestamp: number;
}

/**
 * Calculate the spread between two prices
 */
export function calculateSpread(buyPrice: number, sellPrice: number): { spread: number; spreadPercent: number } {
  const spread = sellPrice - buyPrice;
  const spreadPercent = spread / buyPrice;
  return { spread, spreadPercent };
}

/**
 * Check if spread meets minimum threshold for the DEX pair
 */
export function meetsMinimumSpread(buyDex: string, sellDex: string, spreadPercent: number): boolean {
  const key = `${buyDex}-${sellDex}`;
  const reverseKey = `${sellDex}-${buyDex}`;
  const threshold = MIN_SPREAD_THRESHOLDS[key] || MIN_SPREAD_THRESHOLDS[reverseKey] || 0.005;
  return spreadPercent >= threshold;
}

/**
 * Calculate profit for an arbitrage opportunity
 */
export function calculateProfit(
  flashAmountUsd: number,
  buyPrice: number,
  sellPrice: number,
  buyDex: string,
  sellDex: string,
  estimatedSlippage: number = 0.001
): ProfitCalculation {
  const d = Decimal.set({ precision: 20 });
  
  const amount = new d(flashAmountUsd);
  const buy = new d(buyPrice);
  const sell = new d(sellPrice);
  
  // Calculate token amount we can buy
  const tokenAmount = amount.div(buy);
  
  // Gross profit from price difference
  const grossValue = tokenAmount.mul(sell);
  const grossProfit = grossValue.sub(amount);
  
  // Fees
  const flashLoanFee = amount.mul(FLASH_LOAN_FEE);
  const buyFee = amount.mul(DEX_FEES[buyDex] || 0.0025);
  const sellFee = grossValue.mul(DEX_FEES[sellDex] || 0.0025);
  const slippageCost = amount.mul(estimatedSlippage);
  
  // Net profit
  const totalCosts = flashLoanFee.add(buyFee).add(sellFee).add(slippageCost);
  const netProfit = grossProfit.sub(totalCosts);
  
  const profitPercent = netProfit.div(amount).toNumber();
  
  return {
    grossProfit: grossProfit.toNumber(),
    flashLoanFee: flashLoanFee.toNumber(),
    buyFee: buyFee.toNumber(),
    sellFee: sellFee.toNumber(),
    slippageCost: slippageCost.toNumber(),
    netProfit: netProfit.toNumber(),
    profitPercent,
    isProfitable: netProfit.toNumber() > 0,
  };
}

/**
 * Find the best arbitrage opportunity from price quotes
 */
export function findBestOpportunity(
  pair: string,
  prices: Map<string, number>,
  liquidities: Map<string, number>,
  calculateOptimalAmount: (pair: string, minLiquidity: number, spreadPercent: number) => number
): ArbitrageOpportunity | null {
  const dexes = Array.from(prices.keys());
  let bestOpportunity: ArbitrageOpportunity | null = null;
  let bestProfit = 0;

  // Compare all DEX pairs
  for (let i = 0; i < dexes.length; i++) {
    for (let j = 0; j < dexes.length; j++) {
      if (i === j) continue;
      
      const buyDex = dexes[i];
      const sellDex = dexes[j];
      const buyPrice = prices.get(buyDex)!;
      const sellPrice = prices.get(sellDex)!;
      
      // Skip if buy price >= sell price
      if (buyPrice >= sellPrice) continue;
      
      const { spread, spreadPercent } = calculateSpread(buyPrice, sellPrice);
      
      // Check minimum spread threshold
      if (!meetsMinimumSpread(buyDex, sellDex, spreadPercent)) continue;
      
      // Get liquidity
      const buyLiquidity = liquidities.get(buyDex) || 0;
      const sellLiquidity = liquidities.get(sellDex) || 0;
      const minLiquidity = Math.min(buyLiquidity, sellLiquidity);
      
      // Calculate optimal flash amount
      const flashAmount = calculateOptimalAmount(pair, minLiquidity, spreadPercent);
      
      // Estimate slippage based on amount vs liquidity
      const slippageEstimate = estimateSlippage(flashAmount, minLiquidity);
      
      // Calculate profit
      const calculation = calculateProfit(
        flashAmount,
        buyPrice,
        sellPrice,
        buyDex,
        sellDex,
        slippageEstimate
      );
      
      if (calculation.netProfit > bestProfit) {
        bestProfit = calculation.netProfit;
        bestOpportunity = {
          pair,
          buyDex,
          sellDex,
          buyPrice,
          sellPrice,
          spread,
          spreadPercent,
          flashAmount,
          calculation,
          buyLiquidity,
          sellLiquidity,
          timestamp: Date.now(),
        };
      }
    }
  }

  return bestOpportunity;
}

/**
 * Estimate slippage based on trade size vs pool liquidity
 */
export function estimateSlippage(tradeSize: number, poolLiquidity: number): number {
  if (poolLiquidity <= 0) return 0.01; // 1% default if no liquidity data
  
  const ratio = tradeSize / poolLiquidity;
  
  // Simplified slippage model: slippage increases quadratically with size
  // 1% of pool = ~0.02% slippage
  // 5% of pool = ~0.5% slippage
  // 10% of pool = ~2% slippage
  const slippage = ratio * ratio * 2;
  
  return Math.min(slippage, 0.05); // Cap at 5%
}
