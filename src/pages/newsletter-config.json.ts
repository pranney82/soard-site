// @ts-nocheck
import settingsRaw from '../content/site/settings.json?raw';

export async function GET() {
  const settings = JSON.parse(settingsRaw);
  return new Response(
    JSON.stringify({ listId: settings.newsletter?.listId || '' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
