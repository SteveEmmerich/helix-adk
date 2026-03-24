import { test, expect } from "bun:test";
import { launchdPlist, systemdUnit } from "../src/service.js";

const bunPath = "/opt/bun/bin/bun";
const repoPath = "/tmp/helix-adk";

test("launchd plist includes bun path and no-open", () => {
  const plist = launchdPlist({ bunPath, repoPath });
  expect(plist).toContain(bunPath);
  expect(plist).toContain(`${repoPath}/scripts/launch.ts`);
  expect(plist).toContain("--no-open");
  expect(plist).toContain("com.helixclaw.gateway");
});

test("systemd unit includes bun path and no-open", () => {
  const unit = systemdUnit({ bunPath, repoPath });
  expect(unit).toContain(bunPath);
  expect(unit).toContain(`${repoPath}/scripts/launch.ts`);
  expect(unit).toContain("--no-open");
  expect(unit).toContain("Description=HelixClaw Gateway");
});
