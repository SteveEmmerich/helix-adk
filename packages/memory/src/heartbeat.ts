import type { HeartbeatSchedule } from "./types.js";

const EVERY_MINUTES = /^\s*##\s*Every\s+(\d+)\s+minutes?/i;
const EVERY_HOUR = /^\s*##\s*Every\s+hour/i;
const DAILY_AT = /^\s*##\s*Daily\s+at\s+(\d{2}):(\d{2})/i;
const WEEKLY_ON = /^\s*##\s*Weekly\s+on\s+([A-Za-z]+)(?:\s+at\s+(\d{2}):(\d{2}))?/i;

const DAY_MAP: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function parseHeartbeat(content: string): HeartbeatSchedule[] {
  const lines = content.split("\n");
  const schedules: HeartbeatSchedule[] = [];
  let current: { header: string; prompt: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const header = current.header.trim();
    const prompt = current.prompt.join("\n").trim();
    const schedule = parseHeader(header, prompt);
    if (schedule) schedules.push(schedule);
    current = null;
  };

  for (const line of lines) {
    if (line.trim().startsWith("## ")) {
      flush();
      current = { header: line.trim(), prompt: [] };
      continue;
    }
    if (!current) continue;
    if (line.trim().length === 0 && current.prompt.length === 0) continue;
    current.prompt.push(line);
  }
  flush();
  return schedules;
}

function parseHeader(header: string, prompt: string): HeartbeatSchedule | null {
  let match = header.match(EVERY_MINUTES);
  if (match) {
    const minutes = Number(match[1]);
    return {
      prompt,
      interval: minutes,
      description: `Every ${minutes} minutes`,
    };
  }

  match = header.match(EVERY_HOUR);
  if (match) {
    return {
      prompt,
      interval: 60,
      description: "Every hour",
    };
  }

  match = header.match(DAILY_AT);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return {
      prompt,
      cron: `${minute} ${hour} * * *`,
      description: `Daily at ${match[1]}:${match[2]}`,
    };
  }

  match = header.match(WEEKLY_ON);
  if (match) {
    const day = match[1]?.toLowerCase() ?? "monday";
    const dayNum = DAY_MAP[day] ?? 1;
    const hour = match[2] ? Number(match[2]) : 9;
    const minute = match[3] ? Number(match[3]) : 0;
    return {
      prompt,
      cron: `${minute} ${hour} * * ${dayNum}`,
      description: `Weekly on ${match[1]}${match[2] ? ` at ${match[2]}:${match[3]}` : ""}`,
    };
  }

  return null;
}
