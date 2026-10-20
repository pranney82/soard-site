/**
 * Collection helpers — shared filters for content collections.
 * Centralizes draft filtering so every page stays consistent.
 */
import { getCollection } from 'astro:content';

/** Returns only published kids (filters out drafts). */
export async function getPublishedKids() {
  const all = await getCollection('kids');
  return all.filter(k => k.data.publishStatus !== 'draft');
}

/** Returns only published community projects (filters out drafts). */
export async function getPublishedCommunity() {
  const all = await getCollection('community');
  return all.filter(c => c.data.publishStatus !== 'draft');
}
