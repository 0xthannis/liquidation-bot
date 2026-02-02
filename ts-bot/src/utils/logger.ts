/**
 * Logger utility with timestamp and colored output
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function getTimestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

export function debug(message: string, ...args: any[]): void {
  if (currentLevel <= LogLevel.DEBUG) {
    console.log(`[${getTimestamp()}] 🔍 ${message}`, ...args);
  }
}

export function info(message: string, ...args: any[]): void {
  if (currentLevel <= LogLevel.INFO) {
    console.log(`[${getTimestamp()}] ${message}`, ...args);
  }
}

export function warn(message: string, ...args: any[]): void {
  if (currentLevel <= LogLevel.WARN) {
    console.warn(`[${getTimestamp()}] ⚠️  ${message}`, ...args);
  }
}

export function error(message: string, ...args: any[]): void {
  if (currentLevel <= LogLevel.ERROR) {
    console.error(`[${getTimestamp()}] ❌ ${message}`, ...args);
  }
}

export function success(message: string, ...args: any[]): void {
  console.log(`[${getTimestamp()}] ✅ ${message}`, ...args);
}

export function opportunity(message: string, ...args: any[]): void {
  console.log(`[${getTimestamp()}] 🎯 ${message}`, ...args);
}

export function scan(message: string, ...args: any[]): void {
  if (currentLevel <= LogLevel.DEBUG) {
    console.log(`[${getTimestamp()}] 🔍 ${message}`, ...args);
  }
}

export function stats(message: string, ...args: any[]): void {
  console.log(`[${getTimestamp()}] 📊 ${message}`, ...args);
}

export function money(message: string, ...args: any[]): void {
  console.log(`[${getTimestamp()}] 💰 ${message}`, ...args);
}

export const logger = {
  debug,
  info,
  warn,
  error,
  success,
  opportunity,
  scan,
  stats,
  money,
  setLogLevel,
};
