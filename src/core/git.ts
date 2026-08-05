/**
 * Git as a source of memory.
 *
 * "What happened while I was away" is the single most valuable thing a returning
 * developer wants, and git already knows it. Everything here is read-only and
 * degrades to nothing when the project is not a repository.
 */

import { execFile } from 'node:child_process';

export interface Commit {
  hash: string;
  shortHash: string;
  date: string;
  author: string;
  subject: string;
}

export interface GitInfo {
  isRepo: boolean;
  head?: string;
  branch?: string;
  lastCommitDate?: string;
  /** Files with uncommitted modifications. */
  dirty: string[];
  recent: Commit[];
}

/** Unit separator: cannot occur in a commit subject, so splitting is unambiguous. */
const SEP = '\x1f';
const LOG_FORMAT = ['%H', '%h', '%ad', '%an', '%s'].join(SEP);

function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : (stdout ?? '')),
    );
  });
}

function parseLog(raw: string | null): Commit[] {
  const out: Commit[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    const [hash, shortHash, date, author, subject] = line.split(SEP);
    if (hash && shortHash && date) {
      out.push({ hash, shortHash, date, author: author ?? '', subject: subject ?? '' });
    }
  }
  return out;
}

export async function readGitInfo(root: string, recentLimit = 15): Promise<GitInfo> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside === null || inside.trim() !== 'true') {
    return { isRepo: false, dirty: [], recent: [] };
  }

  const [head, branch, log, status] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['log', `-${recentLimit}`, '--date=iso-strict', `--pretty=format:${LOG_FORMAT}`]),
    git(root, ['status', '--porcelain']),
  ]);

  const recent = parseLog(log);

  const dirty = (status ?? '')
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  return {
    isRepo: true,
    head: head?.trim() || undefined,
    branch: branch?.trim() || undefined,
    lastCommitDate: recent[0]?.date,
    dirty,
    recent,
  };
}

/** Commits touching the tree since a given ISO timestamp. */
export async function commitsSince(root: string, sinceIso: string): Promise<Commit[]> {
  return parseLog(
    await git(root, ['log', `--since=${sinceIso}`, '--date=iso-strict', `--pretty=format:${LOG_FORMAT}`]),
  );
}

/** Files changed between two commits, repo-relative. */
export async function changedFiles(root: string, fromRef: string, toRef = 'HEAD'): Promise<string[]> {
  const out = await git(root, ['diff', '--name-only', `${fromRef}..${toRef}`]);
  if (out === null) return [];
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.floor((to - from) / 86_400_000);
}

/** "14 days ago", "yesterday", "today" — for human-facing output. */
export function humanAge(fromIso: string, nowIso: string): string {
  const days = daysBetween(fromIso, nowIso);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return 'a month ago';
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}
