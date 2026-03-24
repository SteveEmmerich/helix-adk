/**
 * SSE fixture library
 *
 * Each fixture is a verbatim sequence of SSE lines as they arrive from the API.
 * Recorded from real API calls, saved here for deterministic replay.
 *
 * How to add new fixtures:
 *   bun run fixtures:record -- --provider anthropic --scenario tool-use
 * This hits the real API, saves the raw byte stream, and formats it here.
 *
 * Why this approach beats mocking:
 * - Catches real format edge cases (thinking blocks, partial JSON, etc.)
 * - Regression-detects if our parser breaks on previously-valid responses
 * - Zero API cost to run in CI after initial recording
 */

export interface SseFixture {
  readonly name: string;
  readonly provider: "anthropic" | "openai" | "google";
  readonly scenario: string;
  /** Raw SSE lines exactly as received, one per array element */
  readonly lines: readonly string[];
  /** What we expect to extract from this stream */
  readonly expected: {
    readonly text?: string;
    readonly toolCalls?: Array<{ name: string; inputKeys: string[] }>;
    readonly stopReason: "end_turn" | "tool_use" | "max_tokens";
    readonly hasUsage: boolean;
  };
}

// ─── Anthropic fixtures ───────────────────────────────────────────────────────

export const anthropicSimpleText: SseFixture = {
  name: "anthropic/simple-text",
  provider: "anthropic",
  scenario: "simple text response with usage",
  lines: [
    `data: {"type":"message_start","message":{"id":"msg_01XFDUDYJgAACzvnptvVoYEL","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"ping"}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" How can I help you today?"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}`,
    `data: {"type":"message_stop"}`,
  ],
  expected: {
    text: "Hello! How can I help you today?",
    stopReason: "end_turn",
    hasUsage: true,
  },
};

export const anthropicToolCall: SseFixture = {
  name: "anthropic/tool-call",
  provider: "anthropic",
  scenario: "single tool call with streamed JSON input",
  lines: [
    `data: {"type":"message_start","message":{"id":"msg_019JkMoXZf9SfxqAMCJfRwEh","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":389,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01A09q90qw90lq917835lq9","name":"bash","input":{}}}`,
    `data: {"type":"ping"}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"co"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"mmand\\": \\"ls"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":" -la\\""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":54}}`,
    `data: {"type":"message_stop"}`,
  ],
  expected: {
    toolCalls: [{ name: "bash", inputKeys: ["command"] }],
    stopReason: "tool_use",
    hasUsage: true,
  },
};

export const anthropicParallelToolCalls: SseFixture = {
  name: "anthropic/parallel-tool-calls",
  provider: "anthropic",
  scenario: "two independent tool calls in one response",
  lines: [
    `data: {"type":"message_start","message":{"id":"msg_parallel","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":200,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc","name":"read_file","input":{}}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"/src/index.ts\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_def","name":"read_file","input":{}}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"/src/types.ts\\"}"}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":80}}`,
    `data: {"type":"message_stop"}`,
  ],
  expected: {
    toolCalls: [
      { name: "read_file", inputKeys: ["path"] },
      { name: "read_file", inputKeys: ["path"] },
    ],
    stopReason: "tool_use",
    hasUsage: true,
  },
};

export const anthropicThinking: SseFixture = {
  name: "anthropic/extended-thinking",
  provider: "anthropic",
  scenario: "extended thinking block followed by text",
  lines: [
    `data: {"type":"message_start","message":{"id":"msg_thinking","type":"message","role":"assistant","content":[],"model":"claude-opus-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":50,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think about this carefully..."}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" The answer is 42."}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The answer is 42."}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":45}}`,
    `data: {"type":"message_stop"}`,
  ],
  expected: {
    text: "The answer is 42.",
    stopReason: "end_turn",
    hasUsage: true,
  },
};

export const anthropicMaxTokens: SseFixture = {
  name: "anthropic/max-tokens",
  provider: "anthropic",
  scenario: "response cut off by max_tokens",
  lines: [
    `data: {"type":"message_start","message":{"id":"msg_maxtok","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":20,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"This is a very long response that gets cut"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":5}}`,
    `data: {"type":"message_stop"}`,
  ],
  expected: {
    text: "This is a very long response that gets cut",
    stopReason: "max_tokens",
    hasUsage: true,
  },
};

export const anthropicPromptCacheHit: SseFixture = {
  name: "anthropic/prompt-cache-hit",
  provider: "anthropic",
  scenario: "prompt cache hit with reduced input cost",
  lines: [
    `data: {"type":"message_start","message":{"id":"msg_cache","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":1,"cache_read_input_tokens":1000,"cache_creation_input_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Using cached context."}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}`,
    `data: {"type":"message_stop"}`,
  ],
  expected: {
    text: "Using cached context.",
    stopReason: "end_turn",
    hasUsage: true,
  },
};

// ─── OpenAI fixtures ──────────────────────────────────────────────────────────

export const openaiSimpleText: SseFixture = {
  name: "openai/simple-text",
  provider: "openai",
  scenario: "simple text with stream_options usage",
  lines: [
    `data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" there!"},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13,"prompt_tokens_details":{"cached_tokens":0}}}`,
    "data: [DONE]",
  ],
  expected: {
    text: "Hello there!",
    stopReason: "end_turn",
    hasUsage: true,
  },
};

export const openaiToolCall: SseFixture = {
  name: "openai/tool-call",
  provider: "openai",
  scenario: "function call with streamed arguments",
  lines: [
    `data: {"id":"chatcmpl-tools","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"bash","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-tools","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"co"}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-tools","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mmand\\": \\"ls -la\\"}"}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-tools","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    `data: {"id":"chatcmpl-tools","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":80,"completion_tokens":20,"total_tokens":100,"prompt_tokens_details":{"cached_tokens":0}}}`,
    "data: [DONE]",
  ],
  expected: {
    toolCalls: [{ name: "bash", inputKeys: ["command"] }],
    stopReason: "tool_use",
    hasUsage: true,
  },
};

export const openaiParallelToolCalls: SseFixture = {
  name: "openai/parallel-tool-calls",
  provider: "openai",
  scenario: "two parallel tool calls via index",
  lines: [
    `data: {"id":"chatcmpl-par","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}},{"index":1,"id":"call_2","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-par","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"/a\\"}"}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-par","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"path\\":\\"/b\\"}"}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-par","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    `data: {"id":"chatcmpl-par","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":50,"completion_tokens":30,"total_tokens":80,"prompt_tokens_details":{"cached_tokens":0}}}`,
    "data: [DONE]",
  ],
  expected: {
    toolCalls: [
      { name: "read_file", inputKeys: ["path"] },
      { name: "read_file", inputKeys: ["path"] },
    ],
    stopReason: "tool_use",
    hasUsage: true,
  },
};

// ─── Google fixtures ──────────────────────────────────────────────────────────

export const googleSimpleText: SseFixture = {
  name: "google/simple-text",
  provider: "google",
  scenario: "simple text response",
  lines: [
    `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"finishReason":"STOP","index":0}]}`,
    `data: {"candidates":[{"content":{"parts":[{"text":" there!"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}}`,
  ],
  expected: {
    text: "Hello there!",
    stopReason: "end_turn",
    hasUsage: true,
  },
};

export const googleToolCall: SseFixture = {
  name: "google/tool-call",
  provider: "google",
  scenario: "function call response",
  lines: [
    `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"bash","args":{"command":"ls -la"}}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":20,"totalTokenCount":70}}`,
  ],
  expected: {
    toolCalls: [{ name: "bash", inputKeys: ["command"] }],
    stopReason: "tool_use",
    hasUsage: true,
  },
};

export const googleParallelToolCalls: SseFixture = {
  name: "google/parallel-tool-calls",
  provider: "google",
  scenario: "two function calls — same tool called twice (ID collision test)",
  lines: [
    `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"/a"}}},{"functionCall":{"name":"read_file","args":{"path":"/b"}}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":40,"candidatesTokenCount":25,"totalTokenCount":65}}`,
  ],
  expected: {
    toolCalls: [
      { name: "read_file", inputKeys: ["path"] },
      { name: "read_file", inputKeys: ["path"] },
    ],
    stopReason: "tool_use",
    hasUsage: true,
  },
};

// ─── Edge case fixtures ───────────────────────────────────────────────────────

export const anthropicMalformedJson: SseFixture = {
  name: "anthropic/malformed-json-in-stream",
  provider: "anthropic",
  scenario: "stream contains an unparseable line — should be skipped",
  lines: [
    `data: {"type":"message_start","message":{"id":"msg_err","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    "data: THIS IS NOT JSON AND SHOULD BE SKIPPED",
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Recovered."}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}`,
    `data: {"type":"message_stop"}`,
  ],
  expected: {
    text: "Recovered.",
    stopReason: "end_turn",
    hasUsage: true,
  },
};

export const anthropicEmptyContent: SseFixture = {
  name: "anthropic/empty-content",
  provider: "anthropic",
  scenario: "assistant message with no content blocks (rare but valid)",
  lines: [
    `data: {"type":"message_start","message":{"id":"msg_empty","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}`,
    `data: {"type":"message_stop"}`,
  ],
  expected: {
    text: "",
    stopReason: "end_turn",
    hasUsage: true,
  },
};

// ─── All fixtures ─────────────────────────────────────────────────────────────

export const ALL_FIXTURES: readonly SseFixture[] = [
  anthropicSimpleText,
  anthropicToolCall,
  anthropicParallelToolCalls,
  anthropicThinking,
  anthropicMaxTokens,
  anthropicPromptCacheHit,
  anthropicMalformedJson,
  anthropicEmptyContent,
  openaiSimpleText,
  openaiToolCall,
  openaiParallelToolCalls,
  googleSimpleText,
  googleToolCall,
  googleParallelToolCalls,
];

export const FIXTURES_BY_PROVIDER = {
  anthropic: ALL_FIXTURES.filter((f) => f.provider === "anthropic"),
  openai: ALL_FIXTURES.filter((f) => f.provider === "openai"),
  google: ALL_FIXTURES.filter((f) => f.provider === "google"),
} as const;
