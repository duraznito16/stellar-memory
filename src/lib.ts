/**
 * The programmatic surface: what `import { ... } from 'soroban-memory'` resolves to.
 *
 * It is the same scan the CLI runs and the same query functions the CLI and the
 * MCP server both read through, so a tool built on this cannot disagree with
 * `stellar memory resume` about the same project.
 *
 * What it is not: this is not the CLI. Nothing re-exported here parses argv,
 * prints, or exits. Nothing here writes either — `scanProject` returns a
 * ProjectMemory and stops, and the vault functions only read. Persisting a scan
 * stays behind the CLI because writing notes means merging prose a human owns,
 * and that is not a decision a library should make for its caller.
 */

export { scanProject } from './scanner/scan.js';
export type { ScanOptions, ScanOutcome } from './scanner/scan.js';

export { VAULT_DIR, findVaultRoot, loadMemory, tryLoadMemory, vaultPath } from './store/vault.js';

export {
  SIGNAL_CATEGORIES,
  architecture,
  contextDigest,
  neighbourhood,
  resumeReport,
  search,
  signals,
} from './core/query.js';
export type {
  ArchitectureView,
  Neighbourhood,
  ResumeReport,
  SearchHit,
  Signal,
  SignalCategory,
} from './core/query.js';

export { NODE_KINDS } from './core/types.js';
export type {
  AssetData,
  AuthOrigin,
  AuthSubjectData,
  ContractData,
  DeploymentData,
  EdgeKind,
  ErrorData,
  FunctionData,
  MemoryEdge,
  MemoryNode,
  NodeKind,
  ProjectMemory,
  Provenance,
  ScanRecord,
  StorageData,
  StorageDurability,
  TestData,
} from './core/types.js';
