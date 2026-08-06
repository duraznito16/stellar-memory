import * as path from 'node:path';
import { tryLoadMemory } from '../store/vault.js';
import { DRIFT_LABEL, resumeReport } from '../core/query.js';
import { readGitInfo, humanAge } from '../core/git.js';
import { out, heading, subheading, dim, bold, green, yellow, cyan, warn, rule } from '../ui/out.js';

export interface ResumeOptions {
  cwd: string;
  json?: boolean;
}

/**
 * The command the whole tool exists for: a developer returns after two weeks and
 * needs their context back in one screen.
 */
export async function runResume(options: ResumeOptions): Promise<void> {
  const root = path.resolve(options.cwd);
  const memory = await tryLoadMemory(root);

  if (!memory) {
    warn('No vault here. Run `stellar-memory init` then `stellar-memory scan`.');
    process.exitCode = 1;
    return;
  }
  if (memory.nodes.length === 0) {
    warn('The vault is empty. Run `stellar-memory scan`.');
    process.exitCode = 1;
    return;
  }

  const now = new Date().toISOString();
  const report = resumeReport(memory, now);
  const git = await readGitInfo(root);

  // A briefing built on a stale index is worse than no briefing: it reads as
  // current and is not. Say so before anything else.
  const lastScan = memory.scans[memory.scans.length - 1];
  const scannedCommit = lastScan?.commit;
  if (git.isRepo && git.head && scannedCommit && git.head !== scannedCommit) {
    warn(
      `This memory was built at commit ${scannedCommit.slice(0, 7)} and HEAD is now ` +
        `${git.head.slice(0, 7)}. Run \`stellar-memory scan\` for a current picture.`,
    );
  }

  if (options.json) {
    out(JSON.stringify({ ...report, git: { branch: git.branch, head: git.head } }, null, 2));
    return;
  }

  out();
  heading(report.project);
  if (report.purpose) {
    out(report.purpose);
  }
  out();

  /* When you were last here ------------------------------------------ */
  if (git.isRepo && git.lastCommitDate) {
    const age = humanAge(git.lastCommitDate, now);
    out(`${dim('Last commit')}  ${bold(age)} ${dim(`on ${git.branch ?? 'HEAD'}`)}`);
    const head = git.recent[0];
    if (head) out(`${dim('           ')}  ${head.subject} ${dim(head.shortHash)}`);
  }
  if (git.dirty.length > 0) {
    out(`${dim('Uncommitted')}  ${yellow(`${git.dirty.length} file${git.dirty.length === 1 ? '' : 's'} modified`)}`);
  }
  out();

  /* Architecture ------------------------------------------------------ */
  subheading('Contracts');
  if (report.contracts.length === 0) {
    out(dim('  None detected. Is this a Soroban project?'));
  }
  for (const contract of report.contracts) {
    const deployed =
      contract.deployedOn.length > 0
        ? green(`  deployed: ${contract.deployedOn.join(', ')}`)
        : dim('  not deployed');
    out(`  ${cyan(contract.title.padEnd(22))} ${dim(`${contract.functions} fn`)}${deployed}`);
  }
  if (report.entryPoints.length > 0 && report.contracts.length > 1) {
    out();
    out(`  ${dim('Entry points:')} ${report.entryPoints.join(', ')}`);
  }
  out();

  /* On-chain ---------------------------------------------------------- */
  if (report.deployments.length > 0) {
    subheading('On-chain');
    for (const deployment of report.deployments) {
      const id = `${deployment.contractId.slice(0, 6)}…${deployment.contractId.slice(-4)}`;
      // An unlinked deployment is somebody else's contract: there is no local
      // build to compare it against, which is a different fact from a comparison
      // that was meant to happen and did not.
      const state =
        deployment.drift === 'stale'
          ? yellow('out of sync with local source')
          : deployment.drift === 'in-sync'
            ? green('matches local build')
            : dim(
                deployment.linked
                  ? `${DRIFT_LABEL.unknown} — no on-chain hash to compare`
                  : 'external dependency',
              );
      out(`  ${cyan((deployment.alias ?? id).padEnd(22))} ${dim(deployment.network.padEnd(9))} ${state}`);
      out(`  ${dim(' '.repeat(22))} ${dim(deployment.contractId)}`);
    }
    out();
  }

  /* What moved -------------------------------------------------------- */
  if (report.changedSinceLastScan.length > 0) {
    subheading(
      report.lastScanAge ? `Changed since your last scan (${report.lastScanAge})` : 'New in this scan',
    );
    for (const node of report.changedSinceLastScan.slice(0, 12)) {
      const where = node.path ? dim(` ${node.path}${node.line ? `:${node.line}` : ''}`) : '';
      out(`  ${dim(node.kind.padEnd(11))} ${node.title}${where}`);
    }
    const extra = report.changedSinceLastScan.length - 12;
    if (extra > 0) out(dim(`  …and ${extra} more`));
    out();
  }

  /* Recent history ---------------------------------------------------- */
  if (git.recent.length > 1) {
    subheading('Recent commits');
    for (const commit of git.recent.slice(0, 5)) {
      out(`  ${dim(commit.shortHash)} ${commit.subject} ${dim(`— ${humanAge(commit.date, now)}`)}`);
    }
    out();
  }

  /* Worth knowing ------------------------------------------------------ */
  const warnings = report.signals.filter((s) => s.severity === 'warn');
  if (warnings.length > 0) {
    subheading('Worth knowing');
    for (const signal of warnings.slice(0, 8)) {
      out(`  ${yellow('!')} ${signal.message}`);
    }
    const extra = warnings.length - 8;
    if (extra > 0) out(dim(`  …and ${extra} more`));
    out();
  }

  /* Pending ----------------------------------------------------------- */
  if (report.openTasks.length > 0) {
    subheading('Open tasks');
    for (const task of report.openTasks.slice(0, 8)) {
      out(`  ${dim('□')} ${task.title} ${dim(`${task.path}:${task.line}`)}`);
    }
    const extra = report.openTasks.length - 8;
    if (extra > 0) out(dim(`  …and ${extra} more`));
    out();
  }

  rule();
  out(
    `${dim('Ask about it:')} stellar-memory explain "how does the payment flow work?"\n` +
      `${dim('See the map: ')} stellar-memory graph`,
  );
  out();
}
