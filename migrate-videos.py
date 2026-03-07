#!/usr/bin/env python3
"""
migrate-videos.py — Bulk migrate YouTube videos to Cloudflare Stream

Reads all kid JSON files, downloads videos via yt-dlp, uploads to
Cloudflare Stream, and updates the JSON with streamVideoId.

Setup (run once):
  pip install yt-dlp requests
  git clone https://github.com/pranney82/soard.git
  cd soard

Usage:
  python3 migrate-videos.py              # Full migration
  python3 migrate-videos.py --dry-run    # Preview what would happen
  python3 migrate-videos.py --limit 5    # Only process first 5 unique URLs

After migration:
  git add -A
  git commit -m "feat: migrate videos to Cloudflare Stream"
  git push origin main
"""

import json
import glob
import os
import sys
import time
import subprocess
import requests
from pathlib import Path

# ─── Config ──────────────────────────────────
CF_ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID', 'bgg2Xv7khuDAXXHwJTqXl_wiVvqmS2MbhnQcOcYl')
CF_STREAM_TOKEN = os.environ.get('CF_STREAM_TOKEN', '***REMOVED***')
KIDS_DIR = 'src/content/kids'
DOWNLOAD_DIR = '/tmp/soard-video-migration'
LOG_FILE = 'migration-log.json'

# ─── Parse args ──────────────────────────────
dry_run = '--dry-run' in sys.argv
limit = None
if '--limit' in sys.argv:
    idx = sys.argv.index('--limit')
    limit = int(sys.argv[idx + 1])

# ─── Step 1: Scan all kid JSON files ────────
print('━' * 60)
print('SOARD Video Migration: YouTube → Cloudflare Stream')
print('━' * 60)
print()

kids_files = sorted(glob.glob(f'{KIDS_DIR}/*.json'))
print(f'Found {len(kids_files)} kid JSON files')

# Build mapping: videoUrl → list of (filepath, slug)
url_to_kids = {}
for filepath in kids_files:
    with open(filepath) as f:
        data = json.load(f)
    url = data.get('videoUrl')
    if not url:
        continue
    # Skip if already has a stream video
    if data.get('streamVideoId'):
        print(f'  ⏭  {data["slug"]}: already has streamVideoId, skipping')
        continue
    # Normalize URL
    url = url.split('?si=')[0]  # Remove share tracking params
    if url not in url_to_kids:
        url_to_kids[url] = []
    url_to_kids[url].append({'filepath': filepath, 'slug': data['slug'], 'name': data.get('name', data['slug'])})

unique_urls = list(url_to_kids.keys())
total_kids = sum(len(v) for v in url_to_kids.values())
print(f'Found {total_kids} kids with YouTube videos ({len(unique_urls)} unique URLs)')

if limit:
    unique_urls = unique_urls[:limit]
    print(f'Limiting to first {limit} URLs')

if dry_run:
    print('\n🔍 DRY RUN — no downloads or uploads will happen\n')
    for url in unique_urls:
        kids = url_to_kids[url]
        slugs = ', '.join(k['slug'] for k in kids)
        print(f'  {url}')
        print(f'    → Would update: {slugs}')
    print(f'\nTotal: {len(unique_urls)} videos to download/upload')
    sys.exit(0)

# ─── Step 2: Download & Upload ──────────────
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

results = {
    'success': [],
    'failed': [],
    'skipped': [],
}

def download_video(url, output_path):
    """Download video using yt-dlp, return filepath."""
    cmd = [
        'yt-dlp',
        '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--output', output_path,
        '--no-playlist',
        '--quiet',
        '--progress',
        url,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise Exception(f'yt-dlp error: {result.stderr.strip()}')
    # yt-dlp may add extension
    if os.path.exists(output_path):
        return output_path
    if os.path.exists(output_path + '.mp4'):
        return output_path + '.mp4'
    # Find whatever file was created
    for f in os.listdir(os.path.dirname(output_path)):
        if f.startswith(os.path.basename(output_path).rsplit('.', 1)[0]):
            return os.path.join(os.path.dirname(output_path), f)
    raise Exception('Downloaded file not found')


def upload_to_stream(filepath, name):
    """Upload video to Cloudflare Stream, return video ID."""
    url = f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/stream'
    headers = {'Authorization': f'Bearer {CF_STREAM_TOKEN}'}

    file_size = os.path.getsize(filepath)
    print(f'    Uploading {file_size / (1024*1024):.1f} MB to Stream...')

    with open(filepath, 'rb') as f:
        files = {'file': (os.path.basename(filepath), f, 'video/mp4')}
        data = {'meta': json.dumps({'name': name})}
        resp = requests.post(url, headers=headers, files=files, data=data, timeout=600)

    result = resp.json()
    if not result.get('success'):
        error = result.get('errors', [{}])[0].get('message', 'Unknown error')
        raise Exception(f'Stream API error: {error}')

    return result['result']['uid']


def update_kid_json(filepath, stream_video_id):
    """Add streamVideoId to kid JSON file."""
    with open(filepath) as f:
        data = json.load(f)
    data['streamVideoId'] = stream_video_id
    with open(filepath, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')


print(f'\nStarting migration of {len(unique_urls)} videos...\n')

for i, url in enumerate(unique_urls, 1):
    kids = url_to_kids[url]
    primary = kids[0]
    slugs = ', '.join(k['slug'] for k in kids)

    print(f'[{i}/{len(unique_urls)}] {primary["name"]}')
    print(f'    URL: {url}')
    print(f'    Kids: {slugs}')

    try:
        # Download
        safe_name = primary['slug'].replace('/', '-')
        output_path = os.path.join(DOWNLOAD_DIR, f'{safe_name}.mp4')

        if os.path.exists(output_path):
            print(f'    Already downloaded, reusing...')
        else:
            print(f'    Downloading from YouTube...')
            output_path = download_video(url, output_path)

        # Upload
        video_name = f'{primary["name"]} — SOARD Room Reveal'
        stream_id = upload_to_stream(output_path, video_name)
        print(f'    ✅ Stream ID: {stream_id}')

        # Update all kid JSONs that share this video
        for kid in kids:
            update_kid_json(kid['filepath'], stream_id)
            print(f'    ✅ Updated {kid["slug"]}.json')

        results['success'].append({
            'url': url,
            'streamVideoId': stream_id,
            'kids': [k['slug'] for k in kids],
        })

        # Clean up downloaded file to save disk space
        if os.path.exists(output_path):
            os.remove(output_path)

    except Exception as e:
        print(f'    ❌ FAILED: {e}')
        results['failed'].append({
            'url': url,
            'kids': [k['slug'] for k in kids],
            'error': str(e),
        })

    # Small delay between uploads
    if i < len(unique_urls):
        time.sleep(1)

# ─── Step 3: Summary ────────────────────────
print('\n' + '━' * 60)
print('MIGRATION COMPLETE')
print('━' * 60)
print(f'  ✅ Success: {len(results["success"])} videos → {sum(len(r["kids"]) for r in results["success"])} kid profiles')
print(f'  ❌ Failed:  {len(results["failed"])} videos')

if results['failed']:
    print('\nFailed videos:')
    for f in results['failed']:
        print(f'  {f["url"]} ({", ".join(f["kids"])}): {f["error"]}')

# Save log
with open(LOG_FILE, 'w') as f:
    json.dump(results, f, indent=2)
print(f'\nFull log saved to {LOG_FILE}')

print('\nNext steps:')
print('  1. Review the changes: git diff src/content/kids/')
print('  2. Commit: git add -A && git commit -m "feat: migrate videos to Cloudflare Stream"')
print('  3. Push: git push origin main')
print('  4. Videos take 1-5 minutes to process on Stream before they are playable')
