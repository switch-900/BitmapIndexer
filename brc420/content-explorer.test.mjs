import test from 'node:test';
import assert from 'node:assert/strict';
import {validId,mimeType,category,resolveSource,sourcesFrom,readCatalog,scanSources} from './content-explorer.mjs';

const a='a'.repeat(64)+'i0', b='b'.repeat(64)+'i1', c='c'.repeat(64)+'i2';
test('normalizes MIME types and validates IDs',()=>{
  assert.equal(validId(a),true);assert.equal(validId(a+'/bad'),false);
  assert.equal(mimeType('Model/GLTF-Binary; charset=utf-8'),'model/gltf-binary');
  assert.equal(mimeType('not a mime'),null);
  assert.equal(category('model/gltf-binary'),'3D model');
  assert.equal(category('application/gltf+json'),'3D model');
  assert.equal(category('text/html'),'HTML');
  assert.equal(category('image/svg+xml'),'Image');
  assert.equal(category('application/wasm'),'Code');
  assert.equal(category(null),'Unknown');
});
test('resolves direct and nested delegate metadata',async()=>{
  const meta=new Map([[a,{id:a,delegate:b,content_type:'text/plain'}],[b,{id:b,delegate:c}],[c,{id:c,delegate:null,content_type:'model/gltf-binary',content_length:123}]]);
  const result=await resolveSource(a,id=>meta.get(id));
  assert.deepEqual(result.chain,[a,b,c]);assert.equal(result.resolved_id,c);
  assert.equal(result.mime,'model/gltf-binary');assert.equal(result.bytes,123);
  assert.equal((await resolveSource(c,id=>meta.get(id))).resolved_id,c);
});
test('rejects cycles, missing delegate fields and wrong IDs',async()=>{
  await assert.rejects(resolveSource(a,id=>({id,delegate:id})),/cyclic/);
  await assert.rejects(resolveSource(a,id=>({id,content_type:'text/plain'})),/delegate metadata/);
  await assert.rejects(resolveSource(a,()=>({id:b,delegate:null})),/Unexpected/);
  assert.equal((await resolveSource(a,id=>({id,delegate:null,content_type:null}))).status,'unknown');
});
test('dedupes sources and validates cached records',async()=>{
  assert.deepEqual(sourcesFrom([{source_id:a},{source_id:a},{source_id:b},{source_id:'bad'}]),[a,b]);
  const good=await resolveSource(a,id=>({id,delegate:null,content_type:'image/png'}));
  assert.equal(readCatalog({version:1,records:[good,{...good,source_id:b}]}).size,1);
});
test('resumes classified entries and keeps failures retryable',async()=>{
  const good=await resolveSource(a,id=>({id,delegate:null,content_type:'image/png'}));
  const records=new Map([[a,good]]);
  const seen=[];
  const result=await scanSources([a,b,c],records,id=>{seen.push(id);if(id===b)throw Error('offline');return {id,delegate:null,content_type:'text/html'};});
  assert.deepEqual(seen,[b,c]);assert.equal(result.failures,1);assert.equal(records.get(b).status,'error');assert.equal(records.get(c).status,'resolved');
  await scanSources([a,b,c],records,id=>({id,delegate:null,content_type:'audio/mpeg'}));
  assert.equal(records.get(b).category,'Audio');
});
test('stops after five consecutive failures',async()=>{
  const ids=Array.from({length:8},(_,i)=>'a'.repeat(64)+'i'+i);
  const result=await scanSources(ids,new Map(),()=>{throw Error('offline');});
  assert.equal(result.done,5);assert.equal(result.stopped,true);
});
