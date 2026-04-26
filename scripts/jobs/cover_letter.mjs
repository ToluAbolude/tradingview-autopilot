// cover_letter.mjs — generates tailored cover letters via Claude API
import { CV } from './cv_profile.mjs';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

export async function generateCoverLetter(job) {
  const { title, company, description, fit } = job;
  const matchedSkills = fit?.matched_skills?.slice(0, 6).join(', ') || 'software engineering';

  // If no API key, return a strong template letter
  if (!ANTHROPIC_KEY) {
    return templateCoverLetter(job);
  }

  const prompt = `Write a concise, professional cover letter (3 short paragraphs, max 200 words) for Tolu Abolude applying to the role below.

Role: ${title} at ${company}
Job description excerpt: ${(description || '').slice(0, 800)}

Tolu's profile:
- ${CV.experience_years} years experience as a Software Engineer
- Current: ${CV.current_role}
- Education: ${CV.education}
- Strongest skills matching this role: ${matchedSkills}
- Key achievements: Led FHIR R4 APIs for NHS (80M+ records), AWS Lambda/DynamoDB at scale, HMRC APIs in Java/Kubernetes

Rules:
- Open with a strong hook tied to THIS specific company/role
- Middle paragraph: 2-3 specific technical achievements that match what they need
- Close: brief, confident, call to action
- Do NOT use "I am writing to apply", "I am passionate", or generic filler
- Sound human and direct, not corporate
- Do not mention salary
- Sign off as: Tolu Abolude`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    return data?.content?.[0]?.text || templateCoverLetter(job);
  } catch (e) {
    return templateCoverLetter(job);
  }
}

function templateCoverLetter(job) {
  const { title, company, fit } = job;
  const skills = fit?.matched_skills?.filter(s => s.length < 20).slice(0, 4).join(', ') || 'Java, Python, AWS, and cloud APIs';

  return `Dear Hiring Manager,

${company}'s work caught my attention, and the ${title} role aligns directly with what I've spent the last four years building. At Netcompany, I've delivered production-grade systems for NHS and HMRC — including FHIR R4 APIs processing 80 million records, AWS Lambda functions backed by DynamoDB and Neptune, and Java/Kubernetes APIs for HMRC's tax platform. I know how to ship reliable backend systems at scale.

The skills you're looking for — ${skills} — are ones I use daily. Beyond the technical side, I'm experienced in agile delivery, incident management (P1/P2/P3 on-call), and working in cross-functional government-facing teams where quality and deadlines both matter.

I'd welcome the opportunity to discuss how my background fits what you're building. Available for interview at short notice.

Tolu Abolude
toludavid07@gmail.com | +447475481278`;
}
