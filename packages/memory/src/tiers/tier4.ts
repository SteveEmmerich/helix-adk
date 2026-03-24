export const TIER4_QUERY = `
  SELECT title, content FROM memory_procedures
  ORDER BY usage_count DESC
  LIMIT ?
`;
