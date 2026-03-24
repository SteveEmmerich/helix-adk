/**
 * Session picker — shown on `nova` startup when existing sessions exist.
 * Lets you resume, delete, or start fresh.
 */

import type { SessionMetadata } from "@helix/core";
import { Box, Text, useInput } from "ink";
import { useState } from "react";

function formatAge(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

function formatCost(usd?: number): string {
  if (!usd) return "$0.00";
  return `$${usd.toFixed(4)}`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SessionPickerProps {
  sessions: readonly SessionMetadata[];
  onSelect: (id: string | null) => void;
  onDelete?: (id: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SessionPicker({ sessions, onSelect, onDelete }: SessionPickerProps) {
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<"pick" | "confirm-delete">("pick");

  // "New session" is always the first option
  const items = [null, ...sessions.map((s) => s.id)];
  const selectedId = items[cursor] ?? null;
  const selectedSession = sessions.find((s) => s.id === selectedId);

  useInput((input, key) => {
    if (mode === "pick") {
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
      if (key.return) onSelect(selectedId);
      if (input === "d" && selectedId && onDelete) setMode("confirm-delete");
      if (key.escape) onSelect(null);
    }

    if (mode === "confirm-delete") {
      if (input === "y" && selectedId && onDelete) {
        onDelete(selectedId);
        setCursor((c) => Math.max(0, c - 1));
        setMode("pick");
      }
      if (input === "n" || key.escape) setMode("pick");
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Helix ADK
        </Text>
        <Text dimColor> — select a session or start new</Text>
      </Box>

      {/* Session list */}
      <Box flexDirection="column" marginBottom={1}>
        {/* New session option */}
        <Box>
          <Text color={cursor === 0 ? "cyan" : "white"} bold={cursor === 0}>
            {cursor === 0 ? "❯ " : "  "}
          </Text>
          <Text color={cursor === 0 ? "cyan" : "white"}>+ New session</Text>
        </Box>

        {/* Existing sessions */}
        {sessions.map((session, i) => {
          const idx = i + 1;
          const isSelected = cursor === idx;
          const title = session.title ?? session.id.slice(0, 8);
          const age = formatAge(session.updatedAt);
          const cost = formatCost(session.totalCostUsd);
          const msgs = session.messageCount;

          return (
            <Box key={session.id}>
              <Text color={isSelected ? "cyan" : "gray"} bold={isSelected}>
                {isSelected ? "❯ " : "  "}
              </Text>
              <Box flexDirection="column">
                <Box>
                  <Text color={isSelected ? "white" : "gray"} bold={isSelected}>
                    {title}
                  </Text>
                  {session.tags && session.tags.length > 0 && (
                    <Text dimColor>
                      {"  "}
                      {session.tags.map((t) => `#${t}`).join(" ")}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Text dimColor>{`  ${age} · ${msgs} msgs · ${cost}`}</Text>
                </Box>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Detail panel for selected session */}
      {selectedSession && (
        <Box
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
          flexDirection="column"
        >
          <Text dimColor>ID: {selectedSession.id}</Text>
          {selectedSession.model && <Text dimColor>Model: {selectedSession.model}</Text>}
          {selectedSession.workingDirectory && (
            <Text dimColor>Dir: {selectedSession.workingDirectory}</Text>
          )}
        </Box>
      )}

      {/* Delete confirmation */}
      {mode === "confirm-delete" && selectedSession && (
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">
            Delete "{selectedSession.title ?? selectedSession.id.slice(0, 8)}"?{" "}
          </Text>
          <Text color="red" bold>
            [y/n]
          </Text>
        </Box>
      )}

      {/* Key hints */}
      {mode === "pick" && (
        <Box>
          <Text dimColor>
            ↑↓ navigate ↵ select {sessions.length > 0 ? "d delete  " : ""}esc cancel
          </Text>
        </Box>
      )}
    </Box>
  );
}
