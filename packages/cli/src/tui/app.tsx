/**
 * Nova TUI — built with Ink (React for terminals)
 *
 * vs pi-tui:
 * - Ink handles differential rendering, we don't implement it ourselves
 * - Cleaner component model — pure React, no custom component protocol
 * - Extension renderers slot in naturally via React
 * - Status bar, spinner, cost tracker built-in
 */

import type { AgentEvent } from "@helix/core";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtensionRegistry } from "../extensions/registry.js";

// ─── Message display types ────────────────────────────────────────────────────

export type DisplayLine =
  | { type: "user"; text: string; timestamp: number }
  | { type: "assistant"; text: string; complete: boolean; timestamp: number }
  | { type: "tool_call"; name: string; input: string; timestamp: number }
  | {
      type: "tool_result";
      name: string;
      output: string;
      isError: boolean;
      durationMs: number;
      timestamp: number;
    }
  | { type: "system"; text: string; timestamp: number }
  | { type: "error"; text: string; timestamp: number };

// ─── Spinner ─────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner({ label }: { label?: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);

  return (
    <Box>
      <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
      {label && <Text dimColor>{label}</Text>}
    </Box>
  );
}

// ─── Individual line renderers ────────────────────────────────────────────────

function DisplayLineView({ line }: { line: DisplayLine }) {
  switch (line.type) {
    case "user":
      return (
        <Box marginBottom={1}>
          <Text color="green" bold>
            {"›"}{" "}
          </Text>
          <Text>{line.text}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box marginBottom={line.complete ? 1 : 0} flexDirection="column">
          {line.text && <Text>{line.text}</Text>}
        </Box>
      );

    case "tool_call":
      return (
        <Box marginY={0}>
          <Text color="yellow">{"⚙"} </Text>
          <Text color="yellow" bold>
            {line.name}
          </Text>
          <Text dimColor>{` ${line.input}`}</Text>
        </Box>
      );

    case "tool_result":
      return (
        <Box marginBottom={1}>
          <Text color={line.isError ? "red" : "green"}>{line.isError ? "✗" : "✓"} </Text>
          <Text dimColor>
            {line.name} ({line.durationMs}ms)
          </Text>
        </Box>
      );

    case "system":
      return (
        <Box marginY={0}>
          <Text dimColor italic>
            {line.text}
          </Text>
        </Box>
      );

    case "error":
      return (
        <Box marginBottom={1}>
          <Text color="red" bold>
            Error:{" "}
          </Text>
          <Text color="red">{line.text}</Text>
        </Box>
      );
  }
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function StatusBar({
  model,
  turns,
  totalCostUsd,
  totalTokens,
  isRunning,
}: {
  model: string;
  turns: number;
  totalCostUsd: number;
  totalTokens: number;
  isRunning: boolean;
}) {
  const { stdout } = useStdout();
  const width = stdout.columns ?? 80;

  const left = ` nova  ${model}`;
  const right = isRunning
    ? "running… "
    : ` ${turns} turns · ${totalTokens.toLocaleString()} tok · $${totalCostUsd.toFixed(4)} `;

  const padding = Math.max(0, width - left.length - right.length);

  return (
    <Box>
      <Text backgroundColor="blue" color="white" bold>
        {left}
      </Text>
      <Text backgroundColor="blue" color="white">
        {" ".repeat(padding)}
      </Text>
      <Text backgroundColor="blue" color="white" dimColor>
        {right}
      </Text>
    </Box>
  );
}

// ─── Input bar ────────────────────────────────────────────────────────────────

function InputBar({
  value,
  onChange,
  onSubmit,
  isRunning,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  isRunning: boolean;
  placeholder?: string;
}) {
  if (isRunning) {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Spinner label="thinking…" />
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="gray">{"› "}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={placeholder ?? "Message… (/ for commands, ctrl+c to exit)"}
      />
    </Box>
  );
}

// ─── Main app props ───────────────────────────────────────────────────────────

export interface NovaAppProps {
  model: string;
  onSubmit: (input: string) => Promise<void>;
  registry: ExtensionRegistry;
  onExit?: () => void;
}

// ─── Main Nova TUI app ────────────────────────────────────────────────────────

export function NovaApp({ model, onSubmit, registry, onExit }: NovaAppProps) {
  const { exit } = useApp();
  const [lines, setLines] = useState<DisplayLine[]>([]);
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [turns, setTurns] = useState(0);
  const [totalCostUsd, setTotalCostUsd] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);

  // Streaming assistant text buffer
  const streamBufferRef = useRef("");

  // ─── Event handler (called by parent to push agent events into TUI) ─────────

  const handleAgentEvent = useCallback(
    (event: AgentEvent) => {
      // Check extension renderers first
      for (const renderer of registry.renderers) {
        if (renderer.canRender(event)) {
          const rendered = renderer.render(event);
          if (rendered !== null) {
            setLines((prev) => [
              ...prev,
              { type: "system", text: rendered, timestamp: Date.now() },
            ]);
          }
          return;
        }
      }

      // Built-in rendering
      switch (event.type) {
        case "stream_event": {
          const e = event.event;
          if (e.type === "text_delta") {
            streamBufferRef.current += e.delta;
            setLines((prev) => {
              const last = prev[prev.length - 1];
              if (last?.type === "assistant" && !last.complete) {
                return [...prev.slice(0, -1), { ...last, text: streamBufferRef.current }];
              }
              return [
                ...prev,
                {
                  type: "assistant",
                  text: streamBufferRef.current,
                  complete: false,
                  timestamp: Date.now(),
                },
              ];
            });
          }
          break;
        }

        case "tool_call":
          setLines((prev) => [
            ...prev,
            {
              type: "tool_call",
              name: event.name,
              input: JSON.stringify(event.input).slice(0, 80),
              timestamp: Date.now(),
            },
          ]);
          break;

        case "tool_result":
          setLines((prev) => [
            ...prev,
            {
              type: "tool_result",
              name: event.name,
              output: event.output,
              isError: event.isError,
              durationMs: event.durationMs,
              timestamp: Date.now(),
            },
          ]);
          break;

        case "turn_complete":
          // Seal the last assistant line
          setLines((prev) => {
            const last = prev[prev.length - 1];
            if (last?.type === "assistant" && !last.complete) {
              return [...prev.slice(0, -1), { ...last, complete: true }];
            }
            return prev;
          });
          streamBufferRef.current = "";
          setTurns((t) => t + 1);
          setTotalCostUsd((c) => c + event.response.cost.totalCostUsd);
          setTotalTokens((t) => t + event.response.usage.totalTokens);
          break;

        case "done":
          setIsRunning(false);
          break;

        case "error":
          setLines((prev) => [
            ...prev,
            { type: "error", text: event.error.message, timestamp: Date.now() },
          ]);
          setIsRunning(false);
          break;
      }
    },
    [registry]
  );

  // Expose event handler for parent
  (NovaApp as { _handler?: typeof handleAgentEvent })._handler = handleAgentEvent;

  // ─── Submit handler ──────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      setInput("");
      streamBufferRef.current = "";

      // Always show the user input
      setLines((prev) => [...prev, { type: "user", text: trimmed, timestamp: Date.now() }]);

      setIsRunning(true);

      try {
        await onSubmit(trimmed);
      } finally {
        setIsRunning(false);
      }
    },
    [onSubmit]
  );

  // ─── Keyboard shortcuts ──────────────────────────────────────────────────────

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onExit?.();
      exit();
    }
  });

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" height="100%">
      {/* Scrollable output area */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        {lines.slice(-100).map((line, i) => (
          <DisplayLineView key={`${line.type}-${line.timestamp}-${i}`} line={line} />
        ))}
      </Box>

      {/* Input bar */}
      <Box flexDirection="column">
        <InputBar value={input} onChange={setInput} onSubmit={handleSubmit} isRunning={isRunning} />
        {/* Status bar */}
        <StatusBar
          model={model}
          turns={turns}
          totalCostUsd={totalCostUsd}
          totalTokens={totalTokens}
          isRunning={isRunning}
        />
      </Box>
    </Box>
  );
}
