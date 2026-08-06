import * as path from 'node:path';
import { tryLoadMemory } from '../store/vault.js';
import { architecture, contextDigest, neighbourhood, search } from '../core/query.js';
import type { ContractData, DeploymentData, FunctionData } from '../core/types.js';
import { answerWithAi, AiUnavailable } from '../ai/explain.js';
import { out, heading, subheading, dim, bold, cyan, warn, rule, note } from '../ui/out.js';

export interface ExplainOptions {
  cwd: string;
  question?: string;
  ai?: boolean;
  json?: boolean;
}

export async function runExplain(options: ExplainOptions): Promise<void> {
  const root = path.resolve(options.cwd);
  const memory = await tryLoadMemory(root);
  if (!memory || memory.nodes.length === 0) {
    warn('Nothing to explain yet. Run `stellar-memory scan`.');
    process.exitCode = 1;
    return;
  }

  const question = (options.question ?? '').trim();

  if (!question) {
    if (options.json) {
      out(JSON.stringify({ digest: contextDigest(memory) }, null, 2));
      return;
    }
    printOverview(memory);
    return;
  }

  /* AI answer, when asked for and available -------------------------- */
  if (options.ai) {
    try {
      const answer = await answerWithAi(memory, question);
      if (options.json) {
        // A consumer reading this has no other signal that the prose was
        // generated rather than looked up.
        out(JSON.stringify({ ...answer, inferred: true }, null, 2));
        return;
      }
      out();
      // The label travels on stdout with the prose it describes, and leads it.
      // `explain --ai > notes.md` is a designed use of this command, and a file
      // holding model prose with its attribution stripped off is the one thing
      // this project exists not to produce. It also has to say *inferred*:
      // "from the local index" read as though the answer had been retrieved.
      out(dim(`  Inferred by ${answer.model} from the project digest — generated, not read.`));
      out();
      out(answer.text);
      out();
      return;
    } catch (error) {
      if (error instanceof AiUnavailable) {
        warn(error.message);
        note(dim('  Falling back to deterministic search.'));
      } else {
        throw error;
      }
    }
  }

  /* Deterministic answer --------------------------------------------- */
  const hits = search(memory, question, 8);

  if (options.json) {
    out(
      JSON.stringify(
        hits.map((h) => ({ id: h.node.id, kind: h.node.kind, title: h.node.title, path: h.node.path, why: h.reason })),
        null,
        2,
      ),
    );
    return;
  }

  out();
  if (hits.length === 0) {
    out(`Nothing in the memory matches ${bold(question)}.`);
    out();
    out(dim('  Try `stellar-memory explain` with no question for an overview,'));
    out(dim('  or `stellar-memory explain "..." --ai` for a prose answer.'));
    out();
    return;
  }

  heading(`Matches for "${question}"`);
  out();

  for (const hit of hits) {
    const node = hit.node;
    const where = node.path ? dim(`  ${node.path}${node.line ? `:${node.line}` : ''}`) : '';
    out(`${cyan('▸')} ${bold(node.title)} ${dim(`(${node.kind})`)}${where}`);
    if (node.summary) out(`  ${node.summary}`);

    // For the strongest match, show how it connects — that is usually the
    // actual question behind the question.
    if (hit === hits[0]) {
      const hood = neighbourhood(memory, node.id);
      const links = [...(hood?.outgoing ?? []), ...(hood?.incoming ?? [])].slice(0, 6);
      for (const link of links) {
        out(`    ${dim(link.edge.kind.padEnd(12))} ${link.node.title}`);
      }
    }
    out();
  }

  rule();
  out(dim('  Add --ai for a written answer grounded in this same index.'));
  out();
}

function printOverview(memory: Parameters<typeof contextDigest>[0]): void {
  const arch = architecture(memory);

  out();
  heading(memory.project.name);
  if (memory.project.purpose) {
    out(memory.project.purpose);
  }
  out();

  subheading('Architecture');
  if (arch.contracts.length === 0) {
    out(dim('  No Soroban contracts detected.'));
  }
  for (const contract of arch.contracts) {
    out();
    out(`  ${cyan('◆')} ${bold(contract.node.title)}${contract.crate ? dim(`  (${contract.crate})`) : ''}`);

    const data = contract.node.data as unknown as ContractData | undefined;
    if (data?.localWasmHash) out(`    ${dim('wasm')}      ${data.localWasmHash.slice(0, 16)}…`);

    for (const fn of contract.functions.slice(0, 8)) {
      const fd = fn.data as unknown as FunctionData | undefined;
      const params = (fd?.params ?? []).map((p) => `${p.name}: ${p.type}`).join(', ');
      const auth = fd?.requiresAuth ? dim('  🔒') : '';
      out(`    ${dim('fn')}        ${fn.title}(${params})${auth}`);
    }
    if (contract.functions.length > 8) {
      out(dim(`              …and ${contract.functions.length - 8} more`));
    }

    for (const call of contract.calls) {
      out(`    ${dim('calls')}     ${call.title}`);
    }
    for (const deployment of contract.deployments) {
      const dd = deployment.data as unknown as DeploymentData | undefined;
      out(`    ${dim('live')}      ${dd?.network} ${dim(String(dd?.contractId))}`);
    }
  }
  out();

  rule();
  out(dim('  Ask a question: stellar-memory explain "how does payment flow work?"'));
  out();
}
