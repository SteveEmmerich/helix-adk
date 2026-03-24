# @helix/memory

Persistent, multi-tier memory for Helix ADK agents. Provides semantic facts, episodic history, deep knowledge search, and procedural memory with hybrid search support.

## Usage

```ts
import { MemoryManager, NullEmbeddingProvider } from "@helix/memory";

const memory = new MemoryManager({
  dbPath: "/tmp/helix-memory.db",
  embeddingProvider: new NullEmbeddingProvider(),
});

await memory.init();
const ctx = await memory.loadContext();
```

## Features

- Tier 1 facts, Tier 2 episodes, Tier 3 deep knowledge, Tier 4 procedures
- Hybrid vector + FTS5 search (sqlite-vec if available)
- Recall/remember tools integration for agents
