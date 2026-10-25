/**
 * admin-version.mjs: after the site build (npm run build), dist/admin/version.json names the code
 * that's being deployed, so an admin tab left open can tell an update went live and offer Reload
 * (public/admin/index.html). On Cloudflare Pages that's the commit; a content Publish rebuilds the
 * same commit, so it never asks for a reload over content.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const build = process.env.CF_PAGES_COMMIT_SHA || `local-${new Date().toISOString()}`;
const dir = new URL('../dist/admin/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('version.json', dir), `${JSON.stringify({ build })}\n`);
console.log(`admin version: ${build.slice(0, 12)}`);
