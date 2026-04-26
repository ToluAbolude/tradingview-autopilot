// job_scorer.mjs — scores job fit against Tolu's CV
import { CV } from './cv_profile.mjs';

// Skills that score extra — Tolu's strongest areas
const TIER1_SKILLS = ['java', 'python', 'aws', 'azure', 'spring boot', 'kubernetes', 'docker', 'fhir', 'api', 'rest', 'ci/cd', 'jenkins', 'terraform', 'ansible'];
const TIER2_SKILLS = ['javascript', 'sql', 'postgresql', 'mysql', 'dynamodb', 'rabbitmq', 'agile', 'scrum', 'jira', 'git', 'github', 'maven', 'junit'];

// Roles that are a strong match for Tolu's background
const STRONG_ROLE_MATCH = [
  'backend', 'api', 'java', 'python', 'cloud', 'devops', 'platform',
  'software engineer', 'software developer', 'full stack', 'solutions engineer',
];

// Roles to avoid (poor fit)
const POOR_FIT = ['mobile', 'ios', 'android', 'react native', 'unity', 'game', 'embedded', 'firmware', 'c# developer', '.net developer', 'ruby', 'golang'];

function extractSalary(text) {
  if (!text) return null;
  // Match patterns like £70,000, £70k, 70000, $70k
  const patterns = [
    /£(\d{2,3}),?(\d{3})/gi,
    /£(\d{2,3})k/gi,
    /(\d{2,3})k\s*(?:gbp|per annum|pa|salary)/gi,
    /salary[:\s]+£(\d{2,3})/gi,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) {
      const num = parseInt(m[1].replace(',', '')) * (m[0].includes('k') || m[0].includes('K') ? 1000 : 1);
      if (num >= 30000 && num <= 300000) return num;
    }
  }
  return null;
}

function normalise(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s+#]/g, ' ');
}

export function scoreJob(job) {
  const text   = normalise(`${job.title} ${job.description} ${job.company}`);
  const title  = normalise(job.title);
  let score    = 0;
  const matched = [];
  const missing = [];

  // ── 1. Role title match (0–25 pts) ──
  const roleScore = STRONG_ROLE_MATCH.filter(r => title.includes(r)).length;
  score += Math.min(roleScore * 8, 25);
  if (roleScore > 0) matched.push(`Role match: ${STRONG_ROLE_MATCH.filter(r => title.includes(r)).join(', ')}`);

  // Poor fit penalty
  const isPoorFit = POOR_FIT.some(r => text.includes(r));
  if (isPoorFit) score -= 30;

  // ── 2. Tier 1 skill matches (4 pts each, max 40) ──
  for (const skill of TIER1_SKILLS) {
    if (text.includes(skill)) { score += 4; matched.push(skill); }
    else missing.push(skill);
  }
  score = Math.min(score, score); // no cap here — let it accumulate

  // ── 3. Tier 2 skill matches (2 pts each, max 20) ──
  for (const skill of TIER2_SKILLS) {
    if (text.includes(skill)) { score += 2; matched.push(skill); }
  }

  // ── 4. Experience level check ──
  const isJunior  = /junior|entry.level|graduate|0.2 years/i.test(text);
  const isSenior  = /senior|lead|principal|staff|10\+|8\+\s*years/i.test(text);
  if (isJunior) score -= 10; // Tolu is mid-level, not junior
  if (isSenior && !/3|4|5\+/.test(text)) score -= 5; // Very senior may be out of range

  // ── 5. Government/enterprise experience bonus ──
  const hasGovt = /nhs|hmrc|gov|government|public sector|civil service|defra|dwp|mod\b/i.test(text);
  if (hasGovt) { score += 10; matched.push('Government sector (Tolu has direct experience)'); }

  // ── 6. Salary check ──
  const salary = extractSalary(`${job.salary_text} ${job.description}`);
  job.salary_detected = salary;
  if (salary && salary < CV.target.salary_min) score -= 20;
  if (salary && salary >= 70000) score += 5;
  if (salary && salary >= 90000) score += 5;

  // ── 7. Remote/hybrid bonus ──
  if (/remote|hybrid/i.test(text)) { score += 5; matched.push('Remote/Hybrid'); }

  // Normalise to 0–100
  const pct = Math.max(0, Math.min(100, Math.round(score)));

  // Tier label
  const tier = pct >= 70 ? 'STRONG' : pct >= 50 ? 'GOOD' : pct >= 35 ? 'POSSIBLE' : 'WEAK';

  return {
    score: pct,
    tier,
    matched_skills: [...new Set(matched)],
    missing_skills: [...new Set(missing)].slice(0, 5),
    salary_detected: salary,
  };
}

export function filterAndRank(jobs) {
  return jobs
    .map(j => ({ ...j, fit: scoreJob(j) }))
    .filter(j => j.fit.tier !== 'WEAK')
    .sort((a, b) => b.fit.score - a.fit.score);
}
