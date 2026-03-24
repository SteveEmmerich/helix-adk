export const TIER2_QUERY = `
  SELECT summary, outcome, date FROM memory_episodes
  WHERE date >= date('now', ?)
  ORDER BY importance DESC, date DESC
  LIMIT ?
`;
