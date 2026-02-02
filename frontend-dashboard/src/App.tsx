import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Header from './components/Header'
import StatsGrid from './components/StatsGrid'
import OpportunitiesTable from './components/OpportunitiesTable'
import TransactionsLog from './components/TransactionsLog'
import ProfitChart from './components/ProfitChart'
import ConnectionStatus from './components/ConnectionStatus'
import { BotData, Opportunity, Transaction } from './types'

const INITIAL_DATA: BotData = {
  status: 'disconnected',
  uptime: 0,
  totalScans: 0,
  opportunitiesFound: 0,
  executedTrades: 0,
  failedTrades: 0,
  totalProfit: 0,
  todayProfit: 0,
  solPrice: 0,
}

const API_URL = import.meta.env.VITE_BOT_API_URL || 'http://localhost:3001'

export default function App() {
  const [botData, setBotData] = useState<BotData>(INITIAL_DATA)
  const [opportunities, setOpportunities] = useState<Opportunity[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [activeTab, setActiveTab] = useState<'opportunities' | 'transactions'>('opportunities')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    const connectWebSocket = () => {
      const wsUrl = API_URL.replace('http://', 'ws://').replace('https://', 'wss://')
      console.log('[WS] Connecting to:', wsUrl)
      
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[WS] Connected')
        setIsConnected(true)
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          if (message.type === 'init' || message.type === 'update') {
            const { botData: bd, opportunities: opps, transactions: txs } = message.data
            if (bd) setBotData({ ...bd, status: 'running' })
            if (opps) setOpportunities(opps)
            if (txs) setTransactions(txs)
          }
        } catch (e) {
          console.error('[WS] Parse error:', e)
        }
      }

      ws.onclose = () => {
        console.log('[WS] Disconnected, reconnecting in 5s...')
        setIsConnected(false)
        setBotData(prev => ({ ...prev, status: 'disconnected' }))
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, 5000)
      }

      ws.onerror = (err) => {
        console.error('[WS] Error:', err)
        ws.close()
      }
    }

    connectWebSocket()

    return () => {
      if (wsRef.current) wsRef.current.close()
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
    }
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
