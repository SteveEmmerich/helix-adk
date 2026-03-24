import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  AllowlistManager,
  CredentialVault,
  DLP,
  LeakScanner,
  redact,
  wrapToolWithSecurity,
  type LeakApprovalRequest,
  type SecurityConfig,
} from "@helix/security";

function makeVault(passphrase = "test-pass") {
  const db = new Database(":memory:");
  return new CredentialVault({ sharedDb: db, passphrase });
}

describe("CredentialVault", () => {
  test("store without init returns err", async () => {
    const vault = makeVault();
    const result = await vault.store("test_key", "super-secret", { type: "api_key" });
    expect(result.ok).toBeFalse();
  });

  test("store encrypts and retrieve decrypts", async () => {
    const vault = makeVault();
    await vault.init();
    const result = await vault.store("test_key", "super-secret", { type: "api_key" });
    expect(result.ok).toBeTrue();
    const row = vault.db
      .query("SELECT encrypted_value FROM vault_credentials WHERE name = ?")
      .get("test_key") as { encrypted_value: string };
    expect(row.encrypted_value).not.toContain("super-secret");
    const retrieved = await vault.retrieve("test_key", "bash");
    expect(retrieved.ok).toBeTrue();
    if (retrieved.ok) expect(retrieved.value).toBe("super-secret");
  });

  test("retrieve with wrong passphrase returns err", async () => {
    const vault = makeVault("pass-1");
    await vault.init();
    await vault.store("test_key", "value", { type: "api_key" });
    const other = makeVault("pass-2");
    await other.init();
    const retrieved = await other.retrieve("test_key");
    expect(retrieved.ok).toBeFalse();
  });

  test("list returns metadata only", async () => {
    const vault = makeVault();
    await vault.init();
    await vault.store("test_key", "secret", { type: "api_key" });
    const list = vault.list();
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe("test_key");
    // @ts-expect-error ensure no value field is present
    expect(list[0]?.value).toBeUndefined();
  });

  test("allowed_tools enforcement", async () => {
    const vault = makeVault();
    await vault.init();
    await vault.store("test_key", "secret", { allowedTools: ["safe_tool"] });
    const denied = await vault.retrieve("test_key", "bash");
    expect(denied.ok).toBeFalse();
    const allowed = await vault.retrieve("test_key", "safe_tool");
    expect(allowed.ok).toBeTrue();
  });

  test("inject replaces placeholders", async () => {
    const vault = makeVault();
    await vault.init();
    await vault.store("api", "sekret", { type: "api_key" });
    const input = { env: { API_KEY: "{{api}}" } };
    const injected = (await vault.inject(input, "call_api")) as { env: { API_KEY: string } };
    expect(injected.env.API_KEY).toBe("sekret");
  });

  test("audit log written for reads", async () => {
    const vault = makeVault();
    await vault.init();
    await vault.store("test_key", "secret", { type: "api_key" });
    await vault.retrieve("test_key", "bash");
    const audit = vault.audit(10);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((entry) => entry.action === "injected")).toBeTrue();
  });

  test("different IVs used for each store", async () => {
    const vault = makeVault();
    await vault.init();
    await vault.store("k1", "same", { type: "api_key" });
    await vault.store("k2", "same", { type: "api_key" });
    const row1 = vault.db
      .query("SELECT encrypted_value FROM vault_credentials WHERE name = ?")
      .get("k1") as { encrypted_value: string };
    const row2 = vault.db
      .query("SELECT encrypted_value FROM vault_credentials WHERE name = ?")
      .get("k2") as { encrypted_value: string };
    expect(row1.encrypted_value).not.toBe(row2.encrypted_value);
  });
});

describe("LeakScanner + redactor", () => {
  const scanner = new LeakScanner();
  test("detects common leak patterns", () => {
    const res = scanner.scan(
      "sk-12345678901234567890 ANTHROPIC_API_KEY=foo sk-ant-12345678901234567890 AIza12345678901234567890123456789012345 AKIA1234567890ABCD12 Bearer abcdefghijklmnopqrstuvwxyz.123 user@example.com 555-123-4567 123-45-6789 4242 4242 4242 4242 -----BEGIN PRIVATE KEY----- -----BEGIN CERTIFICATE----- eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def ghp_123456789012345678901234567890123456",
      { direction: "output" }
    );
    expect(res.matches.some((m) => m.type === "api_key")).toBeTrue();
    expect(res.matches.some((m) => m.type === "aws_key")).toBeTrue();
    expect(res.matches.some((m) => m.type === "bearer_token")).toBeTrue();
    expect(res.matches.some((m) => m.type === "pii_email")).toBeTrue();
    expect(res.matches.some((m) => m.type === "pii_phone")).toBeTrue();
    expect(res.matches.some((m) => m.type === "pii_ssn")).toBeTrue();
    expect(res.matches.some((m) => m.type === "credit_card")).toBeTrue();
    expect(res.matches.some((m) => m.type === "private_key")).toBeTrue();
    expect(res.matches.some((m) => m.type === "certificate")).toBeTrue();
    expect(res.matches.some((m) => m.type === "jwt")).toBeTrue();
    expect(res.matches.some((m) => m.type === "github_token")).toBeTrue();
  });

  test("redact replaces and preserves last 4 chars", () => {
    const res = redact("sk-12345678901234567890");
    expect(res.wasModified).toBeTrue();
    expect(res.redacted).toContain("[REDACTED:api_key:...");
  });

  test("credit card requires valid luhn", () => {
    const resBad = scanner.scan("1111 2222 3333 4445", { direction: "output" });
    expect(resBad.hasMatches).toBeFalse();
    const resGood = scanner.scan("4242 4242 4242 4242", { direction: "output" });
    expect(resGood.hasMatches).toBeTrue();
  });

  test("does not flag normal text", () => {
    const res = scanner.scan("hello world", { direction: "output" });
    expect(res.hasMatches).toBeFalse();
  });
});

describe("AllowlistManager", () => {
  test("allowlist toggles", () => {
    const db = new Database(":memory:");
    const allowlist = new AllowlistManager({ db });
    expect(allowlist.isAllowed("tool", "api_key")).toBeFalse();
    allowlist.allow("tool", "api_key", "...1234");
    expect(allowlist.isAllowed("tool", "api_key")).toBeTrue();
    const entry = allowlist.list()[0];
    if (!entry) throw new Error("missing entry");
    allowlist.revoke(entry.id);
    expect(allowlist.isAllowed("tool", "api_key")).toBeFalse();
  });
});

describe("DLP", () => {
  test("scanOutput returns approval request for api key", async () => {
    const db = new Database(":memory:");
    const allowlist = new AllowlistManager({ db });
    const dlp = new DLP(new LeakScanner(), allowlist, { db, timeoutMs: 50 });
    const result = await dlp.scanOutput("bash", "sk-12345678901234567890", "s1");
    expect(result.clean).toBeFalse();
    expect(result.requiresApproval).toBeTrue();
    expect(result.approvalRequest).toBeTruthy();
  });

  test("allowlisted tool passes clean", async () => {
    const db = new Database(":memory:");
    const allowlist = new AllowlistManager({ db });
    allowlist.allow("bash", "api_key", "...1234");
    const dlp = new DLP(new LeakScanner(), allowlist, { db });
    const result = await dlp.scanOutput("bash", "sk-12345678901234567890", "s1");
    expect(result.clean).toBeTrue();
  });

  test("scanInput detects credentials", async () => {
    const db = new Database(":memory:");
    const allowlist = new AllowlistManager({ db });
    const dlp = new DLP(new LeakScanner(), allowlist, { db });
    const result = await dlp.scanInput("bash", { token: "sk-12345678901234567890" }, "s1");
    expect(result.clean).toBeFalse();
    expect(result.requiresApproval).toBeTrue();
  });

  test("timeout auto-approves redacted", async () => {
    const db = new Database(":memory:");
    const allowlist = new AllowlistManager({ db });
    const dlp = new DLP(new LeakScanner(), allowlist, { db, timeoutMs: 10 });
    const res = await dlp.scanOutput("bash", "sk-12345678901234567890", "s1");
    if (!res.approvalRequest) throw new Error("missing request");
    const decision = await dlp.waitForApproval(res.approvalRequest, res.redactedValue);
    expect(decision.useRedacted).toBeTrue();
    expect(decision.status).toBe("timeout");
  });

  test("approve flows resolve", async () => {
    const db = new Database(":memory:");
    const allowlist = new AllowlistManager({ db });
    const dlp = new DLP(new LeakScanner(), allowlist, { db, timeoutMs: 200 });
    const res = await dlp.scanOutput("bash", "sk-12345678901234567890", "s1");
    const request = res.approvalRequest as LeakApprovalRequest;
    const pending = dlp.waitForApproval(request, res.redactedValue);
    dlp.approveRedacted(request.id);
    const decision = await pending;
    expect(decision.status).toBe("approved_redacted");
  });

  test("approve original resolves", async () => {
    const db = new Database(":memory:");
    const allowlist = new AllowlistManager({ db });
    const dlp = new DLP(new LeakScanner(), allowlist, { db, timeoutMs: 200 });
    const res = await dlp.scanOutput("bash", "sk-12345678901234567890", "s1");
    const request = res.approvalRequest as LeakApprovalRequest;
    const pending = dlp.waitForApproval(request, res.redactedValue);
    dlp.approveOriginal(request.id);
    const decision = await pending;
    expect(decision.status).toBe("approved_original");
  });

  test("allowlist resolves and records", async () => {
    const db = new Database(":memory:");
    const allowlist = new AllowlistManager({ db });
    const dlp = new DLP(new LeakScanner(), allowlist, { db, timeoutMs: 200 });
    const res = await dlp.scanOutput("bash", "sk-12345678901234567890", "s1");
    const request = res.approvalRequest as LeakApprovalRequest;
    const pending = dlp.waitForApproval(request, res.redactedValue);
    dlp.addToAllowlist(request.id);
    const decision = await pending;
    expect(decision.status).toBe("added_to_allowlist");
    expect(allowlist.isAllowed("bash", "api_key")).toBeTrue();
  });

  test("deny blocks", async () => {
    const db = new Database(":memory:");
    const allowlist = new AllowlistManager({ db });
    const dlp = new DLP(new LeakScanner(), allowlist, { db, timeoutMs: 200 });
    const res = await dlp.scanOutput("bash", "sk-12345678901234567890", "s1");
    const request = res.approvalRequest as LeakApprovalRequest;
    const pending = dlp.waitForApproval(request, res.redactedValue);
    dlp.deny(request.id);
    const decision = await pending;
    expect(decision.status).toBe("denied");
  });
});

describe("Integration", () => {
  async function waitForPending(dlp: DLP, expected: number, timeoutMs = 200): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (dlp.pending().length === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test("wrapToolWithSecurity injects vault and scans output", async () => {
    const vault = makeVault();
    await vault.init();
    await vault.store("api", "sk-12345678901234567890", { type: "api_key" });
    const db = vault.db;
    const allowlist = new AllowlistManager({ db });
    const dlp = new DLP(new LeakScanner(), allowlist, { db, timeoutMs: 200 });
    const security: SecurityConfig = {
      vault,
      dlp,
      scanToolInputs: true,
      scanToolOutputs: true,
    };
    const tool = wrapToolWithSecurity(
      {
        name: "call_api",
        description: "test",
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: async (input: { key: string }) => `used ${input.key}`,
      },
      security,
      "session-1"
    );
    const outputPromise = tool.execute({ key: "{{api}}" }, new AbortController().signal);
    await waitForPending(dlp, 1);
    const leaks = dlp.pending();
    expect(leaks.length).toBe(1);
    dlp.approveRedacted(leaks[0].id);
    const output = await outputPromise;
    expect(String(output)).toContain("used");
  });
});
