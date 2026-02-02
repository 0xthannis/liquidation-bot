import { motion } from 'framer-motion'
import { 
  CheckCircle, 
  XCircle, 
  AlertTriangle, 
  ExternalLink,
  ArrowRight,
  Clock
} from 'lucide-react'
import { Opportunity } from '../types'

interface Props {
  opportunities: Opportunity[]
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return `il y a ${seconds}s`
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)}m`
  return `il y a ${Math.floor(seconds / 3600)}h`
}

function getDexColor(dex: string): string {
  return dex === 'raydium' ? 'text-accent-purple' : 'text-accent-cyan'
}

function getDexBg(dex: string): string {
  return dex === 'raydium' ? 'bg-accent-purple/10' : 'bg-accent-cyan/10'
}

function getStatusIcon(status: Opportunity['status']) {
  switch (status) {
    case 'executed':
      return <CheckCircle className="w-5 h-5 text-accent-green" />
    case 'failed':
      return <XCircle className="w-5 h-5 text-accent-red" />
    case 'skipped':
      return <AlertTriangle className="w-5 h-5 text-accent-orange" />
    default:
      return <Clock className="w-5 h-5 text-accent-blue animate-pulse" />
  }
}

function getStatusLabel(status: Opportunity['status']): string {
  switch (status) {
    case 'executed': return 'Exécuté'
    case 'failed': return 'Échoué'
    case 'skipped': return 'Ignoré'
    default: return 'Détecté'
  }
}

function getStatusColor(status: Opportunity['status']): string {
  switch (status) {
    case 'executed': return 'text-accent-green bg-accent-green/10'
    case 'failed': return 'text-accent-red bg-accent-red/10'
    case 'skipped': return 'text-accent-orange bg-accent-orange/10'
    default: return 'text-accent-blue bg-accent-blue/10'
  }
}

export default function OpportunitiesTable({ opportunities }: Props) {
  if (opportunities.length === 0) {
    return (
      <div className="glass-card rounded-2xl p-12 text-center">
        <div className="w-16 h-16 rounded-full bg-dark-600 flex items-center justify-center mx-auto mb-4">
          <Clock className="w-8 h-8 text-gray-500" />
        </div>
        <h3 className="text-lg font-medium text-white mb-2">Aucune opportunité détectée</h3>
        <p className="text-gray-500">Le bot scanne les marchés en continu...</p>
      </div>
    )
  }

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-dark-600">
              <th className="text-left py-4 px-6 text-sm font-medium text-gray-400">Heure</th>
              <th className="text-left py-4 px-6 text-sm font-medium text-gray-400">Paire</th>
              <th className="text-left py-4 px-6 text-sm font-medium text-gray-400">Route</th>
              <th className="text-right py-4 px-6 text-sm font-medium text-gray-400">Spread</th>
              <th className="text-right py-4 px-6 text-sm font-medium text-gray-400">Flash Loan</th>
              <th className="text-right py-4 px-6 text-sm font-medium text-gray-400">Profit Attendu</th>
              <th className="text-center py-4 px-6 text-sm font-medium text-gray-400">Statut</th>
              <th className="text-left py-4 px-6 text-sm font-medium text-gray-400">Détails</th>
            </tr>
          </thead>
          <tbody>
            {opportunities.map((opp, index) => (
              <motion.tr
                key={opp.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                className="border-b border-dark-700 hover:bg-dark-700/50 transition-colors"
              >
                <td className="py-4 px-6">
                  <div>
                    <p className="text-sm font-mono text-white">{formatTime(opp.timestamp)}</p>
                    <p className="text-xs text-gray-500">{formatTimeAgo(opp.timestamp)}</p>
                  </div>
                </td>
                <td className="py-4 px-6">
                  <span className="font-semibold text-white">{opp.pair}</span>
                </td>
                <td className="py-4 px-6">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${getDexBg(opp.buyDex)} ${getDexColor(opp.buyDex)}`}>
                      {opp.buyDex}
                    </span>
                    <ArrowRight className="w-4 h-4 text-gray-500" />
                    <span className={`px-2 py-1 rounded text-xs font-medium ${getDexBg(opp.sellDex)} ${getDexColor(opp.sellDex)}`}>
                      {opp.sellDex}
                    </span>
                  </div>
                </td>
                <td className="py-4 px-6 text-right">
                  <span className={`font-mono font-bold ${opp.spreadPercent >= 1 ? 'text-accent-green' : 'text-accent-yellow'}`}>
                    {opp.spreadPercent.toFixed(2)}%
                  </span>
                </td>
                <td className="py-4 px-6 text-right">
                  <span className="font-mono text-white">${opp.flashAmount.toLocaleString()}</span>
                </td>
                <td className="py-4 px-6 text-right">
                  <span className="font-mono font-bold text-accent-green">+${opp.expectedProfit.toLocaleString()}</span>
                </td>
                <td className="py-4 px-6">
                  <div className="flex items-center justify-center gap-2">
                    {getStatusIcon(opp.status)}
                    <span className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(opp.status)}`}>
                      {getStatusLabel(opp.status)}
                    </span>
                  </div>
                </td>
                <td className="py-4 px-6">
                  {opp.txSignature ? (
                    <a
                      href={`https://solscan.io/tx/${opp.txSignature}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-accent-purple hover:text-accent-cyan transition-colors"
                    >
                      <span className="text-sm font-mono">{opp.txSignature}</span>
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  ) : opp.failReason ? (
                    <p className="text-sm text-accent-red max-w-xs truncate" title={opp.failReason}>
                      {opp.failReason}
                    </p>
                  ) : (
                    <span className="text-gray-500">-</span>
                  )}
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
