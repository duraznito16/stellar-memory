/**
 * Terminal presentation.
 *
 * Output goes to stdout for content and stderr for progress, so that
 * `stellar-memory explain ... > notes.md` captures the answer and nothing else.
 */

import pc from 'picocolors';

export const out = (line = '') => process.stdout.write(`${line}\n`);
export const note = (line = '') => process.stderr.write(`${line}\n`);

export const heading = (text: string) => out(pc.bold(pc.cyan(text)));
export const subheading = (text: string) => out(pc.bold(text));
export const dim = (text: string) => pc.dim(text);
export const bold = (text: string) => pc.bold(text);
export const green = (text: string) => pc.green(text);
export const yellow = (text: string) => pc.yellow(text);
export const red = (text: string) => pc.red(text);
export const cyan = (text: string) => pc.cyan(text);

export function rule(width = 60): void {
  out(pc.dim('─'.repeat(width)));
}

export function bullet(text: string, indent = 0): void {
  out(`${' '.repeat(indent)}${pc.dim('•')} ${text}`);
}

export function keyValue(key: string, value: string, pad = 14): void {
  out(`  ${pc.dim(key.padEnd(pad))} ${value}`);
}

export function progressReporter(quiet: boolean) {
  return (message: string) => {
    if (!quiet) note(pc.dim(`  ${message}…`));
  };
}

export function warn(message: string): void {
  note(`${pc.yellow('!')} ${message}`);
}

export function fail(message: string): void {
  note(`${pc.red('✖')} ${message}`);
}

export function success(message: string): void {
  note(`${pc.green('✔')} ${message}`);
}

/** Render a simple two-column table that stays readable when values are long. */
export function table(rows: [string, string][], indent = 2): void {
  const width = rows.reduce((max, [k]) => Math.max(max, k.length), 0);
  for (const [k, v] of rows) {
    out(`${' '.repeat(indent)}${pc.dim(k.padEnd(width))}  ${v}`);
  }
}
