/**
 * API Server - Expose bot stats for frontend (READ ONLY)
 * Runs on port 3001 alongside the bot
 */

import http from 'http';
import { EventEmitter } from 'events';

// Stats storage
export interface BotStats {
  totalProfit: number;
  totalProfitUsd: number;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  skippedTrades: number;
  todayProfit: number;
  walletBalance: number;
  botStatus: 'running' | 'stopped' | 'error';
  lastUpdate: string;
  scansToday: number;
  opportunitiesFound: number;
  trades: TradeRecord[];
}

export interface TradeRecord {
  id: string;
  timestamp: string;
  pair: string;
  amount: number;
  token: string;
  profit: number;
  profitUsd: number;
  status: 'success' | 'failed' | 'skipped' | 'not_profitable' | 'no_route' | 'simulation_failed';
  txHash?: string;
  reason?: string; // Detailed reason for status
  quoteIn?: number;
  quoteOut?: number;
}

// Global stats object
export const botStats: BotStats = {
  totalProfit: 0,
  totalProfitUsd: 0,
  totalTrades: 0,
  successfulTrades: 0,
  failedTrades: 0,
  skippedTrades: 0,
  todayProfit: 0,
  walletBalance: 0,
  botStatus: 'running',
  lastUpdate: new Date().toISOString(),
  scansToday: 0,
  opportunitiesFound: 0,
  trades: [],
};

// Event emitter for real-time updates
export const statsEmitter = new EventEmitter();

// Helper to add a trade
export function recordTrade(trade: Omit<TradeRecord, 'id' | 'timestamp'>) {
  const record: TradeRecord = {
    ...trade,
    id: Math.random().toString(36).substring(7),
    timestamp: new Date().toISOString(),
  };
  
  botStats.trades.unshift(record);
  if (botStats.trades.length > 100) {
    botStats.trades.pop(); // Keep only last 100
  }
  
  botStats.totalTrades++;
  botStats.lastUpdate = new Date().toISOString();
  
  if (trade.status === 'success') {
    botStats.successfulTrades++;
    botStats.totalProfit += trade.profit;
    botStats.totalProfitUsd += trade.profitUsd;
    botStats.todayProfit += trade.profitUsd;
    // Only count as "opportunity" if actually profitable
    if (trade.profitUsd > 0) {
      botStats.opportunitiesFound++;
    }
  } else if (trade.status === 'failed' || trade.status === 'simulation_failed') {
    botStats.failedTrades++;
  } else {
    botStats.skippedTrades++;
  }
  
  statsEmitter.emit('trade', record);
}

// Helper to update scan count
export function recordScan() {
  botStats.scansToday++;
  botStats.lastUpdate = new Date().toISOString();
}

// Helper to update wallet balance
export function updateWalletBalance(balance: number) {
  botStats.walletBalance = balance;
}

// Start API server
export function startApiServer(port: number = 3001) {
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    if (req.method === 'GET' && req.url === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...botStats,
        successRate: botStats.totalTrades > 0 
          ? (botStats.successfulTrades / botStats.totalTrades * 100).toFixed(1)
          : 0,
      }));
      return;
    }
    
    if (req.method === 'GET' && req.url === '/api/trades') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(botStats.trades));
      return;
    }
    
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }
    
    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  
  server.listen(port, '0.0.0.0', () => {
    console.log(`📡 API Server running on http://0.0.0.0:${port}`);
    console.log(`   GET /api/stats  - Bot statistics`);
    console.log(`   GET /api/trades - Recent trades`);
    console.log(`   GET /api/health - Health check\n`);
  });
  
  return server;
}
