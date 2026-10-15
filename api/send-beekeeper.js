// Vercel Serverless Function: sendet Dispo + Auftragsrapporte in den
// Beekeeper-Gruppenchat. Der API-Token liegt NUR hier als Umgebungsvariable
// (BEEKEEPER_TOKEN), nie im Frontend.
// Aktionen (JSON-Body):
//   { action:'diag' }                         -> Verbindung testen, Chats auflisten
//   { action:'upload', name, base64 }         -> Datei hochladen, liefert file-Referenz
//   { action:'message', text, files:[...] }   -> Nachricht mit Anhängen in den Chat senden
const BASE = (process.env.BEEKEEPER_URL || 'https://clean-service.ch.beekeeper.io').replace(/\/+$/,'');
// Je Abteilung ein eigener Bot/Chat:
//   PFS: BEEKEEPER_TOKEN, BEEKEEPER_CHAT_NAME (Standard «PFS: Dispo Springer-Team»), BEEKEEPER_CHAT_ID (optional)
//   UH : BEEKEEPER_TOKEN_UH, BEEKEEPER_CHAT_NAME_UH (Standard «Dispo Springer-Team UH»), BEEKEEPER_CHAT_ID_UH (optional)
const UH_HINT_ID = 'a6112c40-005f-49fe-8439-3d25437d0569';
function ctxFor(dept){
  if(dept==='uh') return { token: process.env.BEEKEEPER_TOKEN_UH, tokenVar:'BEEKEEPER_TOKEN_UH', chatName: process.env.BEEKEEPER_CHAT_NAME_UH || 'Dispo Springer-Team UH', chatId: process.env.BEEKEEPER_CHAT_ID_UH || '', hintId: UH_HINT_ID };
  return { token: process.env.BEEKEEPER_TOKEN, tokenVar:'BEEKEEPER_TOKEN', chatName: process.env.BEEKEEPER_CHAT_NAME || 'PFS: Dispo Springer-Team', chatId: process.env.BEEKEEPER_CHAT_ID || '', hintId:'' };
}

function authHeaders(ctx, scheme){ return { Authorization: `${scheme} ${ctx.token}`, Accept:'application/json' }; }

async function bk(ctx, path, opts, scheme){
  const r = await fetch(BASE + path, { ...opts, headers: { ...authHeaders(ctx, scheme), ...(opts && opts.headers) } });
  const text = await r.text(); let json = null; try{ json = JSON.parse(text); }catch(e){}
  return { ok:r.ok, status:r.status, json, text: text.slice(0,500) };
}
async function withAuth(ctx, path, opts){
  let r = await bk(ctx, path, opts, 'Token');
  if(r.status===401 || r.status===403){ const r2 = await bk(ctx, path, opts, 'Bearer'); if(r2.ok || r2.status!==401) r = r2; }
  return r;
}
function chatList(j){
  if(!j) return [];
  const arr = Array.isArray(j) ? j : (j.conversations || j.chats || j.items || j.data || []);
  return Array.isArray(arr) ? arr : [];
}
async function findChat(ctx){
  if(ctx.chatId) return { id: ctx.chatId, base:'/api/2/conversations' };
  for(const base of ['/api/2/conversations','/api/2/chats']){
    for(let page=0; page<5; page++){
      const r = await withAuth(ctx, `${base}?limit=100&offset=${page*100}`);
      if(!r.ok) break;
      const list = chatList(r.json);
      const hit = list.find(c=> String(c.name||c.title||c.subject||'').trim().toLowerCase() === ctx.chatName.toLowerCase());
      if(hit) return { id: hit.id || hit.conversation_id, base };
      if(list.length<100) break;
    }
  }
  if(ctx.hintId) return { id: ctx.hintId, base:'/api/2/conversations' };
  return null;
}

module.exports = async (req, res) => {
  if(req.method === 'GET' && req.query && req.query.diag){
    // Verbindungstest ohne Geheimnisse: nur Statuscodes + gefundener Chat
    const c = ctxFor(req.query.dept);
    const out = { dept: req.query.dept || 'pfs', tokenGesetzt: !!c.token, chatName: c.chatName };
    if(c.token){
      for(const p of ['/api/2/conversations?limit=1','/api/2/chats?limit=1','/api/2/users/me']){
        const r = await withAuth(c, p); out[p] = r.status;
      }
      const chat = await findChat(c).catch(()=>null);
      out.chatGefunden = !!chat; if(chat) out.chatId = chat.id;
    }
    res.status(200).json(out); return;
  }
  if(req.method !== 'POST'){ res.status(405).json({ error:'Method not allowed' }); return; }
  let body = req.body; if(typeof body==='string'){ try{ body = JSON.parse(body); }catch(e){ res.status(400).json({ error:'Ungültiges JSON' }); return; } }
  body = body || {};
  const ctx = ctxFor(body.dept);
  if(!ctx.token){ res.status(500).json({ error:`${ctx.tokenVar} ist nicht konfiguriert (Vercel -> Environment Variables).` }); return; }
  try{
    if(body.action==='diag'){
      const out = {};
      for(const p of ['/api/2/conversations?limit=5','/api/2/chats?limit=5','/api/2/users/me']){
        const r = await withAuth(ctx, p); out[p] = { status:r.status, sample:r.text.slice(0,200) };
      }
      const chat = await findChat(ctx);
      res.status(200).json({ ok:true, chat, probes:out }); return;
    }
    if(body.action==='upload'){
      if(!body.name || !body.base64){ res.status(400).json({ error:'name/base64 fehlt' }); return; }
      const buf = Buffer.from(body.base64, 'base64');
      const fd = new FormData();
      fd.append('usage_type', 'attachment_file');
      fd.append('file', new Blob([buf], { type:'application/pdf' }), body.name);
      const r = await withAuth(ctx, '/api/2/files', { method:'POST', body: fd });
      if(!r.ok){ res.status(502).json({ error:`Upload fehlgeschlagen (HTTP ${r.status})`, detail:r.text }); return; }
      res.status(200).json({ ok:true, file: r.json }); return;
    }
    if(body.action==='message'){
      const chat = await findChat(ctx);
      if(!chat){ res.status(502).json({ error:`Chat «${ctx.chatName}» wurde nicht gefunden. Token-Rechte bzw. Chat-ID in Vercel prüfen.` }); return; }
      const files = Array.isArray(body.files) ? body.files.filter(Boolean) : [];
      const payload = { text: body.text, body: body.text, message: body.text };
      if(files.length){ payload.files = files; payload.attachments = files; }
      const paths = [`${chat.base}/${chat.id}/messages`, `/api/2/messages`];
      let last = null;
      for(const p of paths){
        const data = p==='/api/2/messages' ? { ...payload, conversation_id: chat.id } : payload;
        const r = await withAuth(ctx, p, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(data) });
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
