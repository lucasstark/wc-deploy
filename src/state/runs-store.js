import {
  mkdirSync,
  rmdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  statSync
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STORE_DIR = join(homedir(), '.wc-deploy');
const STORE_FILE = join(STORE_DIR, 'runs.json');
const LOCK_DIR = join(STORE_DIR, 'runs.lock');
const TMP_FILE = join(STORE_DIR, 'runs.json.tmp');

const TERMINAL_STATUSES = new Set(['success', 'warning', 'failed', 'error', 'cancelled']);
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function readState() {
  if (!existsSync(STORE_FILE)) return { runs: [] };
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
  } catch {
    return { runs: [] };
  }
}

function writeState(data) {
  writeFileSync(TMP_FILE, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(TMP_FILE, STORE_FILE);
}

async function withLock(fn) {
  mkdirSync(STORE_DIR, { recursive: true });

  const startTime = Date.now();
  while (true) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Check for stale lock and reclaim if needed.
      try {
        const s = statSync(LOCK_DIR);
        if (Date.now() - s.mtimeMs > STALE_LOCK_MS) {
          try { rmdirSync(LOCK_DIR); } catch {}
          continue;
        }
      } catch {}
      if (Date.now() - startTime > LOCK_WAIT_MS) {
        throw new Error('Could not acquire lock on runs store (held > 10s)');
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  try {
    const data = readState();
    const result = await fn(data);
    writeState(data);
    return result;
  } finally {
    try { rmdirSync(LOCK_DIR); } catch {}
  }
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Insert or replace a deploy run for a given productId.
 * Status defaults to 'queued'.
 */
export async function recordDeploy({ slug, version, productId, cwd, status = 'queued', testRuns = null }) {
  return withLock(async (data) => {
    data.runs = data.runs.filter(r => !(r.kind === 'deploy' && r.productId === productId));
    const entry = {
      kind: 'deploy',
      slug,
      version,
      productId,
      cwd: cwd || process.cwd(),
      startedAt: nowIso(),
      lastCheckedAt: nowIso(),
      status,
      testRuns
    };
    data.runs.push(entry);
    return entry;
  });
}

/**
 * Add a QIT run entry.
 * Dedupes by qitRunId if provided.
 */
export async function recordQit({ slug, testType, version, qitRunId, qitResultUrl, cwd }) {
  return withLock(async (data) => {
    if (qitRunId) {
      data.runs = data.runs.filter(r => !(r.kind === 'qit' && r.qitRunId === qitRunId));
    }
    const entry = {
      kind: 'qit',
      slug,
      version,
      testType,
      qitRunId: qitRunId || null,
      qitResultUrl: qitResultUrl || null,
      cwd: cwd || process.cwd(),
      startedAt: nowIso(),
      lastCheckedAt: nowIso(),
      status: 'queued'
    };
    data.runs.push(entry);
    return entry;
  });
}

/**
 * Patch entries matching the given predicate.
 * predicate: (run) => boolean
 * updates: shallow merge into the matched runs.
 */
export async function updateRuns(predicate, updates) {
  return withLock(async (data) => {
    let count = 0;
    for (const run of data.runs) {
      if (predicate(run)) {
        Object.assign(run, updates, { lastCheckedAt: nowIso() });
        count++;
      }
    }
    return count;
  });
}

/**
 * List runs, optionally filtered.
 * filter: { kind?, terminal?: boolean, productId? }
 */
export async function listRuns(filter = {}) {
  // Reads don't strictly need the lock, but going through it keeps semantics simple.
  return withLock(async (data) => {
    return data.runs.filter(r => {
      if (filter.kind && r.kind !== filter.kind) return false;
      if (filter.productId && r.productId !== filter.productId) return false;
      if (filter.terminal === true && !isTerminalStatus(r.status)) return false;
      if (filter.terminal === false && isTerminalStatus(r.status)) return false;
      return true;
    });
  });
}

/**
 * Remove entries matching the predicate.
 * Returns the number removed.
 */
export async function removeRuns(predicate) {
  return withLock(async (data) => {
    const before = data.runs.length;
    data.runs = data.runs.filter(r => !predicate(r));
    return before - data.runs.length;
  });
}

export const PATHS = {
  STORE_DIR,
  STORE_FILE
};
