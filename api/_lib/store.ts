// Contracts live in Redis once deployed — realContracts.ts is only the
// SEED data, used the very first time the Redis key is empty. After
// that, Redis is the source of truth; the commissioner screen and sync
// write here, not to the generated file.
//
// NOTE: this used to use @vercel/kv, which expects KV_REST_API_URL /
// KV_REST_API_TOKEN env vars. Vercel's Storage marketplace has since
// moved to provisioning plain Redis (via Upstash's Redis integration,
// not their REST-based KV product), which only gives you REDIS_URL — a
// standard connection string. This version uses the plain `redis`
// client against that instead.
import { createClient, type RedisClientType } from 'redis';
import { realContracts } from '../../src/data/realContracts.js';
import type { Contract } from '../../src/lib/contracts';

const KEY = 'ftfl:contracts';

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;

async function getClient(): Promise<RedisClientType> {
  if (client && client.isOpen) return client;
  if (!connecting) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL is not set on the server');
    const c: RedisClientType = createClient({ url });
    c.on('error', (err: any) => console.error('Redis client error:', err?.message));
    connecting = c.connect().then(() => {
      client = c;
      return c;
    });
  }
  return connecting;
}

export async function getAllContracts(): Promise<Contract[]> {
  try {
    const c = await getClient();
    const raw = await c.get(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (err: any) {
    // Redis not configured/reachable — fall through to seed data so the
    // app still works read-only.
    console.error('Redis read failed, falling back to seed data:', err?.message);
  }
  return realContracts;
}

export async function saveAllContracts(contracts: Contract[]): Promise<Contract[]> {
  if (!Array.isArray(contracts)) {
    throw new Error('contracts must be an array');
  }
  const c = await getClient();
  await c.set(KEY, JSON.stringify(contracts));
  return contracts;
}

// Generic JSON get/set for anything else that needs to live in Redis —
// currently just league history (api/compute-league-history.ts), kept
// under its own key so it's independent of the contracts data entirely.
export async function getJSON<T>(key: string): Promise<T | null> {
  try {
    const c = await getClient();
    const raw = await c.get(key);
    if (raw) return JSON.parse(raw) as T;
  } catch (err: any) {
    console.error(`Redis read failed for ${key}:`, err?.message);
  }
  return null;
}

export async function setJSON<T>(key: string, value: T): Promise<void> {
  const c = await getClient();
  await c.set(key, JSON.stringify(value));
}
