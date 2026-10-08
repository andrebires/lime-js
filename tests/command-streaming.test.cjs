const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Lime,FakeTransport,channel}=require('./helpers.cjs');
const vectors=require('./fixtures/command-stream-vectors.json');
test('shared command stream grammar and lifecycle fixtures',()=>{
 for(const v of vectors){
  const a=new Lime.CommandAssembler();
  for(const s of v.steps){
   const run=()=>a.accept(s.envelope,s.direction);
   if(s.error){assert.throws(run,v.name);continue;}
   const r=run();assert.equal(!!r.command,!!s.expect,v.name);
   if(s.expect)for(const [k,value]of Object.entries(s.expect)){if(k==='noResource')assert.equal(Object.hasOwn(r.command,'resource'),false);else assert.deepEqual(r.command[k],value,`${v.name}: ${k}`);}
  }
  assert.equal(a.size,v.active,v.name);a.reset();assert.equal(a.size,0);
 }
});
function pair(){
 const lt=new FakeTransport(),rt=new FakeTransport();
 const left=new Lime.ClientChannel(lt,true,false,{retryInterval:0}),right=new Lime.ClientChannel(rt,true,false,{retryInterval:0});
 left.onSession({id:'s',state:'established',from:'right',to:'left'});right.onSession({id:'s',state:'established',from:'left',to:'right'});
 lt.respond=e=>rt.receive(JSON.parse(JSON.stringify(e)));rt.respond=e=>lt.receive(JSON.parse(JSON.stringify(e)));
 return {left,right,lt,rt};
}
test('serialized streamed request invokes only at end and independent response resolves only with terminal status',async()=>{
 const {left,right,lt,rt}=pair();const calls=[],progress=[];left.onCommandProgress=(c,response)=>progress.push([c.stream,response]);
 right.onCommand=c=>{calls.push(c);right.sendCommand({id:c.id,method:c.method,type:'json',stream:'start'});right.sendCommand({id:c.id,method:c.method,stream:'data',resource:[{op:'add',path:'/items',value:[null]},{op:'add',path:'/items/-',value:2}]});};
 const result=left.processCommand({id:'c',method:'set',uri:'/draft',type:'text',stream:'start'});let resolved=false;result.then(()=>resolved=true);
 left.sendCommand({id:'c',method:'set',stream:'data',resource:'Hello '});left.sendCommand({id:'c',method:'set',stream:'data',resource:'world!'});
 assert.equal(calls.length,0);assert.equal(rt.sent.length,0);
 left.sendCommand({id:'c',method:'set',stream:'end'});await Promise.resolve();assert.equal(resolved,false);assert.equal(calls[0].resource,'Hello world!');
 right.sendCommand({id:'c',method:'set',stream:'end',status:'success'});
 assert.deepEqual((await result).resource,{items:[null,2]});assert.deepEqual(progress,[['start',true],['data',true]]);
 assert.equal(left.activeCommandCount,0);assert.equal(right.activeCommandCount,0);assert.equal(left.pendingMessageCount,0);assert.ok([...lt.sent,...rt.sent].every(e=>!e.event));left.dispose();right.dispose();
});
test('early failure discards input and failure end never returns partial resource',async()=>{
 const {client,transport}=channel();let p=client.processCommand({id:'c',method:'set',uri:'/x',type:'json',stream:'start'});
 transport.receive({id:'c',method:'set',status:'failure',reason:{code:100}});assert.equal((await p).status,'failure');assert.throws(()=>client.sendCommand({id:'c',method:'set',stream:'end'}),/matching request/);
 p=client.processCommand({id:'d',method:'get',uri:'/x'});transport.receive({id:'d',method:'get',stream:'start',type:'text'});transport.receive({id:'d',method:'get',stream:'data',resource:'provisional'});transport.receive({id:'d',method:'get',stream:'end',status:'failure',reason:{code:100}});
 const failed=await p;assert.equal(failed.status,'failure');assert.equal(Object.hasOwn(failed,'resource'),false);assert.equal(Object.hasOwn(failed,'type'),false);assert.equal(client.activeCommandCount,0);client.dispose();
});
test('response peer, method and recipient guards prevent unrelated completion',async()=>{
 const {client,transport,errors}=channel();const p=client.processCommand({id:'c',method:'get',uri:'/x'});
 transport.receive({id:'c',method:'get',stream:'start',type:'text',from:'stranger'});transport.receive({id:'c',method:'get',stream:'start',type:'text',to:'other'});
 assert.equal(client.pendingCommandCount,1);assert.equal(errors.length,2);
 const rejected=assert.rejects(p,/method mismatch/);transport.receive({id:'c',method:'set',stream:'start',type:'text'});await rejected;assert.equal(client.activeCommandCount,0);client.dispose();
});
test('request and response timeouts are absolute, release assemblies and never trigger retries',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {client,transport,errors}=channel({commandStreamTimeout:20});const timeouts=[];client.onCommandError=e=>timeouts.push(e);
 const p=client.processCommand({id:'c',method:'get',uri:'/x'},10);const rejected=assert.rejects(p,/unconfirmed/);
 transport.receive({id:'c',method:'get',type:'text',stream:'start'});t.mock.timers.tick(9);transport.receive({id:'c',method:'get',stream:'data',resource:'x'});t.mock.timers.tick(1);await rejected;assert.equal(client.activeCommandCount,0);
 transport.receive({id:'c',method:'get',stream:'end',status:'success'});assert.equal(errors.length,1);
 transport.receive({id:'remote',method:'set',uri:'/x',type:'text',stream:'start'});t.mock.timers.tick(19);transport.receive({id:'remote',method:'set',stream:'data',resource:'x'});t.mock.timers.tick(1);assert.equal(timeouts.length,1);assert.equal(client.activeCommandCount,0);
 client.sendCommand({id:'raw',method:'get',uri:'/x'});t.mock.timers.tick(20);assert.equal(timeouts.length,2);assert.equal(client.activeCommandCount,0);client.retryUnacknowledged();assert.equal(transport.sent.length,2);client.dispose();
});
test('bounded exchanges and resources reject without leaving a later invocation',()=>{
 for(const value of [0,-1,Infinity,2147483648])assert.throws(()=>channel({commandStreamTimeout:value}));
 assert.throws(()=>new Lime.CommandAssembler(undefined,{},-1));
 const a=new Lime.CommandAssembler(undefined,{maxStreams:1,maxContentBytes:80},2);
 a.accept({id:'a',method:'set',uri:'/x',type:'json',stream:'start'},'incoming');
 assert.throws(()=>a.accept({id:'b',method:'set',uri:'/x',type:'text',stream:'start'},'incoming'),/capacity/);
 assert.throws(()=>a.accept({id:'a',method:'set',stream:'data',resource:[{op:'add',path:'/x',value:'x'.repeat(100)}]},'incoming'),/limit/);assert.equal(a.size,0);
 a.accept({id:'a',method:'get',uri:'/x'},'outgoing');a.accept({id:'b',method:'get',uri:'/x'},'outgoing');assert.throws(()=>a.accept({id:'c',method:'get',uri:'/x'},'outgoing'),/capacity/);
 a.reset();assert.equal(a.size,0);
});
test('send errors, session finish and LIME 1 rejection release command streams',async()=>{
 const {client,transport}=channel();let p=client.processCommand({id:'c',method:'set',uri:'/x',type:'text',stream:'start'});const rejected=assert.rejects(p,/send failed/);transport.failSend=true;assert.throws(()=>client.sendCommand({id:'c',method:'set',stream:'data',resource:'x'}),/send failed/);await rejected;assert.equal(client.activeCommandCount,0);
 transport.failSend=false;p=client.processCommand({id:'d',method:'get',uri:'/x'});const disposed=assert.rejects(p,/disposed/);transport.receive({id:'d',method:'get',type:'text',stream:'start'});client.dispose();await disposed;assert.equal(client.activeCommandCount,0);
 const legacy=channel({version:1});assert.throws(()=>legacy.client.sendCommand({id:'x',method:'get',uri:'/x',type:'text',stream:'start'}),/LIME 1/);legacy.transport.receive({id:'x',method:'get',type:'text',stream:'start'});assert.equal(legacy.errors.length,1);legacy.client.dispose();
});

test('command routing and direction are strict; ordinary legacy commands stay available',()=>{
 const a=new Lime.CommandAssembler();assert.equal(a.accept({method:'observe',uri:'/x'},'incoming').command.method,'observe');assert.equal(a.size,0);assert.throws(()=>a.accept({id:'c',method:'get',uri:'/x'},'bogus'),/direction/);
 a.accept({id:'c',from:'peer',to:'local',method:'set',uri:'/x',type:'text',stream:'start'},'incoming');
 assert.throws(()=>a.accept({id:'c',from:'peer',to:'elsewhere',method:'set',stream:'data',resource:'x'},'incoming'),/routing/);assert.equal(a.size,0);
 const v1=channel({version:1});v1.client.sendCommand({id:'c',method:'get',uri:'/x'});assert.equal(v1.transport.sent.length,1);v1.client.dispose();
 const v2=channel();v2.transport.receive({type:'json',content:{},resource:null});assert.equal(v2.errors.length,1);assert.equal(v2.messages.length,0);v2.client.dispose();
});

test('strict command fields and failure values cannot reach application handlers',()=>{
 const {client,transport,errors,commands}=channel();
 for(const e of [{id:'x',method:'get',uri:'/x',scope:'message'},{id:'x',method:'get',uri:''},{id:'x',method:'get',status:'pending'},{id:'x',method:'get',status:'failure',reason:{code:1.2}},{id:'x',method:'get',status:'failure',reason:{code:100,description:3}}])transport.receive(e);
 assert.equal(errors.length,5);assert.equal(commands.length,0);assert.equal(client.activeCommandCount,0);client.dispose();
});

test('rejected provisional requests and competing families cannot invoke a later end',()=>{
 const {client,transport,commands,errors}=channel();
 client.onCommandProgress=(c,response)=>{if(!response&&c.stream==='data')client.sendCommand({id:c.id,to:c.from,method:c.method,status:'failure',reason:{code:100}});};
 transport.receive({id:'early',method:'set',uri:'/x',type:'text',stream:'start'});transport.receive({id:'early',method:'set',stream:'data',resource:'partial'});transport.receive({id:'early',method:'set',stream:'end'});
 assert.equal(commands.length,0);assert.equal(client.activeCommandCount,0);assert.equal(transport.sent[0].status,'failure');
 client.onCommandProgress=()=>{};
 transport.receive({id:'mixed',method:'set',uri:'/x',type:'text',stream:'start'});transport.receive({id:'mixed',method:'set',stream:'data',resource:'x',content:'x'});transport.receive({id:'mixed',method:'set',stream:'end'});
 assert.equal(commands.length,0);assert.equal(client.activeCommandCount,0);assert.equal(errors.length,3);client.dispose();
});
