import { motion } from 'framer-motion'
import { 
  TrendingUp, 
  Zap, 
  Target, 
  CheckCircle, 
  XCircle, 
  Clock,
  DollarSign,
  Activity
} from 'lucide-react'
import { BotData } from '../types'

interface Props {
  data: BotData
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  return `${hours}h ${mins}m ${secs}s`
}

function formatNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

export default function StatsGrid({ data }: Props) {
  const stats = [
    {
      label: 'Profit Total',
      value: `$${data.totalProfit.toFixed(2)}`,
      icon: DollarSign,
      color: 'accent-green',
      bgColor: 'bg-accent-green/10',
      change: '+12.5%',
    },
    {
      label: "Profit Aujourd'hui",
      value: `$${data.todayProfit.toFixed(2)}`,
      icon: TrendingUp,
      color: 'accent-cyan',
      bgColor: 'bg-accent-cyan/10',
    },
    {
      label: 'Scans Effectués',
      value: formatNumber(data.totalScans),
      icon: Activity,
      color: 'accent-purple',
      bgColor: 'bg-accent-purple/10',
    },
    {
      label: 'Opportunités',
      value: data.opportunitiesFound.toString(),
      icon: Target,
      color: 'accent-orange',
      bgColor: 'bg-accent-orange/10',
    },
    {
      label: 'Trades Exécutés',
      value: data.executedTrades.toString(),
      icon: CheckCircle,
      color: 'accent-green',
      bgColor: 'bg-accent-green/10',
    },
    {
      label: 'Trades Échoués',
      value: data.failedTrades.toString(),
      icon: XCircle,
      color: 'accent-red',
      bgColor: 'bg-accent-red/10',
    },
    {
      label: 'Temps Actif',
      value: formatUptime(data.uptime),
      icon: Clock,
      color: 'accent-blue',
      bgColor: 'bg-accent-blue/10',
    },
    {
      label: 'Prix SOL',
      value: `$${data.solPrice.toFixed(2)}`,
      icon: Zap,
      color: 'accent-yellow',
      bgColor: 'bg-accent-yellow/10',
    },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map((stat, index) => (
        <motion.div
          key={stat.label}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.05 }}
          className="glass-card rounded-2xl p-5 hover:border-accent-purple/30 transition-colors"
        >
          <div className="flex items-start justify-between mb-3">
            <div className={`w-10 h-10 rounded-xl ${stat.bgColor} flex items-center justify-center`}>
              <stat.icon className={`w-5 h-5 text-${stat.color}`} />
            </div>
            {stat.change && (
              <span className="text-xs font-medium text-accent-green bg-accent-green/10 px-2 py-1 rounded-full">
                {stat.change}
              </span>
            )}
          </div>
          <p className="text-gray-400 text-sm mb-1">{stat.label}</p>
          <p className="text-2xl font-bold font-mono-num text-white">{stat.value}</p>
        </motion.div>
      ))}
    </div>
  )
}
