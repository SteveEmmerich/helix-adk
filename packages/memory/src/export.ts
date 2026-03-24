import type { MemoryManager } from "./manager.js";

export async function exportMemoryMd(memory: MemoryManager): Promise<string> {
  return memory.export();
}
