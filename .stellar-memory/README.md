# Project memory

This folder is a **stellar-memory** vault: a persistent, human-readable record of
what this Stellar project is and how its parts relate.

- `index.json` — the knowledge graph, for tooling and agents.
- `notes/` — one Markdown note per contract, function, deployment, task and doc.

Notes are also a valid Obsidian vault. Open this folder in Obsidian to see the
project as a graph.

## Editing

Every note has a machine-owned block:

```
<!-- stellar-memory:auto -->
...regenerated on every scan...
<!-- /stellar-memory:auto -->
```

Anything outside that block is yours and is never overwritten. Use it to record
the reasoning that source code cannot hold: why a design was chosen, what was
tried and rejected, what to be careful about.

Commit this folder. The value compounds as the project ages.
