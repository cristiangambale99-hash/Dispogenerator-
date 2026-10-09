// Vercel Serverless Function: sendet Dispo + Auftragsrapporte in den
// Beekeeper-Gruppenchat. Der API-Token liegt NUR hier als Umgebungsvariable
// (BEEKEEPER_TOKEN), nie im Frontend.
// Aktionen (JSON-Body):
//   { action:'diag' }                         -> Verbindung testen, Chats auflisten
//   { action:'upload', name, base64 }         -> Datei hochladen, liefert file-Referenz
//   { action:'message', text, files:[...] }   -> Nachricht mit Anhängen in den Chat senden
const BASE = (process.env.BEEKEEPER_URL || 'https://clean-service.ch.beekeeper.io').replace(/\/+$/,'');
const CHAT_NAME = process.env.BEEKEEPER_CHAT_NAME || 'PFS: Dispo Springer-Team';

function authHeaders(scheme){ return { Authorization: `${scheme} ${process.env.BEEKEEPER_TOKEN}`, Accept:'application/json' }; }

async function bk(path, opts, scheme){
  const r = await fetch(BASE + path, { ...opts, headers: { ...authHeaders(scheme), ...(opts && opts.headers) } });
  const text = await r.text(); let json = null; try{ json = JSON.parse(text); }catch(e){}
  return { ok:r.ok, status:r.status, json, text: text.slice(0,500) };
}
async function withAuth(path, opts){
  let r = await bk(path, opts, 'Token');
  if(r.status===401 || r.status===403){ const r2 = await bk(path, opts, 'Bearer'); if(r2.ok || r2.status!==401) r = r2; }
  return r;
}
function chatList(j){
  if(!j) return [];
  const arr = Array.isArray(j) ? j : (j.conversations || j.chats || j.items || j.data || []);
  return Array.isArray(arr) ? arr : [];
}
async function findChat(){
  if(process.env.BEEKEEPER_CHAT_ID) return { id: process.env.BEEKEEPER_CHAT_ID, base:'/api/2/conversations' };
  for(const base of ['/api/2/conversations','/api/2/chats']){
    for(let page=0; page<5; page++){
      const r = await withAuth(`${base}?limit=100&offset=${page*100}`);
      if(!r.ok) break;
      const list = chatList(r.json);
      const hit = list.find(c=> String(c.name||c.title||c.subject||'').trim().toLowerCase() === CHAT_NAME.toLowerCase());
      if(hit) return { id: hit.id || hit.conversation_id, base };
      if(list.length<100) break;
    }
  }
  return null;
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){ res.status(405).json({ error:'Method not allowed' }); return; }
  if(!process.env.BEEKEEPER_TOKEN){ res.status(500).json({ error:'BEEKEEPER_TOKEN ist nicht konfiguriert (Vercel -> Environment Variables).' }); return; }
  let body = req.body; if(typeof body==='string'){ try{ body = JSON.parse(body); }catch(e){ res.status(400).json({ error:'Ungültiges JSON' }); return; } }
  body = body || {};
  try{
    if(body.action==='diag'){
      const out = {};
      for(const p of ['/api/2/conversations?limit=5','/api/2/chats?limit=5','/api/2/users/me']){
        const r = await withAuth(p); out[p] = { status:r.status, sample:r.text.slice(0,200) };
      }
      const chat = await findChat();
      res.status(200).json({ ok:true, chat, probes:out }); return;
    }
    if(body.action==='upload'){
      if(!body.name || !body.base64){ res.status(400).json({ error:'name/base64 fehlt' }); return; }
      const buf = Buffer.from(body.base64, 'base64');
      const fd = new FormData();
      fd.append('usage_type', 'attachment_file');
      fd.append('file', new Blob([buf], { type:'application/pdf' }), body.name);
      const r = await withAuth('/api/2/files', { method:'POST', body: fd });
      if(!r.ok){ res.status(502).json({ error:`Upload fehlgeschlagen (HTTP ${r.status})`, detail:r.text }); return; }
      res.status(200).json({ ok:true, file: r.json }); return;
    }
    if(body.action==='message'){
      const chat = await findChat();
      if(!chat){ res.status(502).json({ error:`Chat «${CHAT_NAME}» wurde nicht gefunden. Token-Rechte bzw. BEEKEEPER_CHAT_ID prüfen.` }); return; }
      const files = Array.isArray(body.files) ? body.files.filter(Boolean) : [];
      const payload = { text: body.text, body: body.text, message: body.text };
      if(files.length){ payload.files = files; payload.attachments = files; }
      const paths = [`${chat.base}/${chat.id}/messages`, `/api/2/messages`];
      let last = null;
      for(const p of paths){
        const data = p==='/api/2/messages' ? { ...payload, conversation_id: chat.id } : payload;
        const r = await withAuth(p, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(data) });
        if(r.ok){ res.status(200).json({ ok:true, result:r.json }); return; }
        last = r;
      }
      res.status(502).json({ error:`Senden fehlgeschlagen (HTTP ${last && last.status})`, detail: last && last.text }); return;
    }
    res.status(400).json({ error:'Unbekannte Aktion' });
  }catch(e){
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
