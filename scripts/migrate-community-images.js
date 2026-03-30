#!/usr/bin/env node
/**
 * migrate-community-images.js
 * ============================
 * One-time script: downloads community project photos from WordPress
 * and uploads them to Cloudflare Images with proper IDs.
 *
 * Usage:
 *   CF_ACCOUNT_ID=xxx CF_IMAGES_TOKEN=xxx node scripts/migrate-community-images.js
 *
 * Or set the env vars in your shell first. The tokens are the same ones
 * used in CF Pages → Settings → Environment Variables.
 *
 * Skips images that already exist (409 = duplicate ID).
 * Safe to re-run if interrupted.
 */

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_IMAGES_TOKEN = process.env.CF_IMAGES_TOKEN;

if (!CF_ACCOUNT_ID || !CF_IMAGES_TOKEN) {
  console.error('❌ Set CF_ACCOUNT_ID and CF_IMAGES_TOKEN env vars first.');
  console.error('   CF_ACCOUNT_ID=xxx CF_IMAGES_TOKEN=xxx node scripts/migrate-community-images.js');
  process.exit(1);
}

const UPLOAD_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/images/v1`;

/**
 * Image manifest: CF Image ID → WordPress source URL
 * Generated from the WordPress XML export.
 */
const IMAGE_MAP = {
  // ═══ The Cottage School (2021) ═══════════════════════
  'community/the-cottage-school/before-01': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/01/TCS1.jpeg',
  'community/the-cottage-school/before-02': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/01/TCS2.jpeg',
  'community/the-cottage-school/before-03': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/01/TCS3.jpeg',
  'community/the-cottage-school/before-04': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/01/TCS4.jpeg',
  'community/the-cottage-school/before-05': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/01/TCS6.jpeg',
  'community/the-cottage-school/after-01': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/02/cottage_2021_reveal_00001-scaled.jpg',
  'community/the-cottage-school/after-02': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/02/cottage_2021_reveal_00002-scaled.jpg',
  'community/the-cottage-school/after-03': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/02/cottage_2021_reveal_00003-scaled.jpg',
  'community/the-cottage-school/after-04': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/02/cottage_2021_reveal_00004-scaled.jpg',
  'community/the-cottage-school/after-05': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/02/cottage_2021_reveal_00006-scaled.jpg',
  'community/the-cottage-school/after-06': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/02/cottage_2021_reveal_00008-min-scaled.jpg',
  'community/the-cottage-school/after-07': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/02/cottage_2021_reveal_00007-min-scaled.jpg',
  'community/the-cottage-school/after-08': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/02/cottage_2021_reveal_00009-scaled.jpg',
  'community/the-cottage-school/after-09': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/02/cottage_2021_reveal_000010-scaled.jpg',
  'community/the-cottage-school/after-10': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/02/cottage_2021_reveal_000011-min-scaled.jpg',

  // ═══ The Drake House (2022) ══════════════════════════
  'community/the-drake-house/before-01': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/06/TDH_before_00001-scaled.jpg',
  'community/the-drake-house/before-02': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/06/TDH_before_0002-scaled.jpg',
  'community/the-drake-house/before-03': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/06/TDH_before_00003-scaled.jpg',
  'community/the-drake-house/before-04': 'https://sunshineonaranneyday.com/wp-content/uploads/2022/06/TDH_before_00004-scaled.jpg',
  'community/the-drake-house/after-01': 'https://sunshineonaranneyday.com/wp-content/uploads/2023/02/IMG_9547-scaled.jpg',
  'community/the-drake-house/after-02': 'https://sunshineonaranneyday.com/wp-content/uploads/2023/02/IMG_9536-scaled.jpg',
  'community/the-drake-house/after-03': 'https://sunshineonaranneyday.com/wp-content/uploads/2023/02/IMG_9541-scaled.jpg',
  'community/the-drake-house/after-04': 'https://sunshineonaranneyday.com/wp-content/uploads/2023/02/SOARD0-scaled.jpg',
  'community/the-drake-house/after-05': 'https://sunshineonaranneyday.com/wp-content/uploads/2023/02/IMG_9212-scaled.jpg',
  'community/the-drake-house/after-06': 'https://sunshineonaranneyday.com/wp-content/uploads/2023/02/SOARD22-scaled.jpg',
  'community/the-drake-house/after-07': 'https://sunshineonaranneyday.com/wp-content/uploads/2023/02/IMG_9180-scaled.jpg',
  'community/the-drake-house/after-08': 'https://sunshineonaranneyday.com/wp-content/uploads/2023/02/IMG_9197-scaled.jpg',
  'community/the-drake-house/after-09': 'https://sunshineonaranneyday.com/wp-content/uploads/2023/02/IMG_9248-scaled.jpg',
  'community/the-drake-house/after-10': 'https://sunshineonaranneyday.com/wp-content/uploads/2023/02/IMG_9264-scaled.jpg',
  'community/the-drake-house/after-11': 'https://sunshineonaranneyday.com/wp-content/uploads/2023/02/IMG_9158-scaled.jpg',

  // ═══ Mt. Zion UMC Preschool (2024) ═══════════════════
  'community/mt-zion-umc-preschool/before-01': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/2024_before_mt-zion_00003-scaled.jpg',
  'community/mt-zion-umc-preschool/before-02': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/2024_before_mt-zion_00002-scaled.jpg',
  'community/mt-zion-umc-preschool/before-03': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/2024_before_mt.-zion_00001-scaled.jpg',
  'community/mt-zion-umc-preschool/after-01': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0004-scaled.jpg',
  'community/mt-zion-umc-preschool/after-02': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0006-scaled.jpg',
  'community/mt-zion-umc-preschool/after-03': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0039-scaled.jpg',
  'community/mt-zion-umc-preschool/after-04': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0008-scaled.jpg',
  'community/mt-zion-umc-preschool/after-05': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0007-scaled.jpg',
  'community/mt-zion-umc-preschool/after-06': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0005-scaled.jpg',
  'community/mt-zion-umc-preschool/after-07': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0011-scaled.jpg',
  'community/mt-zion-umc-preschool/after-08': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0041-scaled.jpg',
  'community/mt-zion-umc-preschool/after-09': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0050-scaled.jpg',
  'community/mt-zion-umc-preschool/after-10': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0055-scaled.jpg',
  'community/mt-zion-umc-preschool/after-11': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0048-scaled.jpg',
  'community/mt-zion-umc-preschool/after-12': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0035-scaled.jpg',
  'community/mt-zion-umc-preschool/after-13': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0022-scaled.jpg',
  'community/mt-zion-umc-preschool/after-14': 'https://sunshineonaranneyday.com/wp-content/uploads/2024/09/Mt.Zion_2024_reveal_0059-scaled.jpg',

  // ═══ Children's Development Academy (2025) ═══════════
  'community/childrens-development-academy/before-01': 'https://sunshineonaranneyday.com/wp-content/uploads/2026/01/20250619_155230-scaled.jpg',
  'community/childrens-development-academy/before-02': 'https://sunshineonaranneyday.com/wp-content/uploads/2026/01/20250619_155236-scaled.jpg',
  'community/childrens-development-academy/before-03': 'https://sunshineonaranneyday.com/wp-content/uploads/2026/01/20250619_155240-scaled.jpg',
  'community/childrens-development-academy/before-04': 'https://sunshineonaranneyday.com/wp-content/uploads/2026/01/20250619_155314-scaled.jpg',
  'community/childrens-development-academy/before-05': 'https://sunshineonaranneyday.com/wp-content/uploads/2026/01/20250619_155840-scaled.jpg',
  'community/childrens-development-academy/before-06': 'https://sunshineonaranneyday.com/wp-content/uploads/2026/01/20250619_155852-scaled.jpg',
};

async function uploadImage(cfId, wpUrl) {
  try {
    const formData = new FormData();
    formData.append('url', wpUrl);
    formData.append('id', cfId);

    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CF_IMAGES_TOKEN}` },
      body: formData,
    });

    const data = await res.json();

    if (data.success) {
      return { status: 'ok', id: cfId };
    }

    // 409 = image with this ID already exists — that's fine
    if (data.errors?.[0]?.code === 5409) {
      return { status: 'exists', id: cfId };
    }

    return { status: 'error', id: cfId, error: data.errors?.[0]?.message || 'Unknown error' };
  } catch (err) {
    return { status: 'error', id: cfId, error: err.message };
  }
}

async function main() {
  const entries = Object.entries(IMAGE_MAP);
  console.log(`\n☀️  Migrating ${entries.length} community project images to Cloudflare Images...\n`);

  let ok = 0, exists = 0, errors = 0;

  for (const [cfId, wpUrl] of entries) {
    const result = await uploadImage(cfId, wpUrl);

    if (result.status === 'ok') {
      console.log(`  ✅ ${cfId}`);
      ok++;
    } else if (result.status === 'exists') {
      console.log(`  ⏭️  ${cfId} (already exists)`);
      exists++;
    } else {
      console.log(`  ❌ ${cfId} — ${result.error}`);
      errors++;
    }

    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n────────────────────────────────────`);
  console.log(`  Uploaded:  ${ok}`);
  console.log(`  Skipped:   ${exists}`);
  console.log(`  Errors:    ${errors}`);
  console.log(`  Total:     ${entries.length}`);
  console.log(`────────────────────────────────────\n`);

  if (errors > 0) {
    console.log('⚠️  Some uploads failed. Re-run this script to retry.\n');
    process.exit(1);
  } else {
    console.log('🎉 All community images are in Cloudflare Images!\n');
  }
}

main();
