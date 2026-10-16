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
  const arr = Array.isArray(j) ? j : (j.chats || j.groups || j.items || j.data || j.conversations || []);
  return Array.isArray(arr) ? arr : [];
}
const CHAT_BASE = '/api/2/chats/groups';
async function listAllChats(ctx){
  const all = []; const seen = new Set(); const meta = { keys: [], pages: 0 };
  let url = CHAT_BASE; let guard = 0;
  while(url && guard++ < 30){
    const r = await withAuth(ctx, url);
    if(!r.ok) break;
    meta.pages++;
    if(r.json && !Array.isArray(r.json) && !meta.keys.length) meta.keys = Object.keys(r.json);
    const list = chatList(r.json);
    let fresh = 0;
    for(const c of list){ if(c && c.id && !seen.has(c.id)){ seen.add(c.id); all.push(c); fresh++; } }
    // Seitenwechsel: next-Link/Cursor, sonst offset
    const j = r.json || {};
    const nxt = j.next || j.next_page || (j.paging && j.paging.next) || (j.pagination && j.pagination.next);
    const cur = j.next_cursor || j.cursor || (j.paging && j.paging.cursor) || (j.pagination && j.pagination.cursor);
    if(typeof nxt === 'string' && nxt){ url = nxt.replace(/^https?:\/\/[^/]+/, ''); }
    else if(cur){ url = `${CHAT_BASE}?cursor=${encodeURIComponent(cur)}`; }
    else if(fresh > 0 && list.length >= 20){ url = `${CHAT_BASE}?offset=${all.length}&limit=${list.length}`; }
    else url = null;
    if(fresh === 0) url = null;
  }
  return { all, meta };
}
async function findChat(ctx){
  if(ctx.chatId) return { id: ctx.chatId, base: CHAT_BASE };
  const want = ctx.chatName.trim().toLowerCase();
  // Die Chat-Liste ist bei Beekeeper auf 200 Einträge begrenzt -> gezielt per Suchbegriff (q) suchen
  const sr = await withAuth(ctx, `${CHAT_BASE}?q=${encodeURIComponent(ctx.chatName)}`);
  if(sr.ok){
    const hits = chatList(sr.json);
    const exact = hits.find(c=> String(c.title||c.name||'').trim().toLowerCase() === want);
    if(exact) return { id: exact.id, base: CHAT_BASE };
  }
  const { all } = await listAllChats(ctx);
  let loose = null;
  for(const c of all){
    const t = String(c.title||c.name||c.subject||'').trim().toLowerCase();
    if(t === want) return { id: c.id, base: CHAT_BASE };
    if(!loose && t && (t.includes(want) || want.includes(t))) loose = { id: c.id, base: CHAT_BASE };
  }
  if(loose) return loose;
  if(ctx.hintId) return { id: ctx.hintId, base: CHAT_BASE };
  return null;
}
async function uploadFile(ctx, name, buf){
  const tries = ['/api/2/files/attachment_file/upload', '/api/2/files/chat_attachment/upload', '/api/2/files'];
  let last = null;
  for(const p of tries){
    const fd = new FormData();
    if(p === '/api/2/files') fd.append('usage_type', 'attachment_file');
    fd.append('file', new Blob([buf], { type:'application/pdf' }), name);
    const r = await withAuth(ctx, p, { method:'POST', body: fd });
    if(r.ok) return { ok:true, file:r.json };
    last = r;
  }
  return { ok:false, last };
}

module.exports = async (req, res) => {
  if(req.method === 'GET' && req.query && req.query.diag){
    // Verbindungstest ohne Geheimnisse: nur Statuscodes + gefundener Chat
    const c = ctxFor(req.query.dept);
    const out = { dept: req.query.dept || 'pfs', tokenGesetzt: !!c.token, chatName: c.chatName };
    if(c.token){
      const la = await listAllChats(c); out.anzahlChats = la.all.length; out.seiten = la.meta.pages; out.antwortFelder = la.meta.keys;
      const me = await withAuth(c, '/api/2/users/me'); out.botName = me.json && String(me.json.name||'').slice(0,60);
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
      for(const p of [CHAT_BASE + '?limit=5','/api/2/users/me']){
        const r = await withAuth(ctx, p); out[p] = { status:r.status };
      }
      const chat = await findChat(ctx);
      res.status(200).json({ ok:true, chat, probes:out }); return;
    }
    if(body.action==='upload'){
      if(!body.name || !body.base64){ res.status(400).json({ error:'name/base64 fehlt' }); return; }
      const up = await uploadFile(ctx, body.name, Buffer.from(body.base64, 'base64'));
      if(!up.ok){ res.status(502).json({ error:`Upload fehlgeschlagen (HTTP ${up.last && up.last.status})`, detail: up.last && up.last.text }); return; }
      res.status(200).json({ ok:true, file: up.file }); return;
    }
    if(body.action==='message'){
      const chat = await findChat(ctx);
      if(!chat){ res.status(502).json({ error:`Chat «${ctx.chatName}» wurde nicht gefunden. Token-Rechte bzw. Chat-ID in Vercel prüfen.` }); return; }
      const files = Array.isArray(body.files) ? body.files.filter(Boolean) : [];
      const post = async (data)=>{
        const r = await withAuth(ctx, `${chat.base}/${chat.id}/messages`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(data) });
        return r;
      };
      // 1. Nachricht: Text (mit @all) + erster Anhang; danach je ein weiterer Anhang pro Nachricht
      let first = { body: body.text };
      if(files[0]) first.attachment = files[0];
      let r = await post({ ...first, mentions:['all'] });
      if(!r.ok && r.status===400) r = await post(first);
      if(!r.ok){ res.status(502).json({ error:`Senden fehlgeschlagen (HTTP ${r.status})`, detail:r.text }); return; }
      for(let i=1;i<files.length;i++){
        const rr = await post({ attachment: files[i] });
        if(!rr.ok){ res.status(502).json({ error:`Anhang ${i+1} konnte nicht gesendet werden (HTTP ${rr.status})`, detail:rr.text }); return; }
      }
      res.status(200).json({ ok:true, result:r.json }); return;
    }
    res.status(400).json({ error:'Unbekannte Aktion' });
  }catch(e){
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
