import fs from 'node:fs';
import path from 'node:path';

export async function GET() {
  const settingsPath = path.join(process.cwd(), 'src/content/site/settings.json');
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const settings = JSON.parse(raw);
  return new Response(
    JSON.stringify({ listId: settings.newsletter?.listId || '' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
