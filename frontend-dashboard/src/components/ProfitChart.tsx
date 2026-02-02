import { motion } from 'framer-motion'
import { TrendingUp } from 'lucide-react'

export default function ProfitChart() {
  // Simulated profit data
  const profitData = [
    { hour: '00h', profit: 12 },
    { hour: '02h', profit: 8 },
    { hour: '04h', profit: 0 },
    { hour: '06h', profit: 25 },
    { hour: '08h', profit: 18 },
    { hour: '10h', profit: 45 },
    { hour: '12h', profit: 32 },
    { hour: '14h', profit: 15 },
    { hour: '16h', profit: 28 },
    { hour: '18h', profit: 42 },
    { hour: '20h', profit: 35 },
    { hour: '22h', profit: 22 },
  ]

  const maxProfit = Math.max(...profitData.map(d => d.profit))
  const totalProfit = profitData.reduce((sum, d) => sum + d.profit, 0)

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card rounded-2xl p-6"
    >
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent-green/10 flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-accent-green" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Profits sur 24h</h3>
            <p className="text-sm text-gray-500">Évolution heure par heure</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold font-mono-num text-accent-green">+${totalProfit}</p>
          <p className="text-sm text-gray-500">Total journalier</p>
        </div>
      </div>

      {/* Chart */}
      <div className="h-48 flex items-end gap-2">
        {profitData.map((data, index) => {
          const height = maxProfit > 0 ? (data.profit / maxProfit) * 100 : 0
          return (
            <motion.div
              key={data.hour}
              initial={{ height: 0 }}
              animate={{ height: `${Math.max(height, 5)}%` }}
              transition={{ delay: index * 0.05, duration: 0.5 }}
              className="flex-1 flex flex-col items-center gap-2"
            >
              <div
                className={`w-full rounded-t-lg ${
                  data.profit > 0 
                    ? 'bg-gradient-to-t from-accent-green/50 to-accent-green' 
                    : 'bg-dark-600'
                }`}
                style={{ height: '100%' }}
              />
              <span className="text-xs text-gray-500">{data.hour}</span>
            </motion.div>
          )
        })}
      </div>
    </motion.div>
  )
}
