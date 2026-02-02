import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Header from './components/Header'
import StatsGrid from './components/StatsGrid'
import OpportunitiesTable from './components/OpportunitiesTable'
import TransactionsLog from './components/TransactionsLog'
import ProfitChart from './components/ProfitChart'
import ConnectionStatus from './components/ConnectionStatus'
import { BotData, Opportunity, Transaction } from './types'

const DEMO_DATA: BotData = {
  status: 'running',
  uptime: 3600,
  totalScans: 15420,
  opportunitiesFound: 23,
  executedTrades: 5,
  failedTrades: 2,
  totalProfit: 127.45,
  todayProfit: 45.80,
  solPrice: 98.50,
}

const DEMO_OPPORTUNITIES: Opportunity[] = [
  {
    id: '1',
    timestamp: Date.now() - 5000,
    pair: 'SOL/USDC',
    buyDex: 'raydium',
    sellDex: 'orca',
    buyPrice: 98.45,
    sellPrice: 99.32,
    spreadPercent: 0.88,
    flashAmount: 250000,
    expectedProfit: 1450,
    status: 'executed',
    txSignature: '5Kz8...9mNp',
  },
  {
    id: '2',
    timestamp: Date.now() - 120000,
    pair: 'JUP/USDC',
    buyDex: 'orca',
    sellDex: 'raydium',
    buyPrice: 0.892,
    sellPrice: 0.901,
    spreadPercent: 1.01,
    flashAmount: 100000,
    expectedProfit: 620,
    status: 'executed',
    txSignature: '3Fp2...7xKq',
  },
  {
    id: '3',
    timestamp: Date.now() - 300000,
    pair: 'JTO/USDC',
    buyDex: 'raydium',
    sellDex: 'orca',
    buyPrice: 2.45,
    sellPrice: 2.48,
    spreadPercent: 1.22,
    flashAmount: 50000,
    expectedProfit: 380,
    status: 'failed',
    failReason: 'Slippage trop élevé - prix changé pendant exécution',
  },
  {
    id: '4',
    timestamp: Date.now() - 600000,
    pair: 'WIF/USDC',
    buyDex: 'orca',
    sellDex: 'raydium',
    buyPrice: 2.12,
    sellPrice: 2.14,
    spreadPercent: 0.94,
    flashAmount: 75000,
    expectedProfit: 410,
    status: 'skipped',
    failReason: 'Liquidité insuffisante sur Raydium',
  },
]

const DEMO_TRANSACTIONS: Transaction[] = [
  {
    id: '1',
    timestamp: Date.now() - 5000,
    type: 'arbitrage',
    pair: 'SOL/USDC',
    profit: 1450,
    status: 'success',
    signature: '5Kz8HjPqR2mNxLvT9sFdW3cYgB6nK1pA8eVu4jXi9mNp',
    details: {
      flashAmount: 250000,
      buyDex: 'raydium',
      sellDex: 'orca',
      jitoTip: 0.0015,
    }
  },
  {
    id: '2',
    timestamp: Date.now() - 120000,
    type: 'arbitrage',
    pair: 'JUP/USDC',
    profit: 620,
    status: 'success',
    signature: '3Fp2KxNmL8vQwRtY5hDjS9cZgB1nK4pA7eVu2jXi7xKq',
    details: {
      flashAmount: 100000,
      buyDex: 'orca',
      sellDex: 'raydium',
      jitoTip: 0.0008,
    }
  },
  {
    id: '3',
    timestamp: Date.now() - 300000,
    type: 'arbitrage',
    pair: 'JTO/USDC',
    profit: 0,
    status: 'failed',
    signature: null,
    error: 'Transaction simulation failed: slippage exceeded',
    details: {
      flashAmount: 50000,
      buyDex: 'raydium',
      sellDex: 'orca',
    }
  },
]

export default function App() {
  const [botData, setBotData] = useState<BotData>(DEMO_DATA)
  const [opportunities, setOpportunities] = useState<Opportunity[]>(DEMO_OPPORTUNITIES)
  const [transactions, setTransactions] = useState<Transaction[]>(DEMO_TRANSACTIONS)
  const [isConnected, setIsConnected] = useState(true)
  const [activeTab, setActiveTab] = useState<'opportunities' | 'transactions'>('opportunities')

  useEffect(() => {
    const interval = setInterval(() => {
      setBotData(prev => ({
        ...prev,
        uptime: prev.uptime + 1,
        totalScans: prev.totalScans + Math.floor(Math.random() * 3),
      }))
    }, 1000)

    return () => clearInterval(interval)
  }, [])

  return (
    <div className="min-h-screen bg-dark-900">
      {/* Background gradient effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-accent-purple/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-accent-cyan/10 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10">
        <Header />
        
        <main className="container mx-auto px-4 py-6 space-y-6">
          {/* Connection Status */}
          <ConnectionStatus isConnected={isConnected} botStatus={botData.status} />
          
          {/* Stats Grid */}
          <StatsGrid data={botData} />
          
          {/* Profit Chart */}
          <ProfitChart />
          
          {/* Tabs */}
          <div className="flex gap-2">
            <button
              onClick={() => setActiveTab('opportunities')}
              className={`px-6 py-3 rounded-xl font-medium transition-all ${
                activeTab === 'opportunities'
                  ? 'bg-accent-purple text-white glow-purple'
                  : 'bg-dark-700 text-gray-400 hover:text-white hover:bg-dark-600'
              }`}
            >
              🎯 Opportunités détectées
            </button>
            <button
              onClick={() => setActiveTab('transactions')}
              className={`px-6 py-3 rounded-xl font-medium transition-all ${
                activeTab === 'transactions'
                  ? 'bg-accent-purple text-white glow-purple'
                  : 'bg-dark-700 text-gray-400 hover:text-white hover:bg-dark-600'
              }`}
            >
              📜 Historique transactions
            </button>
          </div>
          
          {/* Content */}
          <AnimatePresence mode="wait">
            {activeTab === 'opportunities' ? (
              <motion.div
                key="opportunities"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
              >
                <OpportunitiesTable opportunities={opportunities} />
              </motion.div>
            ) : (
              <motion.div
                key="transactions"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
              >
                <TransactionsLog transactions={transactions} />
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
