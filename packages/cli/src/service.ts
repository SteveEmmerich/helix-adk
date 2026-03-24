import { homedir } from "node:os";
import { join } from "node:path";

export function launchdPlist(opts: { bunPath: string; repoPath: string }): string {
  const home = homedir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.helixclaw.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.bunPath}</string>
    <string>run</string>
    <string>${opts.repoPath}/scripts/launch.ts</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${home}/.hlx/logs/gateway.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/.hlx/logs/gateway-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
  </dict>
</dict>
</plist>
`;
}

export function systemdUnit(opts: { bunPath: string; repoPath: string }): string {
  return `[Unit]
Description=HelixClaw Gateway
After=network.target

[Service]
Type=simple
ExecStart=${opts.bunPath} run ${opts.repoPath}/scripts/launch.ts --no-open
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

export function launchdPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "com.helixclaw.gateway.plist");
}

export function systemdPath(): string {
  return join(homedir(), ".config", "systemd", "user", "helixclaw.service");
}
