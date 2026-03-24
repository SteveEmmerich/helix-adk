# @helix/security

Security utilities for Helix ADK: credential vault, leak detection, DLP, and per-tool allowlists. Designed to be used independently by core, gateway, and skills.

## Usage

```ts
import { CredentialVault, DLP, LeakScanner, AllowlistManager } from "@helix/security";

const vault = new CredentialVault({ dbPath: "/tmp/vault.db" });
await vault.init();

const allowlist = new AllowlistManager({ db: vault.db });
const dlp = new DLP(new LeakScanner(), allowlist, { db: vault.db });
```

## Features

- AES-256-GCM encrypted credential storage
- Leak scanning with redaction
- DLP approvals and allowlists
