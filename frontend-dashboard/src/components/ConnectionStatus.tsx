import { Wifi, WifiOff, Play, Pause } from 'lucide-react'
import { motion } from 'framer-motion'

interface Props {
  isConnected: boolean
  botStatus: 'running' | 'stopped' | 'error'
}

export default function ConnectionStatus({ isConnected, botStatus }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center justify-between glass-card rounded-2xl p-4"
    >
      <div className="flex items-center gap-4">
        {/* Connection indicator */}
        <div className="flex items-center gap-2">
          {isConnected ? (
            <>
              <div className="relative">
                <Wifi className="w-5 h-5 text-accent-green" />
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-accent-green rounded-full animate-pulse-live" />
              </div>
              <span className="text-sm text-accent-green font-medium">Connecté</span>
            </>
          ) : (
            <>
              <WifiOff className="w-5 h-5 text-accent-red" />
              <span className="text-sm text-accent-red font-medium">Déconnecté</span>
            </>
          )}
        </div>

        <div className="w-px h-6 bg-dark-600" />

        {/* Bot status */}
        <div className="flex items-center gap-2">
          {botStatus === 'running' ? (
            <>
              <div className="w-8 h-8 rounded-lg bg-accent-green/20 flex items-center justify-center">
                <Play className="w-4 h-4 text-accent-green fill-accent-green" />
              </div>
              <div>
                <span className="text-sm font-medium text-white">Bot actif</span>
                <p className="text-xs text-gray-500">Recherche d'opportunités</p>
              </div>
            </>
          ) : botStatus === 'stopped' ? (
            <>
              <div className="w-8 h-8 rounded-lg bg-accent-orange/20 flex items-center justify-center">
                <Pause className="w-4 h-4 text-accent-orange" />
              </div>
              <div>
                <span className="text-sm font-medium text-white">Bot en pause</span>
                <p className="text-xs text-gray-500">En attente</p>
              </div>
            </>
          ) : (
            <>
              <div className="w-8 h-8 rounded-lg bg-accent-red/20 flex items-center justify-center">
                <WifiOff className="w-4 h-4 text-accent-red" />
              </div>
              <div>
                <span className="text-sm font-medium text-white">Erreur</span>
                <p className="text-xs text-gray-500">Vérifiez les logs</p>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="text-right">
          <p className="text-xs text-gray-500">Mode</p>
          <p className="text-sm font-mono text-accent-purple">LIVE</p>
        </div>
        <div className="w-3 h-3 rounded-full bg-accent-green animate-pulse glow-green" />
      </div>
    </motion.div>
  )
}
