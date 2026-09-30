import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SimulationState } from './types.js';

export type DatabaseRecoveryRecord = {
  format: 1;
  revision: number;
  writtenAt: string;
  checksum: string;
  state: SimulationState;
};

const checksum = (state: SimulationState) => crypto
  .createHash('sha256')
  .update(JSON.stringify(state))
  .digest('hex');

export function databaseRecoveryDirectory(databaseFile: string, environment: NodeJS.ProcessEnv = process.env) {
  return environment.DATABASE_RECOVERY_DIR
    ? path.resolve(environment.DATABASE_RECOVERY_DIR)
    : `${databaseFile}.recovery`;
}

function recoveryFiles(directory: string) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^recovery-\d+-\d+-[a-f0-9]{12}\.json$/.test(name))
    .sort()
    .reverse();
}

function syncDirectory(directory: string) {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch {
    // Directory fsync is not supported by every Windows/filesystem combination.
  }
}

export function writeDatabaseRecoveryRecord(
  directory: string,
  state: SimulationState,
  retention = 20,
  now = new Date(),
) {
  const revision = Math.max(0, Number(state.settings?.databaseRevision || 0));
  const stateChecksum = checksum(state);
  const record: DatabaseRecoveryRecord = {
    format: 1,
    revision,
    writtenAt: now.toISOString(),
    checksum: stateChecksum,
    state,
  };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fileName = `recovery-${String(revision).padStart(16, '0')}-${now.getTime()}-${stateChecksum.slice(0, 12)}.json`;
  const target = path.join(directory, fileName);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(record), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* Preserve the original error. */ }
    throw error;
  }

  const keep = Math.max(2, Math.floor(retention));
  for (const staleName of recoveryFiles(directory).slice(keep)) {
    try {
      fs.unlinkSync(path.join(directory, staleName));
    } catch {
      // Retention cleanup must not turn an already durable commit into a failure.
    }
  }
  return target;
}

export function readLatestDatabaseRecoveryRecord(directory: string): DatabaseRecoveryRecord | null {
  for (const name of recoveryFiles(directory)) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as DatabaseRecoveryRecord;
      if (record.format !== 1 || !record.state || !Number.isFinite(record.revision)) continue;
      if (record.revision !== Math.max(0, Number(record.state.settings?.databaseRevision || 0))) continue;
      if (record.checksum !== checksum(record.state)) continue;
      return record;
    } catch {
      // A corrupt newest record must not hide an older verified recovery point.
    }
  }
  return null;
}
