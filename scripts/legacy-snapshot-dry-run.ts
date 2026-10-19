import fs from 'node:fs';
import { inspectLegacySnapshot, legacyPreflightReport } from './legacy-snapshot-validation.js';

try {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--dry-run' || args[2] !== '--checksum' || args[4] !== '--revision'
    || !/^(0|[1-9][0-9]*)$/.test(args[5])) throw new Error('invalid_dry_run_arguments');
  const size = fs.statSync(args[1]).size;
  if (size > 64 * 1024 * 1024) throw new Error('snapshot_too_large');
  const bytes = fs.readFileSync(args[1]);
  if (bytes.length > 64 * 1024 * 1024) throw new Error('snapshot_too_large');
  // Preserve BOM as a character so JSON admission rejects it; never silently change archived bytes.
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  console.log(JSON.stringify(legacyPreflightReport(inspectLegacySnapshot(raw, args[3], Number(args[5]))), null, 2));
} catch (error) {
  const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'snapshot_read_failed';
  console.error(JSON.stringify({ passed: false, code }));
  process.exitCode = 1;
}
