import { Zap, Github, ExternalLink } from 'lucide-react'

export default function Header() {
  return (
    <header className="border-b border-dark-600 bg-dark-800/50 backdrop-blur-sm sticky top-0 z-50">
      <div className="container mx-auto px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-purple to-accent-cyan flex items-center justify-center">
            <Zap className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold gradient-text">Flash Arb</h1>
            <p className="text-xs text-gray-500">Arbitrage automatisé</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <a
            href="https://solscan.io"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400 hover:text-white transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            <span className="text-sm">Solscan</span>
          </a>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400 hover:text-white transition-colors"
          >
            <Github className="w-4 h-4" />
            <span className="text-sm">GitHub</span>
          </a>
        </div>
      </div>
    </header>
  )
}
