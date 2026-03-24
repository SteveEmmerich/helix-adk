export const TIER1_QUERY = `
  SELECT content FROM memory_facts
  WHERE hot_score > 0.1
  ORDER BY (hot_score * 0.6 + importance * 0.4) DESC
  LIMIT ?
`;
