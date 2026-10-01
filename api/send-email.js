// Vercel Serverless Function: nimmt eine Liste von E-Mails vom Dispo-Manager
// entgegen und verschickt sie über Resend. Der Resend-API-Key liegt NUR hier
// als Server-Umgebungsvariable (RESEND_API_KEY) - er darf nie im Frontend-
// Code (index.html) stehen, sonst könnte ihn jeder im Quelltext sehen und
// damit beliebige Mails über unsere Domain verschicken.

const FROM = 'Putzfrauenservice Clean Service <putzfrauenservice@clean-service.ch>';
const MAX_PER_REQUEST = 50;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'RESEND_API_KEY ist nicht konfiguriert (Vercel-Projekteinstellungen -> Environment Variables).' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { res.status(400).json({ error: 'Ungültiges JSON' }); return; }
  }

  const emails = body && Array.isArray(body.emails) ? body.emails : null;
  if (!emails || emails.length === 0) {
    res.status(400).json({ error: '"emails" (Array) wird benötigt' });
    return;
  }
  if (emails.length > MAX_PER_REQUEST) {
    res.status(400).json({ error: `Zu viele E-Mails auf einmal (max. ${MAX_PER_REQUEST})` });
    return;
  }

  const results = [];
  for (const e of emails) {
    if (!e || !e.to || !e.subject || !e.html) {
      results.push({ to: e && e.to, ok: false, error: 'to/subject/html fehlt' });
      continue;
    }
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: FROM,
          to: [e.to],
          subject: e.subject,
          html: e.html
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        results.push({ to: e.to, ok: false, error: data.message || `Resend-Fehler (${r.status})` });
      } else {
        results.push({ to: e.to, ok: true, id: data.id });
      }
    } catch (err) {
      results.push({ to: e.to, ok: false, error: String(err && err.message || err) });
    }
  }

  res.status(200).json({ results });
};
