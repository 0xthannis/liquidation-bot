/**
 * Debug script to understand why Kamino obligation fetching fails
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { KaminoMarket, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import * as dotenv from 'dotenv';

dotenv.config();

const KAMINO_MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

async function debug() {
  const rpcUrl = process.env.HELIUS_RPC_URL || process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('No RPC URL found');
    return;
  }

  console.log('=== KAMINO DEBUG ===\n');
  console.log(`RPC: ${rpcUrl.substring(0, 40)}...`);
  console.log(`Program ID: ${PROGRAM_ID.toBase58()}`);
  console.log(`Market: ${KAMINO_MAIN_MARKET.toBase58()}\n`);

  const connection = new Connection(rpcUrl, 'confirmed');

  // Test 1: Basic RPC connectivity
  console.log('--- Test 1: RPC Connectivity ---');
  try {
    const slot = await connection.getSlot();
    console.log(`✅ Current slot: ${slot}`);
  } catch (e: any) {
    console.log(`❌ RPC failed: ${e.message}`);
    return;
  }

  // Test 2: Load market
  console.log('\n--- Test 2: Load Kamino Market ---');
  let market: KaminoMarket | null = null;
  try {
    market = await KaminoMarket.load(
      connection,
      KAMINO_MAIN_MARKET,
      undefined as any,
      PROGRAM_ID
    );
    console.log(`✅ Market loaded with ${market?.reserves.size} reserves`);
  } catch (e: any) {
    console.log(`❌ Market load failed: ${e.message}`);
  }

  // Test 3: Get program accounts WITHOUT any filter (just count)
  console.log('\n--- Test 3: Get ALL program accounts (no filter) ---');
  try {
    const allAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
      dataSlice: { offset: 0, length: 0 }, // Just get pubkeys, no data
    });
    console.log(`✅ Total accounts in Kamino program: ${allAccounts.length}`);
    
    if (allAccounts.length > 0) {
      // Sample first 100 accounts to check sizes
      console.log('\n--- Test 4: Sample account sizes ---');
      const sizeMap = new Map<number, number>();
      const sampled = allAccounts.slice(0, 100);
      
      for (const acc of sampled) {
        try {
          const info = await connection.getAccountInfo(acc.pubkey);
          if (info) {
            const size = info.data.length;
            sizeMap.set(size, (sizeMap.get(size) || 0) + 1);
          }
        } catch {
          // Skip
        }
      }
      
      console.log('Account sizes found (size -> count):');
      const sortedSizes = [...sizeMap.entries()].sort((a, b) => b[1] - a[1]);
      for (const [size, count] of sortedSizes.slice(0, 10)) {
        console.log(`  ${size} bytes: ${count} accounts`);
      }
      
      // Test 5: Try each size with market filter
      console.log('\n--- Test 5: Try getProgramAccounts with each size ---');
      for (const [size] of sortedSizes.slice(0, 5)) {
        try {
          const filtered = await connection.getProgramAccounts(PROGRAM_ID, {
            filters: [
              { dataSize: size },
              {
                memcmp: {
                  offset: 32,
                  bytes: KAMINO_MAIN_MARKET.toBase58(),
                },
              },
            ],
            dataSlice: { offset: 0, length: 0 },
          });
          console.log(`  Size ${size}: ${filtered.length} accounts for our market`);
          
          if (filtered.length > 0 && market) {
            // Try to parse one
            try {
              const obl = await market.getObligationByAddress(filtered[0].pubkey);
              console.log(`    ✅ Successfully parsed as obligation!`);
              console.log(`    Borrows: ${obl?.borrows?.size || 0}, Deposits: ${obl?.deposits?.size || 0}`);
            } catch (parseErr: any) {
              console.log(`    ❌ Parse failed: ${parseErr.message?.substring(0, 50)}`);
            }
          }
        } catch (e: any) {
          console.log(`  Size ${size}: Error - ${e.message?.substring(0, 40)}`);
        }
      }
    }
  } catch (e: any) {
    console.log(`❌ getProgramAccounts failed: ${e.message}`);
    console.log('   This might mean Helius blocks this call for large programs.');
  }

  // Test 6: Try SDK methods with detailed error logging
  if (market) {
    console.log('\n--- Test 6: SDK getAllObligationsForMarket ---');
    try {
      const obligations = await market.getAllObligationsForMarket();
      console.log(`✅ SDK found ${obligations.length} obligations`);
    } catch (e: any) {
      console.log(`❌ Failed: ${e}`);
      console.log(`   Error type: ${typeof e}`);
      console.log(`   Error message: ${e?.message}`);
      console.log(`   Error stack: ${e?.stack?.substring(0, 200)}`);
    }

    console.log('\n--- Test 7: SDK batchGetAllObligationsForMarket ---');
    try {
      const generator = market.batchGetAllObligationsForMarket();
      let count = 0;
      for await (const batch of generator) {
        count += batch.length;
        console.log(`  Batch received: ${batch.length} obligations`);
        if (count > 0) break; // Just test first batch
      }
      console.log(`✅ Batch method found ${count} obligations`);
    } catch (e: any) {
      console.log(`❌ Failed: ${e}`);
      console.log(`   Error type: ${typeof e}`);
      console.log(`   Error message: ${e?.message}`);
      console.log(`   Full error: ${JSON.stringify(e, null, 2)?.substring(0, 500)}`);
    }
  }

  console.log('\n=== DEBUG COMPLETE ===');
}

debug().catch(console.error);
