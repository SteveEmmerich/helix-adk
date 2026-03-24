import { SkillRegistryClient } from "./client.js";

export async function searchSkills(query: string, baseUrl?: string) {
  const client = new SkillRegistryClient(baseUrl);
  return client.search(query);
}

export async function resolveSkill(id: string, baseUrl?: string) {
  const client = new SkillRegistryClient(baseUrl);
  return client.resolve(id);
}

export async function fetchSkillMetadata(id: string, baseUrl?: string) {
  const client = new SkillRegistryClient(baseUrl);
  return client.fetchMetadata(id);
}
