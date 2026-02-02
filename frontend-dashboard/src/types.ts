export interface BotData {
  status: 'running' | 'stopped' | 'error'
  uptime: number
  totalScans: number
  opportunitiesFound: number
  executedTrades: number
  failedTrades: number
  totalProfit: number
  todayProfit: number
  solPrice: number
}

export interface Opportunity {
  id: string
  timestamp: number
  pair: string
  buyDex: 'raydium' | 'orca'
  sellDex: 'raydium' | 'orca'
  buyPrice: number
  sellPrice: number
  spreadPercent: number
  flashAmount: number
  expectedProfit: number
  status: 'detected' | 'executed' | 'failed' | 'skipped'
  txSignature?: string
  failReason?: string
}

export interface Transaction {
  id: string
  timestamp: number
  type: 'arbitrage' | 'tip' | 'other'
  pair: string
  profit: number
  status: 'success' | 'failed' | 'pending'
  signature: string | null
  error?: string
  details?: {
    flashAmount?: number
    buyDex?: string
    sellDex?: string
    jitoTip?: number
  }
}

export interface ProfitDataPoint {
  time: string
  profit: number
  cumulative: number
}
