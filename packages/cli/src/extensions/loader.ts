/**
 * Extension loader — discovers and manages hlx extensions
 *
 * Resolution order (matches Node module resolution intuition):
 * 1. Project-local: .hlx/extensions/*.ts or .hlx/extensions/<name>/index.ts
 * 2. Global:        $HOME/.hlx/extensions/*.ts
 * 3. npm packages:  listed in hlx.config.ts `extensions: ["@helix/ext-github", "./my-ext"]`
 *
 * Hot-reload:
 * - Local .ts files are watched with chokidar
 * - On change: teardown() old instance → re-import via cache-busted URL → setup() new instance
 * - npm packages require `hlx reload <package>` (can't watch node_modules safely)
 */

import { existsSync, watch as fsWatch } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext, HelixConfig, HelixExtension } from "./types.js";

export interface LoadedExtension {
  readonly id: string;
  readonly ext: HelixExtension;
  readonly source: string;
  readonly loadedAt: number;
  isLocal: boolean;
}

export type ExtensionLoaderEvent =
  | { type: "loaded"; id: string; name: string }
  | { type: "reloaded"; id: string; name: string }
  | { type: "unloaded"; id: string }
  | { type: "error"; id: string; error: Error };

export type ExtensionLoaderListener = (event: ExtensionLoaderEvent) => void;

export class ExtensionLoader {
  readonly #loaded: Map<string, LoadedExtension> = new Map();
  readonly #watchers: Map<string, ReturnType<typeof fsWatch>> = new Map();
  readonly #listeners: Set<ExtensionLoaderListener> = new Set();
  readonly #config: HelixConfig;
  readonly #cwd: string;

  constructor(config: HelixConfig, cwd = process.cwd()) {
    this.#config = config;
    this.#cwd = cwd;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  onEvent(listener: ExtensionLoaderListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get extensions(): readonly LoadedExtension[] {
    return Array.from(this.#loaded.values());
  }

  /** Discover and load all extensions from all sources */
  async loadAll(): Promise<void> {
    const sources = await this.#discoverSources();
    await Promise.allSettled(sources.map((s) => this.#loadSource(s)));
  }

  /** Force reload a specific extension by id */
  async reload(id: string): Promise<boolean> {
    const existing = this.#loaded.get(id);
    if (!existing) return false;
    await this.#teardown(id);
    await this.#loadSource(existing.source);
    return true;
  }

  /** Reload all local extensions (triggered by /reload) */
  async reloadLocal(): Promise<string[]> {
    const local = Array.from(this.#loaded.values()).filter((e) => e.isLocal);
    const reloaded: string[] = [];
    for (const ext of local) {
      const ok = await this.reload(ext.id);
      if (ok) reloaded.push(ext.id);
    }
    return reloaded;
  }

  /** Teardown all and stop watchers */
  async unloadAll(): Promise<void> {
    for (const id of this.#loaded.keys()) {
      await this.#teardown(id);
    }
    for (const watcher of this.#watchers.values()) {
      watcher.close();
    }
    this.#watchers.clear();
  }

  // ─── Discovery ──────────────────────────────────────────────────────────────

  async #discoverSources(): Promise<string[]> {
    const sources: string[] = [];

    // 1. Config-declared extensions (highest priority)
    if (this.#config.extensions) {
      for (const ext of this.#config.extensions) {
        sources.push(ext);
      }
    }

    // 2. Project-local .hlx/extensions/
    const localDir = join(this.#cwd, ".hlx", "extensions");
    if (existsSync(localDir)) {
      const files = await readdir(localDir, { withFileTypes: true });
      for (const f of files) {
        if (f.isFile() && (f.name.endsWith(".ts") || f.name.endsWith(".js"))) {
          sources.push(join(localDir, f.name));
        } else if (f.isDirectory()) {
          const idx = join(localDir, f.name, "index.ts");
          if (existsSync(idx)) sources.push(idx);
        }
      }
    }

    // 3. Global ~/.hlx/extensions/
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const globalDir = join(homeDir, ".hlx", "extensions");
    if (existsSync(globalDir)) {
      const files = await readdir(globalDir, { withFileTypes: true });
      for (const f of files) {
        if (f.isFile() && (f.name.endsWith(".ts") || f.name.endsWith(".js"))) {
          const fullPath = join(globalDir, f.name);
          if (!sources.includes(fullPath)) sources.push(fullPath);
        }
      }
    }

    return [...new Set(sources)]; // deduplicate
  }

  // ─── Loading ─────────────────────────────────────────────────────────────────

  async #loadSource(source: string): Promise<void> {
    const id = this.#sourceToId(source);
    const isLocal = source.startsWith("/") || source.startsWith(".");

    try {
      const ext = await this.#importExtension(source, isLocal);
      const ctx = this.#makeContext();

      if (ext.setup) {
        const result = await ext.setup(ctx);
        if (result === false) {
          this.#emit({
            type: "error",
            id,
            error: new Error(`Extension ${id} setup() returned false`),
          });
          return;
        }
      }

      const loaded: LoadedExtension = {
        id,
        ext,
        source,
        loadedAt: Date.now(),
        isLocal,
      };

      const wasLoaded = this.#loaded.has(id);
      this.#loaded.set(id, loaded);

      this.#emit({ type: wasLoaded ? "reloaded" : "loaded", id, name: ext.name });

      // Watch local files for hot-reload
      if (isLocal) {
        this.#watchFile(source, id);
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.#emit({ type: "error", id, error });
    }
  }

  async #importExtension(source: string, isLocal: boolean): Promise<HelixExtension> {
    let importPath: string;

    if (isLocal) {
      // Cache-bust with timestamp for hot-reload
      const absPath = resolve(this.#cwd, source);
      importPath = `${pathToFileURL(absPath).href}?t=${Date.now()}`;
    } else {
      // npm package — resolve from cwd
      const req = createRequire(join(this.#cwd, "package.json"));
      importPath = req.resolve(source);
      importPath = pathToFileURL(importPath).href;
    }

    const mod = (await import(importPath)) as { default?: HelixExtension };
    const ext = mod.default;

    if (!ext || typeof ext !== "object" || !ext.name) {
      throw new Error(`Extension at "${source}" must export a HelixExtension as default`);
    }

    return ext;
  }

  async #teardown(id: string): Promise<void> {
    const loaded = this.#loaded.get(id);
    if (!loaded) return;

    try {
      await loaded.ext.teardown?.();
    } catch {
      // Ignore teardown errors
    }

    this.#loaded.delete(id);
    this.#emit({ type: "unloaded", id });

    // Stop watcher
    const watcher = this.#watchers.get(id);
    if (watcher) {
      watcher.close();
      this.#watchers.delete(id);
    }
  }

  // ─── File watching ───────────────────────────────────────────────────────────

  #watchFile(filePath: string, id: string): void {
    // Clean up existing watcher
    this.#watchers.get(id)?.close();

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const watcher = fsWatch(filePath, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        await this.#teardown(id);
        await this.#loadSource(filePath);
      }, 150); // debounce rapid saves
    });

    watcher.on("error", (err) => {
      this.#emit({ type: "error", id, error: err });
    });

    this.#watchers.set(id, watcher);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  #sourceToId(source: string): string {
    // npm package → use package name
    if (!source.startsWith("/") && !source.startsWith(".")) return source;
    // Local file → use relative path from cwd
    return source
      .replace(this.#cwd, "")
      .replace(/^\//, "")
      .replace(/\.(ts|js)$/, "");
  }

  #makeContext(): ExtensionContext {
    return {
      config: this.#config,
      version: "0.1.0",
      log: (msg, data) => {
        if (process.env.HELIX_DEBUG) {
          console.error(`[hlx:ext] ${msg}`, data ?? "");
        }
      },
    };
  }

  #emit(event: ExtensionLoaderEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
