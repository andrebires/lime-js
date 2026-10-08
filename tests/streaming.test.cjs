const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Lime, channel } = require('./helpers.cjs');

test('discriminates by own field presence, including null, empty text, and stream-only frames', () => {
  for (const value of [{content:''},{content:null},{stream:'end'}, Object.assign(Object.create(null), { content: 1 }), { content: 1, hasOwnProperty: null }]) assert.equal(Lime.Envelope.isMessage(value), true);
  for (const value of [null, {}, Object.create({ content: 1 })]) assert.equal(Lime.Envelope.isMessage(value), false);
  assert.equal(Lime.Envelope.isCommand({method:'get'}), true);
  assert.equal(Lime.Envelope.isNotification({event:'received'}), true);
  assert.equal(Lime.Envelope.isSession({state:'new'}), true);
});
test('LIME 2 delivers empty and ID-less complete content without correlated receipts or second parsing', () => {
  const { transport, messages } = channel();
  for (const value of [{ type:'text',content:'' },{ type:'text',content:'{"a":1}' },{ type:'json',content:null },{ type:'json',content:'{"a":1}' }]) transport.receive(value);
  assert.deepEqual(messages.map(m => m.content), ['', '{"a":1}', null, '{"a":1}']);
  assert.equal(messages[0].type, 'text/plain');
  assert.equal(transport.sent.length, 0);
});
test('stream only completes on end; receipt carries revision and uses implicit peer routing', () => {
  const { transport, messages, progress, errors } = channel();
  transport.receive({id:'m',rev:2,thread:'t',type:'text',stream:'start'});
  transport.receive({id:'m',rev:2,stream:'data',content:'Hello '});
  transport.receive({id:'m',rev:2,stream:'data',content:'🌎'});
  assert.equal(messages.length, 0); assert.equal(transport.sent.length, 0);
  transport.receive({id:'m',rev:2,stream:'end'});
  assert.equal(messages[0].content, 'Hello 🌎');
  assert.equal(messages[0].thread, 't'); assert.equal(messages[0].stream, undefined);
  assert.deepEqual(transport.sent, [{id:'m',rev:2,to:'server@example',event:'received'}]);
  assert.equal(progress.length, 4); assert.equal(errors.length, 0);
});
test('shared RFC 6902 contract vectors, ownership, fresh revisions and atomic failure', () => {
  const vectors=require('./fixtures/json-patch-vectors.json');
  for(const v of vectors) {
    const a=new Lime.MessageAssembler();
    a.accept({id:'m',type:'json',stream:'start'});
    a.accept({id:'m',stream:'data',content:[{op:'add',path:'',value:v.target}]});
    const input=JSON.stringify(v.patch);
    if(v.error) {
      assert.throws(()=>{a.accept({id:'m',stream:'data',content:v.patch});a.accept({id:'m',stream:'end'});},v.name);
      assert.throws(()=>a.accept({id:'m',stream:'end'}),v.name);
    } else {
      a.accept({id:'m',stream:'data',content:v.patch});
      assert.deepEqual(a.accept({id:'m',stream:'end'}).content,v.expected,v.name);
    }
    assert.equal(JSON.stringify(v.patch),input,v.name);
    a.accept({id:'m',rev:2,type:'json',stream:'start'});
    assert.deepEqual(a.accept({id:'m',rev:2,stream:'end'}).content,{});
  }
  assert.equal({}.polluted,undefined);
});
test('array streaming snapshots caller input and preserves literal null', () => {
  const a=new Lime.MessageAssembler();const input=[{op:'add',path:'/items',value:[]}];
  a.accept({id:'m',type:'json',stream:'start'});a.accept({id:'m',stream:'data',content:input});input[0].value.push('mutated');
  a.accept({id:'m',stream:'data',content:[{op:'add',path:'/items/-',value:null}]});
  assert.deepEqual(a.accept({id:'m',stream:'end'}).content,{items:[null]});
});
test('patch operation, assembled size, result depth and copy-work limits reject streams', () => {
  assert.throws(()=>new Lime.MessageAssembler(undefined,{maxPatchOperations:0}));
  const assemble=(limits,patches)=>{
    const a=new Lime.MessageAssembler(undefined,limits);a.accept({id:'m',type:'json',stream:'start'});
    for(const patch of patches)a.accept({id:'m',stream:'data',content:patch});
    return a.accept({id:'m',stream:'end'}).content;
  };
  assert.throws(()=>assemble({maxPatchOperations:1},[[{op:'add',path:'/a',value:1},{op:'add',path:'/b',value:2}]]),/operation limit/);
  assert.throws(()=>assemble({maxJsonDepth:2},[[{op:'add',path:'/a',value:{}},{op:'add',path:'/a/b',value:{}},{op:'add',path:'/a/b/c',value:1}]]),/nesting/);
  assert.throws(()=>assemble({maxJsonDepth:2},[[{op:'add',path:'/a',value:{x:1}},{op:'add',path:'/b',value:{}},{op:'copy',from:'/a',path:'/b/c'}]]),/nesting/);
  // A single compact copy batch can enlarge state beyond the document limit.
  const value='x'.repeat(150);
  assert.throws(()=>assemble({maxContentBytes:600},[
    [{op:'add',path:'/a',value}],
    [{op:'copy',from:'/a',path:'/b'},{op:'copy',from:'/a',path:'/c'},{op:'copy',from:'/a',path:'/d'}]
  ]),/limit/);
  assert.throws(()=>assemble({maxContentBytes:600},[
    [{op:'add',path:'/a',value}],
    Array.from({length:6},()=>[{op:'copy',from:'/a',path:'/b'},{op:'remove',path:'/b'}]).flat()
  ]),/copy work/);
  assert.deepEqual(assemble({},[[{op:'add',path:'/a',value:{x:1}},{op:'move',from:'/a/x',path:'/b'}]]),{a:{},b:1});
});
test('routing, revision and thread isolate simultaneous assemblies', () => {
  const { transport, messages, errors } = channel({},false);
  transport.receive({id:'m',from:'a@example',type:'text',stream:'start'});
  transport.receive({id:'m',from:'b@example',type:'text',stream:'start'});
  transport.receive({id:'m',from:'a@example',rev:2,type:'text',stream:'start'});
  for (const [from,rev,content] of [['a@example',1,'A'],['b@example',1,'B'],['a@example',2,'C']]) {
    transport.receive({id:'m',from,rev,stream:'data',content}); transport.receive({id:'m',from,rev,stream:'end'});
  }
  assert.deepEqual(messages.map(m=>m.content),['A','B','C']); assert.equal(errors.length,0);
});
test('invalid revisions, stream grammar, aliases and content never complete or acknowledge', () => {
  const { transport, messages, errors } = channel();
  const bad = [
    ...[null,0,-1,1.5,'1',9007199254740992].map(rev=>({id:'m',rev,type:'text',content:'bad'})),
    {id:'',type:'text',content:'bad'}, {id:1,type:'text',content:'bad'}, {type:'text'}, {content:'a'},
    {type:'text',content:'a',thread:null}, {id:'m',stream:'wat'}, {stream:'start',type:'text'},
    {id:'m',stream:'start',type:'text',content:''}, {id:'m',stream:'start'},
    {id:'m',stream:'data'}, {id:'m',stream:'data',type:'text',content:''},
    {id:'m',stream:'end',content:''}, {id:'m',stream:'end',type:'text'},
    {id:'m',stream:'data',content:null}, {id:'m',stream:'end'},
    {id:'m',type:'invented',content:''}, {id:'m',type:'text',content:3},
    {id:'m',type:'image/png',stream:'start'}, {id:'m',type:'json',content:undefined},
    {id:'m',type:'json',content:NaN}, {id:'m',type:'json',content:new Date()},
    {id:'m',type:'text',content:'a',event:'received'}, {}, null
  ];
  for (const envelope of bad) transport.receive(envelope);
  assert.equal(errors.length,bad.length); assert.equal(messages.length,0); assert.equal(transport.sent.length,0);
});
test('bad stream data abandons assembly and prevents a later end from succeeding', () => {
  const { transport, errors, messages } = channel();
  transport.receive({id:'m',thread:'t',type:'text',stream:'start'});
  transport.receive({id:'m',thread:'wrong',stream:'data',content:'bad'});
  transport.receive({id:'m',stream:'end'});
  assert.equal(errors.length,2); assert.equal(messages.length,0); assert.equal(transport.sent.length,0);
});
test('bounds active streams, UTF-8 content, JSON depth and cumulative contribution work', () => {
  for (const limits of [{maxStreams:0},{maxContentBytes:-1},{maxJsonDepth:1.5}]) assert.throws(()=>new Lime.MessageAssembler(undefined,limits));
  const assembly = new Lime.MessageAssembler(undefined,{maxStreams:1,maxContentBytes:12,maxJsonDepth:2});
  assembly.accept({id:'a',type:'text',stream:'start'});
  assert.throws(()=>assembly.accept({id:'a',type:'text',stream:'start'}),/already/);
  assert.throws(()=>assembly.accept({id:'b',type:'text',stream:'start'}),/capacity/);
  assembly.accept({id:'a',stream:'data',content:'1234'});
  assembly.accept({id:'a',stream:'data',content:'5678'});
  assert.throws(()=>assembly.accept({id:'a',stream:'data',content:'9'}),/limit/);
  assembly.reset();
  assert.throws(()=>assembly.accept({id:'a',type:'text',content:'🌎🌎🌎'}),/limit/);
  assert.throws(()=>assembly.accept({id:'a',type:'json',content:{a:{b:{c:1}}}}),/nesting/);
});
test('a full retry replaces an unfinished stream; callbacks can refuse receipt', () => {
  const { client, transport, messages } = channel();
  transport.receive({id:'m',type:'text',stream:'start'});
  transport.receive({id:'m',stream:'data',content:'partial'});
  transport.receive({id:'m',type:'text',content:'complete'});
  assert.deepEqual(messages.map(m=>m.content),['complete']);
  client.onMessage = () => { throw new Error('Schema refused'); };
  assert.throws(()=>transport.receive({id:'x',type:'json',content:{}}),/Schema refused/);
  assert.equal(transport.sent.length,1);
});
test('built-in aliases are enumerated and immutable; custom mappings reset per session', () => {
  const registry = new Lime.ContentTypeRegistry();
  assert.equal(Object.keys(Lime.ContentTypeAliases).length,9);
  for (const [alias,type] of Object.entries(Lime.ContentTypeAliases)) assert.equal(registry.resolve(alias),type);
  registry.register('card','application/vnd.example.card+json');
  registry.register('card','application/vnd.example.card+json');
  assert.equal(registry.resolve('card'),'application/vnd.example.card+json');
  assert.throws(()=>registry.register('text','application/json'),/immutable/);
  assert.throws(()=>registry.register('BAD','application/json'),/Invalid/);
  assert.throws(()=>registry.resolve('__proto__'),/Unknown/);
  registry.reset(); assert.throws(()=>registry.resolve('card'));
});
test('UTF-8 bounds agree with an independent byte oracle for BMP, astral, escaped, and unpaired text', () => {
  const values = ['', 'ASCII', '"\\\n', '\u0080', '\u07ff', '\u0800', 'é', '中文', '🌎', '\ud800', '\udc00', 'a🌎中é'];
  for (const value of values) {
    const bytes = Buffer.byteLength(JSON.stringify(value),'utf8');
    const assembly = new Lime.MessageAssembler(undefined,{maxContentBytes:bytes});
    assert.equal(assembly.accept({type:'text',content:value}).content,value);
    const tooSmall = new Lime.MessageAssembler(undefined,{maxContentBytes:bytes-1});
    assert.throws(()=>tooSmall.accept({type:'text',content:value}),/limit/);
  }
});
test('empty contributions still consume a bounded stream budget', () => {
  const assembly=new Lime.MessageAssembler(undefined,{maxContentBytes:4});
  assembly.accept({id:'m',type:'text',stream:'start'});
  assembly.accept({id:'m',stream:'data',content:''});assembly.accept({id:'m',stream:'data',content:''});
  assert.throws(()=>assembly.accept({id:'m',stream:'data',content:''}),/limit/);
});

test('sparse arrays are rejected before cached document sizes can diverge from JSON', () => {
  const a=new Lime.MessageAssembler();
  assert.throws(()=>a.accept({type:'json',content:Array(1)}),/JSON value/);
  a.accept({id:'m',type:'json',stream:'start'});
  assert.throws(()=>a.accept({id:'m',stream:'data',content:[{op:'add',path:'/items',value:Array(1)}]}),/JSON value/);
  assert.throws(()=>a.accept({id:'m',stream:'end'}),/not started/);
  const {transport,messages,errors}=channel();
  transport.receive({id:'m',type:'json',stream:'start'});
  transport.receive({id:'m',stream:'data',content:[{op:'add',path:'/items',value:Array(1)}]});
  transport.receive({id:'m',stream:'end'});
  assert.equal(messages.length,0);assert.equal(errors.length,2);assert.equal(transport.sent.length,0);
});

test('assembler abandons malformed and oversized contributions before a later end', () => {
  for (const [type,content,limits] of [['json',Infinity,{}],['text',7,{}],['text','oversized',{maxContentBytes:4}]]) {
    const a=new Lime.MessageAssembler(undefined,limits);
    a.accept({id:'m',type,stream:'start'});
    assert.throws(()=>a.accept({id:'m',stream:'data',content}));
    assert.throws(()=>a.accept({id:'m',stream:'end'}),/not started/);
  }
});
