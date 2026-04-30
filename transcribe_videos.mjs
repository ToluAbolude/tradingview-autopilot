import { writeFileSync } from 'fs';

const APIFY_API_KEY = 'process.env.APIFY_API_KEY';

// Already-started runs (started manually before this script)
const RUNS = [
  { name: 'video_1', runId: 'tE2gLVD6z0QpTZ63z' },
  { name: 'video_2', runId: 'tG9q9yL0WS1OUvbJo' },
];

async function waitForRun(runId, label) {
  console.log(`Polling ${label} (run ${runId})...`);

  while (true) {
    await new Promise(r => setTimeout(r, 8000));

    const res = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_API_KEY}`
    );
    const { data } = await res.json();
    console.log(`  ${label}: ${data.status}`);

    if (data.status === 'SUCCEEDED') return data.defaultDatasetId;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(data.status)) {
      throw new Error(`Run ${runId} ended with status: ${data.status}`);
    }
  }
}

async function getTranscript(datasetId, label) {
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}&clean=true`
  );
  const items = await res.json();
  console.log(`Fetched ${items.length} item(s) for ${label}`);
  return items;
}

async function main() {
  for (const run of RUNS) {
    try {
      const datasetId = await waitForRun(run.runId, run.name);
      const items = await getTranscript(datasetId, run.name);

      writeFileSync(`${run.name}_transcript.json`, JSON.stringify(items, null, 2));
      console.log(`Saved: ${run.name}_transcript.json`);

      const text = items.map(i => i.text || i.transcript || JSON.stringify(i)).join('\n\n');
      writeFileSync(`${run.name}_transcript.txt`, text);
      console.log(`Saved: ${run.name}_transcript.txt`);
    } catch (err) {
      console.error(`Error for ${run.name}:`, err.message);
    }
  }
  console.log('\nDone.');
}

main();
