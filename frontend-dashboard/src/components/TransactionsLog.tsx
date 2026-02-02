import { motion } from 'framer-motion'
import { 
  CheckCircle, 
  XCircle, 
  Clock, 
  ExternalLink,
  Zap,
  ArrowUpRight,
  ArrowDownRight
} from 'lucide-react'
import { Transaction } from '../types'

interface Props {
  transactions: Transaction[]
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleString('fr-FR', { 
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  })
}

function shortenSignature(sig: string): string {
  return `${sig.slice(0, 8)}...${sig.slice(-8)}`
}

export default function TransactionsLog({ transactions }: Props) {
  if (transactions.length === 0) {
    return (
      <div className="glass-card rounded-2xl p-12 text-center">
        <div className="w-16 h-16 rounded-full bg-dark-600 flex items-center justify-center mx-auto mb-4">
          <Clock className="w-8 h-8 text-gray-500" />
        </div>
        <h3 className="text-lg font-medium text-white mb-2">Aucune transaction</h3>
        <p className="text-gray-500">Les transactions apparaîtront ici après exécution</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {transactions.map((tx, index) => (
        <motion.div
          key={tx.id}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.05 }}
          className={`glass-card rounded-2xl p-5 border-l-4 ${
            tx.status === 'success' 
              ? 'border-l-accent-green' 
              : tx.status === 'failed' 
              ? 'border-l-accent-red' 
              : 'border-l-accent-blue'
          }`}
        >
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4">
              {/* Status Icon */}
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                tx.status === 'success' 
                  ? 'bg-accent-green/10' 
                  : tx.status === 'failed' 
                  ? 'bg-accent-red/10' 
                  : 'bg-accent-blue/10'
              }`}>
                {tx.status === 'success' ? (
                  <CheckCircle className="w-6 h-6 text-accent-green" />
                ) : tx.status === 'failed' ? (
                  <XCircle className="w-6 h-6 text-accent-red" />
                ) : (
                  <Clock className="w-6 h-6 text-accent-blue animate-pulse" />
                )}
              </div>

              {/* Transaction Info */}
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <span className="font-semibold text-white">{tx.pair}</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    tx.status === 'success' 
                      ? 'bg-accent-green/10 text-accent-green' 
                      : tx.status === 'failed' 
                      ? 'bg-accent-red/10 text-accent-red' 
                      : 'bg-accent-blue/10 text-accent-blue'
                  }`}>
                    {tx.status === 'success' ? 'Succès' : tx.status === 'failed' ? 'Échec' : 'En cours'}
                  </span>
                </div>
                <p className="text-sm text-gray-500">{formatTime(tx.timestamp)}</p>
                
                {/* Details */}
                {tx.details && (
                  <div className="flex items-center gap-4 mt-3">
                    {tx.details.flashAmount && (
                      <div className="flex items-center gap-1 text-sm">
                        <Zap className="w-4 h-4 text-accent-purple" />
                        <span className="text-gray-400">Flash:</span>
                        <span className="font-mono text-white">${tx.details.flashAmount.toLocaleString()}</span>
                      </div>
                    )}
                    {tx.details.buyDex && tx.details.sellDex && (
                      <div className="flex items-center gap-1 text-sm">
                        <ArrowUpRight className="w-4 h-4 text-accent-cyan" />
                        <span className="text-gray-400">Route:</span>
                        <span className="text-white">{tx.details.buyDex} → {tx.details.sellDex}</span>
                      </div>
                    )}
                    {tx.details.jitoTip && (
                      <div className="flex items-center gap-1 text-sm">
                        <ArrowDownRight className="w-4 h-4 text-accent-orange" />
                        <span className="text-gray-400">Jito:</span>
                        <span className="font-mono text-white">{tx.details.jitoTip} SOL</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Error message */}
                {tx.error && (
                  <div className="mt-3 p-3 rounded-lg bg-accent-red/10 border border-accent-red/20">
                    <p className="text-sm text-accent-red">{tx.error}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Right side - Profit and Signature */}
            <div className="text-right">
              {tx.profit !== 0 && (
                <p className={`text-2xl font-bold font-mono-num ${
                  tx.profit > 0 ? 'text-accent-green' : 'text-accent-red'
                }`}>
                  {tx.profit > 0 ? '+' : ''}{tx.profit.toLocaleString()}$
                </p>
              )}
              {tx.signature && (
                <a
                  href={`https://solscan.io/tx/${tx.signature}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-accent-purple hover:text-accent-cyan transition-colors mt-2 justify-end"
                >
                  <span className="text-sm font-mono">{shortenSignature(tx.signature)}</span>
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  )
}
