import { Connection, ConnectionConfig } from '@solana/web3.js';

/**
 * ThrottledConnection - Rate-limited RPC connection for free tier RPCs
 * Max 20 requests per second with queue management
 */
export class ThrottledConnection {
  private connection: Connection;
  private requestQueue: Array<() => Promise<any>> = [];
  private processing = false;
  private lastRequestTime = 0;
  private readonly minDelay: number;
  private requestCount = 0;
  private windowStart = Date.now();

  constructor(
    endpoint: string,
    maxRequestsPerSecond: number = 20,
    config?: ConnectionConfig
  ) {
    this.connection = new Connection(endpoint, config || 'confirmed');
    this.minDelay = Math.ceil(1000 / maxRequestsPerSecond);
    console.log(`⚡ ThrottledConnection: ${maxRequestsPerSecond} req/sec (${this.minDelay}ms delay)`);
  }

  get raw(): Connection {
    return this.connection;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.requestQueue.length > 0) {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      
      if (elapsed < this.minDelay) {
        await this.sleep(this.minDelay - elapsed);
      }

      const request = this.requestQueue.shift();
      if (request) {
        this.lastRequestTime = Date.now();
        this.requestCount++;
        
        // Reset counter every second
        if (now - this.windowStart > 1000) {
          this.windowStart = now;
          this.requestCount = 0;
        }

        try {
          await request();
        } catch (e) {
          // Error handled by the wrapped promise
        }
      }
    }

    this.processing = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
      this.processQueue();
    });
  }

  // Wrap common Connection methods with throttling
  async getAccountInfo(...args: Parameters<Connection['getAccountInfo']>) {
    return this.enqueue(() => this.connection.getAccountInfo(...args));
  }

  async getMultipleAccountsInfo(...args: Parameters<Connection['getMultipleAccountsInfo']>) {
    return this.enqueue(() => this.connection.getMultipleAccountsInfo(...args));
  }

  async getProgramAccounts(...args: Parameters<Connection['getProgramAccounts']>) {
    return this.enqueue(() => this.connection.getProgramAccounts(...args));
  }

  async getBalance(...args: Parameters<Connection['getBalance']>) {
    return this.enqueue(() => this.connection.getBalance(...args));
  }

  async getLatestBlockhash(...args: Parameters<Connection['getLatestBlockhash']>) {
    return this.enqueue(() => this.connection.getLatestBlockhash(...args));
  }

  async sendTransaction(...args: Parameters<Connection['sendTransaction']>) {
    // Priority: Don't throttle transaction sending
    return this.connection.sendTransaction(...args);
  }

  async sendRawTransaction(...args: Parameters<Connection['sendRawTransaction']>) {
    // Priority: Don't throttle transaction sending
    return this.connection.sendRawTransaction(...args);
  }

  async confirmTransaction(...args: Parameters<Connection['confirmTransaction']>) {
    return this.enqueue(() => this.connection.confirmTransaction(...args));
  }

  async getTokenAccountBalance(...args: Parameters<Connection['getTokenAccountBalance']>) {
    return this.enqueue(() => this.connection.getTokenAccountBalance(...args));
  }

  async getTokenAccountsByOwner(...args: Parameters<Connection['getTokenAccountsByOwner']>) {
    return this.enqueue(() => this.connection.getTokenAccountsByOwner(...args));
  }

  getQueueSize(): number {
    return this.requestQueue.length;
  }

  getRequestsInWindow(): number {
    return this.requestCount;
  }
}
