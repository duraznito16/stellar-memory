/**
 * A deployment is a claim that a contract is live at an address on a network.
 * It is the only fact in the memory that cannot be checked by reading the repo,
 * so it is the one most worth guarding: nobody notices a missing deployment,
 * and everybody trusts one that is there.
 *
 * These tests read the committed demo vault as data. They need no network and
 * no mock of the Stellar CLI — the invariant is between two files that ship in
 * the repo, which is exactly why it can be asserted cheaply on every push.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(here, '..', 'demo', 'private-payroll');

interface Node {
  kind: string;
  title: string;
  summary?: string;
  data?: { network?: string; contractId?: string; drift?: string };
  provenance?: { command?: string; network?: string }[];
}

const memory = JSON.parse(
  readFileSync(path.join(demo, '.stellar-memory', 'index.json'), 'utf8'),
) as { nodes: Node[] };

const deployments = memory.nodes.filter((n) => n.kind === 'deployment');

/** Alias files key contract ids by network passphrase — the only local source that knows the network. */
function networksNamedByAliases(): Set<string> {
  const dir = path.join(demo, '.stellar', 'contract-ids');
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as {
      ids?: Record<string, string>;
    };
    for (const passphrase of Object.keys(parsed.ids ?? {})) {
      if (/Test SDF Network/i.test(passphrase)) names.add('testnet');
      else if (/Public Global Stellar Network/i.test(passphrase)) names.add('mainnet');
      else if (/Test SDF Future Network/i.test(passphrase)) names.add('futurenet');
      else names.add(passphrase);
    }
  }
  return names;
}

test('the demo is deployed somewhere, or these tests prove nothing', () => {
  assert.ok(deployments.length > 0, 'expected at least one deployment node in the demo vault');
});

test('no deployment claims a network the aliases never name', () => {
  // The bug this exists for: `stellar contract alias ls` prints the same
  // entries whatever STELLAR_NETWORK is set to, so scanning `-n testnet
  // mainnet` tagged testnet-only aliases as mainnet too. The scan then wrote
  // "Live at C... @ mainnet" for contracts that exist on testnet alone, on a
  // machine with no mainnet RPC configured — the read had errored, and the
  // note cited it as ground truth anyway.
  const allowed = networksNamedByAliases();
  for (const node of deployments) {
    assert.ok(
      allowed.has(node.data?.network ?? ''),
      `${node.title} claims network "${node.data?.network}", but the alias files only name ${[...allowed].join(', ')}`,
    );
  }
});

test('every deployment cites the read that answered for it', () => {
  // Citing `info hash` when only the interface came back sends a reader to a
  // command that will fail for them, which reads as the memory being wrong
  // about the contract rather than wrong about itself.
  for (const node of deployments) {
    const command = node.provenance?.[0]?.command ?? '';
    assert.match(
      command,
      /contract info (hash|meta|interface)/,
      `${node.title} should cite the specific read it got an answer from, got "${command}"`,
    );
    if (node.data?.drift === 'unknown') {
      assert.doesNotMatch(
        command,
        /contract info hash/,
        `${node.title} has no on-chain hash, so it must not cite \`info hash\` as its source`,
      );
    }
  }
});

test('a deployment always carries the address it is claiming', () => {
  for (const node of deployments) {
    assert.match(
      node.data?.contractId ?? '',
      /^C[A-Z2-7]{55}$/,
      `${node.title} must carry a well-formed contract id`,
    );
    assert.ok(
      node.summary?.includes(node.data?.contractId ?? ''),
      `${node.title} should name the address in its summary, so the claim is checkable`,
    );
  }
});
