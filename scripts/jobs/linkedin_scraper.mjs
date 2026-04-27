// linkedin_scraper.mjs — LinkedIn job scraper via CDP (port 9223)
// Uses a dedicated Chrome instance separate from TradingView (port 9222)
import CDP from 'chrome-remote-interface';
import { SEARCH_QUERIES, CV } from './cv_profile.mjs';

const LINKEDIN_PORT = 9223;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getClient() {
  try {
    const client = await CDP({ port: LINKEDIN_PORT });
    return client;
  } catch (e) {
    throw new Error(`Cannot connect to LinkedIn Chrome on port ${LINKEDIN_PORT}. Is the service running? ${e.message}`);
  }
}

async function evaluate(client, expr) {
  const { Runtime } = client;
  const result = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  return result?.result?.value;
}

async function navigate(client, url) {
  const { Page } = client;
  await Page.navigate({ url });
  await Page.loadEventFired();
  await sleep(3000);
}

// Check if we're logged in to LinkedIn
async function isLoggedIn(client) {
  // Feed page title only appears when authenticated
  const title = await evaluate(client, `document.title`);
  const url   = await evaluate(client, `window.location.href`);
  return (title || '').includes('Feed') || (url || '').includes('/feed/') || (url || '').includes('/jobs/');
}

// Extract job cards from current search results page
async function extractJobCards(client) {
  return await evaluate(client, `
    (function() {
      const cards = document.querySelectorAll(
        '[data-occludable-job-id], [data-job-id], .job-card-container, .base-card'
      );
      const results = [];
      cards.forEach(card => {
        try {
          const titleEl  = card.querySelector('.job-card-list__title--link, .job-card-list__title, .base-search-card__title');
          const compEl   = card.querySelector('.artdeco-entity-lockup__subtitle, .job-card-container__primary-description, .job-card-container__company-name, .base-search-card__subtitle');
          const locEl    = card.querySelector('.artdeco-entity-lockup__caption, .job-card-container__metadata-item, .job-search-card__location');
          const salEl    = card.querySelector('.job-card-container__salary-info, .job-search-card__salary-info, [class*="salary"]');
          const linkEl   = card.querySelector('a[href*="/jobs/view/"]');
          const jobId    = card.getAttribute('data-occludable-job-id') || card.getAttribute('data-job-id') || card.getAttribute('data-entity-urn') || '';

          if (titleEl && compEl) {
            results.push({
              job_id:      jobId,
              title:       titleEl.innerText.trim().split('\\n')[0].trim(),
              company:     compEl.innerText.trim().split('\\n')[0].trim(),
              location:    locEl ? locEl.innerText.trim().split('\\n')[0].trim() : '',
              salary_text: salEl ? salEl.innerText.trim() : '',
              url:         linkEl ? (linkEl.href.startsWith('http') ? linkEl.href : 'https://www.linkedin.com' + linkEl.getAttribute('href')) : '',
            });
          }
        } catch(e) {}
      });
      return results;
    })()
  `);
}

// Click a job card and extract its full description
async function extractJobDetail(client, jobUrl) {
  try {
    await navigate(client, jobUrl);
    await sleep(2000);
    const detail = await evaluate(client, `
      (function() {
        const desc = document.querySelector(
          '.jobs-description__content, .job-view-layout .jobs-box__html-content, .description__text, [class*="description"]'
        );
        const salary = document.querySelector(
          '.jobs-unified-top-card__job-insight span, .compensation__salary-range, [class*="salary"]'
        );
        const easyApply = document.querySelector('.jobs-apply-button, [aria-label*="Easy Apply"]');
        return {
          description: desc ? desc.innerText.trim().slice(0, 3000) : '',
          salary_text: salary ? salary.innerText.trim() : '',
          easy_apply:  !!easyApply,
          apply_url:   window.location.href,
        };
      })()
    `);
    return detail || {};
  } catch(e) {
    return { description: '', easy_apply: false };
  }
}

// Search LinkedIn jobs for a query
async function searchJobs(client, query, maxPages = 2) {
  const jobs = [];
  const seen = new Set();

  for (let page = 0; page < maxPages; page++) {
    const start = page * 25;
    const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(query)}&location=United+Kingdom&f_TPR=r86400&sortBy=DD&start=${start}`;

    console.log(`  Searching: "${query}" page ${page + 1}...`);
    await navigate(client, url);
    await sleep(2500 + Math.random() * 1500); // human-pace randomisation

    const cards = await extractJobCards(client);
    if (!cards || cards.length === 0) break;

    for (const card of cards) {
      if (!card.title || seen.has(card.job_id || card.url)) continue;
      seen.add(card.job_id || card.url);
      jobs.push(card);
    }

    console.log(`    Found ${cards.length} cards (total: ${jobs.length})`);
    if (cards.length < 10) break; // no more pages
  }

  return jobs;
}

export async function scrapeLinkedInJobs() {
  console.log('Connecting to LinkedIn Chrome (port 9223)...');
  const client = await getClient();
  const { Page, Runtime } = client;

  await Runtime.enable();
  await Page.enable();

  // Check login
  await navigate(client, 'https://www.linkedin.com/feed/');
  const loggedIn = await isLoggedIn(client);
  if (!loggedIn) {
    await client.close();
    throw new Error('Not logged in to LinkedIn. Please log in via VNC and re-run.');
  }
  console.log('LinkedIn: logged in ✓');

  const allJobs = [];
  const seen = new Set();

  // Run each search query
  for (const query of SEARCH_QUERIES.slice(0, 5)) { // 5 queries per run to avoid rate limits
    const jobs = await searchJobs(client, query, 2);
    for (const job of jobs) {
      const key = job.job_id || job.url;
      if (!seen.has(key)) {
        seen.add(key);
        allJobs.push(job);
      }
    }
    await sleep(3000 + Math.random() * 2000); // pause between queries
  }

  console.log(`\nTotal unique jobs found: ${allJobs.length}`);

  // Fetch details for top candidates (limit to 30 to avoid rate limiting)
  const toDetail = allJobs.slice(0, 30);
  console.log(`Fetching full descriptions for ${toDetail.length} jobs...`);

  const detailed = [];
  for (let i = 0; i < toDetail.length; i++) {
    const job = toDetail[i];
    if (!job.url) { detailed.push(job); continue; }
    process.stdout.write(`  [${i+1}/${toDetail.length}] ${job.title} @ ${job.company}... `);
    const detail = await extractJobDetail(client, job.url);
    detailed.push({ ...job, ...detail });
    process.stdout.write(`done\n`);
    await sleep(2000 + Math.random() * 2000); // human pace
  }

  await client.close();
  return detailed;
}
