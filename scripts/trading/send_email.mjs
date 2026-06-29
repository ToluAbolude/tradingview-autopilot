/**
 * send_email.mjs <htmlFile> <subject...> — emails an HTML report via Gmail SMTP.
 *
 * Reads creds from env (sourced from ~/.email.env by the wrapper):
 *   GMAIL_USER            the sending Gmail address
 *   GMAIL_APP_PASSWORD    a Google App Password (NOT your normal password)
 *   EMAIL_TO              recipient (defaults to GMAIL_USER)
 *
 * No-ops with exit 0 if creds are missing, so the cron never errors before the
 * app password is set up. Requires `nodemailer` (npm i nodemailer).
 */
import { readFileSync, existsSync } from 'fs';
import nodemailer from 'nodemailer';

const [htmlFile, ...subjParts] = process.argv.slice(2);
const subject = subjParts.join(' ') || 'Trading report';
const USER = process.env.GMAIL_USER, PASS = process.env.GMAIL_APP_PASSWORD;
const TO = process.env.EMAIL_TO || USER;

if (!USER || !PASS || /REPLACE_WITH/.test(`${USER}${PASS}`)) { console.log('send_email: GMAIL_USER/GMAIL_APP_PASSWORD not set yet — skipping send (edit ~/.email.env)'); process.exit(0); }
if (!htmlFile || !existsSync(htmlFile)) { console.log(`send_email: report file not found (${htmlFile}) — skipping`); process.exit(0); }

const html = readFileSync(htmlFile, 'utf8');
const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: USER, pass: PASS } });
try {
  await transport.sendMail({ from: `Trading Bot <${USER}>`, to: TO, subject, html });
  console.log(`emailed "${subject}" -> ${TO}`);
} catch (e) {
  console.error('send_email FAILED:', e.message);
  process.exit(1);
}
process.exit(0);
