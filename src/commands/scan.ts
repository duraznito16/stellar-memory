import * as path from 'node:path';
import { scanProject } from '../scanner/scan.js';
import { isInitialised, saveMemory, tryLoadMemory } from '../store/vault.js';
import { out, success, warn, dim, progressReporter, bold } from '../ui/out.js';

export interface ScanOptions {
  cwd: string;
  offline?: boolean;
  network?: string[];
  quiet?: boolean;
}

export async function runScan(options: ScanOptions): Promise<void> {
  const root = path.resolve(options.cwd);

  if (!(await isInitialised(root))) {
    warn('No vault here yet. Run `stellar-memory init` first.');
    process.exitCode = 1;
    return;
  }

  const previous = await tryLoadMemory(root);
  const started = Date.now();

  const { memory, stats } = await scanProject({
    root,
    now: new Date().toISOString(),
    online: !options.offline,
    networks: options.network,
    previous,
    onProgress: progressReporter(options.quiet ?? false),
  });

  const { notes, stale } = await saveMemory(memory);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const last = memory.scans[memory.scans.length - 1];
  const changed = last?.changed.length ?? 0;

  out();
  success(
    `Scanned ${bold(String(stats.filesSeen))} files in ${elapsed}s ` +
      `${dim(`(${stats.rustFiles} Rust)`)}`,
  );
  out();
  out(`  ${bold(String(stats.contracts))} contracts`);
  out(`  ${bold(String(memory.nodes.length))} nodes, ${bold(String(memory.edges.length))} relationships`);
  if (stats.deployments > 0) out(`  ${bold(String(stats.deployments))} live deployments linked`);
  out(`  ${bold(String(notes))} notes written`);
  if (stale > 0) {
    out(`  ${bold(String(stale))} notes marked stale ${dim('(kept, not deleted)')}`);
  }
  if (previous && previous.nodes.length > 0) {
    out(`  ${bold(String(changed))} changed since the last scan`);
  }
  out();

  for (const message of stats.warnings) warn(message);
  if (stats.warnings.length > 0) out();

  out(`  ${dim('Next:')} stellar-memory resume`);
  out();
}
