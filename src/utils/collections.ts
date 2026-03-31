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
