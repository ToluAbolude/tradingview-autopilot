/**
 * job_runner.mjs — Daily job intelligence pipeline
 *
 * Cron: 0 8 * * 1-5  (08:00 UTC Mon-Fri)
 *
 * Flow:
 *   1. Scrape LinkedIn jobs (last 24h, UK, software roles)
 *   2. Score each job against Tolu's CV
 *   3. Filter to GOOD/STRONG matches only
 *   4. Generate tailored cover letters for top 15
 *   5. Email digest to toludavid07@gmail.com
 *   6. Save all data to /home/ubuntu/trading-data/jobs/
 */
import { scrapeLinkedInJobs } from './linkedin_scraper.mjs';
import { filterAndRank }       from './job_scorer.mjs';
import { generateCoverLetter } from './cover_letter.mjs';
import { sendDigest }          from './email_digest.mjs';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const DATA_DIR = '/home/ubuntu/trading-data/jobs';
const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

async function main() {
  const date = new Date().toISOString().split('T')[0];
  log(`═══ JOB PIPELINE START — ${date} ═══`);

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // 1. Scrape LinkedIn
  log('Step 1: Scraping LinkedIn jobs...');
  let rawJobs = [];
  try {
    rawJobs = await scrapeLinkedInJobs();
    log(`Scraped ${rawJobs.length} raw jobs`);
    writeFileSync(join(DATA_DIR, `raw_${date}.json`), JSON.stringify(rawJobs, null, 2));
  } catch (e) {
    log(`Scrape error: ${e.message}`);
    // If scrape fails, still try to send any cached jobs
    log('Exiting — LinkedIn scraper failed. Check LinkedIn login via VNC.');
    process.exit(1);
  }

  if (rawJobs.length === 0) {
    log('No jobs found — LinkedIn may be blocking or search returned empty. Exiting.');
    process.exit(0);
  }

  // 2. Score and filter
  log('Step 2: Scoring and filtering...');
  const ranked = filterAndRank(rawJobs);
  log(`Qualified jobs: ${ranked.length} (GOOD or STRONG fit)`);

  if (ranked.length === 0) {
    log('No qualifying jobs today. Email skipped.');
    process.exit(0);
  }

  // 3. Generate cover letters for top 15
  log('Step 3: Generating cover letters...');
  const top = ranked.slice(0, 15);
  for (let i = 0; i < top.length; i++) {
    const job = top[i];
    process.stdout.write(`  [${i+1}/${top.length}] ${job.title} @ ${job.company}... `);
    job.cover_letter = await generateCoverLetter(job);
    process.stdout.write('done\n');
    await new Promise(r => setTimeout(r, 500)); // brief pause between API calls
  }

  // 4. Save final results
  const outPath = join(DATA_DIR, `digest_${date}.json`);
  writeFileSync(outPath, JSON.stringify(top, null, 2));
  log(`Results saved: ${outPath}`);

  // 5. Send email digest
  log('Step 4: Sending email digest...');
  try {
    await sendDigest(top, date);
    log(`Email sent — ${top.length} jobs, top score: ${top[0]?.fit?.score}%`);
  } catch (e) {
    log(`Email failed: ${e.message}`);
  }

  // Summary
  log('\n── SUMMARY ──');
  log(`Total scraped:    ${rawJobs.length}`);
  log(`Qualified:        ${ranked.length}`);
  log(`In digest:        ${top.length}`);
  log(`Top match:        ${top[0]?.title} @ ${top[0]?.company} (${top[0]?.fit?.score}%)`);
  log(`Strong fits:      ${top.filter(j => j.fit.tier === 'STRONG').length}`);
  log(`Easy Apply:       ${top.filter(j => j.easy_apply).length}`);
  log('═══ JOB PIPELINE DONE ═══\n');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
