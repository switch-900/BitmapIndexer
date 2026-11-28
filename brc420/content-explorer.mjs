const ID = /^[a-f0-9]{64}i(?:0|[1-9]\d{0,9})$/;
const PUBLIC_ORD = 'https://ordinals.com';
export const validId = id => typeof id === 'string' && ID.test(id);
export function mimeType(value) {
  const mime = typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : null;
}
export function category(mime) {
  if (!mime) return 'Unknown';
  if (mime.startsWith('model/') || ['application/gltf+json','application/gltf-buffer'].includes(mime)) return '3D model';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'HTML';
  if (mime === 'application/json' || mime.endsWith('+json')) return 'JSON';
  if (mime.includes('javascript') || mime.includes('ecmascript') || ['application/wasm','text/css','text/typescript','text/x-python'].includes(mime)) return 'Code';
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.startsWith('font/') || ['application/font-woff','application/vnd.ms-fontobject'].includes(mime)) return 'Font';
  if (mime === 'application/pdf') return 'Document';
  if (mime.startsWith('text/')) return 'Text';
  return 'Other';
}
export async function resolveSource(source, getMetadata) {
  if (!validId(source)) throw new Error('Invalid source inscription ID');
  const chain = [];
  let id = source;
  while (chain.length < 32) {
    if (!validId(id) || chain.includes(id)) throw new Error('Invalid or cyclic delegate chain');
    chain.push(id);
    const meta = await getMetadata(id);
    if (!meta || meta.id !== id) throw new Error('Unexpected inscription metadata');
    if (meta.delegate != null) {
      id = meta.delegate;
      continue;
    }
    // An omitted delegate field is not proof that this endpoint supports delegation.
    if (!Object.hasOwn(meta, 'delegate')) throw new Error('Ord endpoint did not return delegate metadata');
    const mime = mimeType(meta.content_type);
    return { source_id: source, resolved_id: id, chain, mime, declared_type: typeof meta.content_type === 'string' ? meta.content_type : null,
      category: category(mime), bytes: Number.isSafeInteger(meta.content_length) && meta.content_length >= 0 ? meta.content_length : null,
      status: mime ? 'resolved' : 'unknown' };
  }
  throw new Error('Delegate chain exceeds 32 inscriptions');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function metadataClient(base = PUBLIC_ORD, signal) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Ord URL must be an HTTP(S) origin');
  const cache = new Map();
  let last = 0;
  async function get(id) {
    if (!validId(id)) throw new Error('Invalid inscription ID');
    if (cache.has(id)) return cache.get(id);
    const request = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) throw new Error('Scan cancelled');
        const slot = Math.max(Date.now(), last + 350); last = slot;
        await sleep(Math.max(0, slot - Date.now()));
        if (signal?.aborted) throw new Error('Scan cancelled');
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, {once:true});
        const timer = setTimeout(abort, 15000);
        try {
          const res = await fetch(new URL('/r/inscription/' + id, url), {signal:controller.signal, credentials:'omit', redirect:'error', headers:{Accept:'application/json'}});
          if (res.status === 429 || res.status >= 500) {
            const raw = res.headers.get('retry-after');
            const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
            const dateDelay = raw && !seconds ? Date.parse(raw) - Date.now() : 0;
            const delay = Math.max(2000 * (attempt+1), seconds*1000, Number.isFinite(dateDelay) ? dateDelay : 0);
            if (attempt === 2 || delay > 60000) throw new Error('Ord rate limited or unavailable (HTTP ' + res.status + ')');
            last = Math.max(last, Date.now() + delay);
            continue;
          }
          if (!res.ok) throw new Error('Ord HTTP ' + res.status);
          if (!/^application\/json\b/i.test(res.headers.get('content-type') || '')) throw new Error('Expected JSON from Ord');
          const reader = res.body?.getReader();
          if (!reader) throw new Error('Empty metadata');
          let size = 0; const chunks = [];
          try {
            while (true) {
              const {done, value} = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 262144) { await reader.cancel(); throw new Error('Metadata exceeds limit'); }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          return JSON.parse(new TextDecoder().decode(bytes));
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      }
      throw new Error('Ord request failed');
    })();
    cache.set(id, request);
    try { return await request; } catch (e) { cache.delete(id); throw e; }
  }
  return get;
}
export function sourcesFrom(deploys) {
  if (!Array.isArray(deploys)) throw new Error('Invalid deployment manifest');
  return [...new Set(deploys.map(d => d?.source_id).filter(validId))];
}
export function readCatalog(data) {
  const records = new Map();
  if (data?.version !== 1 || !Array.isArray(data.records)) return records;
  for (const row of data.records) {
    if (!validId(row?.source_id) || !validId(row.resolved_id) || row.status !== 'resolved' || !mimeType(row.mime)) continue;
    if (!Array.isArray(row.chain) || row.chain.length < 1 || row.chain.length > 32 || row.chain[0] !== row.source_id || row.chain.at(-1) !== row.resolved_id || !row.chain.every(validId) || new Set(row.chain).size !== row.chain.length) continue;
    const mime = mimeType(row.mime);
    records.set(row.source_id, {...row, mime, category:category(mime)});
  }
  return records;
}
export async function scanSources(sources, records, get, {signal, progress = () => {}, checkpoint = async () => {}} = {}) {
  const pending = sources.filter(id => records.get(id)?.status !== 'resolved');
  let done = 0, failures = 0, consecutive = 0;
  for (const id of pending) {
    if (signal?.aborted) break;
    try { records.set(id, await resolveSource(id, get)); consecutive = 0; }
    catch (err) {
      if (signal?.aborted) break;
      records.set(id, {source_id:id, status:'error', category:'Unknown', error:String(err?.message || err).slice(0,200)});
      failures++; consecutive++;
    }
    done++;
    progress({done,total:pending.length,failures});
    if (done % 25 === 0) await checkpoint();
    if (consecutive >= 5) break;
  }
  await checkpoint();
  return {done,total:pending.length,failures,stopped:done < pending.length};
}
function catalogData(sources, records) {
  return {version:1, updated_at:new Date().toISOString(), records:sources.filter(id => records.has(id)).map(id => records.get(id))};
}

async function cli() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--ord')) throw new Error('Usage: node brc420/content-explorer.mjs [--ord http://127.0.0.1:80]');
  const base = args[1] || PUBLIC_ORD;
  const dir = path.dirname((await import('node:url')).fileURLToPath(import.meta.url));
  const manifest = JSON.parse(await fs.readFile(path.join(dir,'deploys.json'),'utf8'));
  const sources = sourcesFrom(manifest);
  const dest = path.join(dir,'content-types.json');
  let records = new Map();
  try { records = readCatalog(JSON.parse(await fs.readFile(dest,'utf8'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const save = async () => {
    const temporary = dest + '.' + process.pid + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(catalogData(sources,records)) + '\n', {flag:'w'});
    await fs.rename(temporary,dest);
  };
  const result = await scanSources(sources,records,metadataClient(base,controller.signal),{
    signal:controller.signal,checkpoint:save,
    progress:({done,total,failures}) => { if (done % 25 === 0 || done === total) console.log(done + '/' + total + ' checked; ' + failures + ' errors'); }
  });
  console.log(JSON.stringify({...result, resolved:sources.filter(id => records.get(id)?.status === 'resolved').length, output:dest}));
  if (result.stopped || sources.some(id => records.get(id)?.status !== 'resolved')) process.exitCode = 1;
}

async function browser() {
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
  const link = (label, type, id) => {
    const node = el('a',label); if (!validId(id)) return el('span','—');
    node.href = PUBLIC_ORD + '/' + type + '/' + id; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node;
  };
  const response = await fetch('./deploys.json',{credentials:'omit'});
  if (!response.ok) throw new Error('Deployment index unavailable: ' + response.status);
  const deploys = await response.json();
  const sources = sourcesFrom(deploys);
  let records = new Map();
  try {
    const response = await fetch('./content-types.json',{credentials:'omit'});
    if (response.ok) records = readCatalog(await response.json());
  } catch { /* optional prebuilt catalogue */ }
  try {
    const local = readCatalog(JSON.parse(localStorage.getItem('brc420-content-v1') || 'null'));
    for (const id of sources) if (!records.has(id) && local.has(id)) records.set(id,local.get(id));
  } catch { /* storage unavailable */ }
  let page = 0, shown = [], controller = null;
  const limit = 40;
  const persist = () => { try { localStorage.setItem('brc420-content-v1',JSON.stringify(catalogData(sources,records))); } catch {} };
  const options = () => {
    for (const [id, values] of [
      ['category', [...new Set([...records.values()].map(r=>r.category))].filter(x=>x !== 'Unknown').sort()],
      ['mime', [...new Set([...records.values()].map(r=>r.mime).filter(Boolean))].sort()]
    ]) {
      const select = $(id), old = select.value;
      select.replaceChildren(new Option(id === 'category' ? 'All content categories' : 'All MIME types',''));
      if (id === 'category') select.add(new Option('Unknown / unchecked','Unknown'));
      for (const v of values) select.add(new Option(v,v));
      select.value = [...select.options].some(o=>o.value===old) ? old : '';
    }
  };
  function filtered() {
    const q = $('search').value.trim().toLowerCase(), cat = $('category').value, mime = $('mime').value, status = $('collection').value;
    return deploys.filter(d => {
      const record = records.get(d.source_id);
      const minted = d.max > 0 && d.mints >= d.max;
      return (!q || [d.name,d.id,d.source_id,record?.resolved_id].some(v=>String(v||'').toLowerCase().includes(q))) &&
        (!cat || (record?.category || 'Unknown') === cat) && (!mime || record?.mime === mime) &&
        (!status || (status==='minted-out' ? minted : !minted));
    });
  }
  function render() {
    shown = filtered();
    page = Math.min(page,Math.max(0,Math.ceil(shown.length/limit)-1));
    const list = $('results'); list.replaceChildren();
    const count = sources.filter(id=>records.get(id)?.status==='resolved').length;
    $('summary').textContent = deploys.length.toLocaleString() + ' deployments · ' + count.toLocaleString() + '/' + sources.length.toLocaleString() + ' unique sources classified · ' + shown.length.toLocaleString() + ' matching';
    $('page').textContent = 'Page ' + (page+1) + ' of ' + Math.max(1,Math.ceil(shown.length/limit));
    $('prev').disabled = page===0; $('next').disabled = (page+1)*limit>=shown.length;
    $('export').disabled = !shown.length;
    if (!shown.length) list.append(el('p','No matching deployments.'));
    for (const d of shown.slice(page*limit,(page+1)*limit)) {
      const r = records.get(d.source_id);
      const card = el('article',null,'asset');
      card.append(el('h2',d.name || 'Unnamed deployment'),el('p',(r?.category || 'Unknown') + ' · ' + (r?.mime || (r?.status==='error'?'Lookup failed':r?.status==='unknown'?'No declared MIME':'Not checked')),'type'));
      if (r?.error) card.append(el('p',r.error,'muted'));
      if (Number.isSafeInteger(r?.bytes)) card.append(el('p',r.bytes.toLocaleString()+' bytes','muted'));
      const ids = el('dl');
      for (const [label,id] of [['Deployment',d.id],['Source',d.source_id],['Resolved delegate',r?.resolved_id]]) {
        ids.append(el('dt',label)); const dd=el('dd'); dd.append(validId(id)?link(id,'inscription',id):el('span','—')); ids.append(dd);
      }
      card.append(ids,el('p',Number(d.mints||0).toLocaleString()+' / '+Number(d.max||0).toLocaleString()+' mints','muted'));
      const actions=el('div',null,'actions');
      actions.append(link('Actual source content','content',d.source_id),link('Ord preview','preview',d.source_id));
      if (validId(r?.resolved_id) && r.resolved_id !== d.source_id) actions.append(link('Delegate content','content',r.resolved_id));
      if (validId(d.source_id)) {
        const button=el('button','Preview here');
        button.type='button';
        button.addEventListener('click',()=>{
          const existing=card.querySelector('iframe');
          if(existing){existing.remove();button.textContent='Preview here';return;}
          const frame=el('iframe'); frame.title='Isolated inscription preview'; frame.setAttribute('sandbox','allow-scripts'); frame.referrerPolicy='no-referrer';
          frame.src=PUBLIC_ORD+'/preview/'+d.source_id; card.append(frame); button.textContent='Close preview';
        });
        actions.append(button);
      }
      card.append(actions); list.append(card);
    }
  }
  for (const id of ['search','category','mime','collection']) $(id).addEventListener(id==='search'?'input':'change',()=>{page=0;render();});
  $('prev').addEventListener('click',()=>{page--;render();$('results').scrollIntoView({block:'start'});});
  $('next').addEventListener('click',()=>{page++;render();$('results').scrollIntoView({block:'start'});});
  $('export').addEventListener('click',()=>{
    const data=shown.map(d=>({deploy_id:d.id,name:d.name,source_id:d.source_id,mints:d.mints,max:d.max,content:records.get(d.source_id)||{status:'unchecked'}}));
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=el('a');a.href=url;a.download='brc420-filtered.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  $('stop').addEventListener('click',()=>controller?.abort());
  $('scan').addEventListener('click',async()=>{
    if(controller)return;
    controller=new AbortController();$('scan').disabled=true;$('stop').disabled=false;
    $('progress').textContent='Checking Ord metadata…';
    try {
      const result=await scanSources(sources,records,metadataClient(PUBLIC_ORD,controller.signal),{
        signal:controller.signal,checkpoint:async()=>{persist();options();render();},
        progress:({done,total,failures})=>{$('progress').textContent=done+'/'+total+' checked · '+failures+' errors';}
      });
      $('progress').textContent=result.stopped?'Scan paused. If Ord is unavailable or blocks cross-origin requests, generate content-types.json using the Node script. Retry resumes unresolved sources.':'Scan finished. '+result.failures+' lookup errors; retry to recheck.';
    } catch(e){$('progress').textContent=String(e.message||e);}
    finally {controller=null;$('scan').disabled=false;$('stop').disabled=true;persist();options();render();}
  });
  options();render();$('scan').disabled=false;
}
if (typeof document !== 'undefined') {
  browser().catch(e=>{document.getElementById('progress').textContent=String(e.message||e);});
} else if (typeof process !== 'undefined' && process.argv[1]) {
  const {pathToFileURL}=await import('node:url');
  if (pathToFileURL(process.argv[1]).href===import.meta.url) cli().catch(e=>{console.error(e.message);process.exitCode=1;});
}
