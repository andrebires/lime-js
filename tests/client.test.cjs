const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Lime, FakeTransport, channel } = require('./helpers.cjs');
const msg = (id, more={}) => ({id,type:'text',content:'Hello',...more});
const receipt = (id, more={}) => ({id,event:'received',...more});

test('short HTTP-authenticated handshake sends version 2 once and accepts missing routing', async () => {
  const transport = new FakeTransport(); const client = new Lime.ClientChannel(transport);
  transport.respond = envelope => { if (envelope.state==='new') transport.receive({id:'s1',state:'established'}); };
  const session = await client.establishSession();
  assert.equal(session.id,'s1'); assert.deepEqual(transport.sent,[{state:'new',version:2}]);
  client.dispose();
});
test('LIME 1 mode retains unversioned negotiation, fallback authentication and legacy notification vocabulary', async () => {
  const transport = new FakeTransport(); const client = new Lime.ClientChannel(transport,true,false,{version:1});
  transport.respond = envelope => {
    if (envelope.state==='new') transport.receive({id:'old',state:'negotiating',compressionOptions:['gzip'],encryptionOptions:['tls']});
    else if (envelope.state==='negotiating') {
      transport.receive({id:'old',state:'negotiating',compression:'gzip',encryption:'tls'});
      transport.receive({id:'old',state:'authenticating',compression:'gzip',encryption:'tls'});
    } else if (envelope.state==='authenticating') transport.receive({id:'old',state:'established',from:'server',to:'alice@example/i'});
  };
  await client.establishSession(undefined,undefined,'alice@example',new Lime.PlainAuthentication('secret'),'i');
  assert.equal(transport.sent.length,3); assert.deepEqual(transport.sent[0],{state:'new'});
  assert.equal(transport.sent[1].compression,'gzip'); assert.equal(transport.encryption,'tls');
  assert.equal(transport.sent[2].from,'alice@example/i');
  client.sendMessage(msg('m',{type:'application/custom',content:42}));
  client.sendNotification({id:'m',event:'accepted'});
  assert.equal(client.pendingMessageCount,0);
  assert.throws(()=>client.sendMessage({id:'m',type:'text',stream:'start'}),/LIME 1/);
  assert.throws(()=>transport.receive({id:'m',type:'text',stream:'start'}),/LIME 1/);
  client.dispose();
});
test('session negotiation may establish directly and authentication does not emit undefined instance', async () => {
  const t = new FakeTransport(); const c = new Lime.ClientChannel(t);
  t.respond = e => t.receive(e.state==='new' ? {id:'s',state:'negotiating',encryptionOptions:['none']} : {id:'s',state:'established'});
  await c.establishSession(); assert.equal(t.sent.length,2); assert.equal('compression' in t.sent[1],false); c.dispose();
  const t2 = new FakeTransport(); const c2 = new Lime.ClientChannel(t2);
  t2.respond = e => t2.receive(e.state==='new'?{id:'s',state:'authenticating'}:{id:'s',state:'established'});
  await c2.establishSession(undefined,undefined,'alice@example',new Lime.TransportAuthentication());
  assert.equal(t2.sent[1].from,'alice@example'); c2.dispose();
});
test('session failure rejects immediately, closes transport, and never silently downgrades', async () => {
  const t = new FakeTransport(); const c = new Lime.ClientChannel(t); let failure;
  c.onSessionFailed = value => failure = value;
  t.respond = () => t.receive({state:'failed',reason:{code:11,description:'unsupported version'}});
  await assert.rejects(c.establishSession(), value=>value.state==='failed');
  assert.equal(t.closed,1); assert.equal(failure.state,'failed'); assert.equal(t.sent.length,1);
  assert.throws(()=>c.sendSession({state:'new'}));
});
test('finishing rejects commands, abandons stream and aliases, and closes transport once', async () => {
  const { client:c,transport:t,errors,deliveries } = channel();
  c.contentTypes.register('card','application/vnd.example.card+json');
  const command = c.processCommand({id:'cmd',method:'get',uri:'/x'});
  const rejected = assert.rejects(command,/Session ended/);
  c.sendMessage(msg('pending'));
  t.receive({id:'partial',type:'text',stream:'start'});
  t.respond = e => { if (e.state==='finishing') t.receive({id:'s',state:'finished'}); };
  assert.equal((await c.sendFinishingSession()).state,'finished'); await rejected;
  assert.equal(c.pendingMessageCount,0); assert.equal(c.pendingCommandCount,0); assert.equal(deliveries.length,1);
  assert.throws(()=>c.contentTypes.resolve('card')); assert.equal(t.closed,1);
  t.receive({id:'partial',stream:'end'}); assert.equal(errors.length,1);
});
test('invalid state, overlapping exchanges, invalid server frames and missing authentication are explicit', async () => {
  const t = new FakeTransport(); const c = new Lime.ClientChannel(t); const errors=[]; c.onProtocolError=e=>errors.push(e);
  assert.throws(()=>c.negotiateSession('none','none')); assert.throws(()=>c.authenticateSession('a',new Lime.GuestAuthentication()));
  assert.throws(()=>c.sendFinishingSession());
  const first = c.startNewSession(); assert.throws(()=>c.startNewSession(),/pending/);
  t.receive({state:'unknown'}); t.receive({state:'established'}); assert.equal(errors.length,2);
  c.dispose(); await assert.rejects(first,/disposed/);
  const second = new Lime.ClientChannel(new FakeTransport());
  second.state='authenticating'; assert.throws(()=>second.authenticateSession('',new Lime.GuestAuthentication()));
  second.state='established'; assert.throws(()=>second.startNewSession()); second.dispose();
  const t3 = new FakeTransport(); const c3 = new Lime.ClientChannel(t3);
  t3.respond=()=>t3.receive({id:'s',state:'authenticating'});
  await assert.rejects(c3.establishSession(),/authentication/); c3.dispose();
});
test('transport send and close failures cannot strand session waiters', async () => {
  const t = new FakeTransport(); const c = new Lime.ClientChannel(t); t.failSend=true;
  await assert.rejects(c.startNewSession(),/send failed/); c.dispose();
  for (const close of [()=>{throw new Error('close failed')},()=>Promise.reject(new Error('close failed'))]) {
    const t2=new FakeTransport(); t2.close=close; const c2=new Lime.ClientChannel(t2); const errors=[]; c2.onProtocolError=e=>errors.push(e);
    const p=c2.startNewSession(); t2.receive({state:'failed'}); await assert.rejects(p, e=>e.state==='failed');
    await Promise.resolve(); assert.equal(errors.length,1);
  }
  const t3=new FakeTransport(); const c3=new Lime.ClientChannel(t3); const p=c3.startNewSession();
  t3.receive({state:'finished'}); await assert.rejects(p,/before establishment/);
});
test('message receipt clears only its exact revision; duplicates and delayed receipts are harmless', () => {
  const {client:c,transport:t,errors} = channel();
  c.sendMessage(msg('m')); c.sendMessage(msg('m',{rev:2}));
  t.receive(receipt('m')); assert.equal(c.pendingMessageCount,1);
  t.receive(receipt('m')); assert.equal(c.pendingMessageCount,1);
  assert.throws(()=>c.sendMessage(msg('m')),/acknowledged/);
  t.receive(receipt('m',{rev:2})); assert.equal(c.pendingMessageCount,0); assert.equal(errors.length,0); c.dispose();
});
test('cumulative receipt respects send order, direction, peer, revision, and earlier individually acknowledged marker', () => {
  const {client:c,transport:t,errors} = channel();
  c.sendMessage(msg('z',{thread:'t1'})); c.sendMessage(msg('a',{thread:'t2'})); c.sendMessage(msg('q',{to:'other@example'}));
  t.receive(receipt('a')); assert.equal(c.pendingMessageCount,2);
  t.receive(receipt('a',{scope:'session'})); assert.equal(c.pendingMessageCount,1);
  c.sendMessage(msg('later')); t.receive(receipt('z',{scope:'session'})); assert.equal(c.pendingMessageCount,2);
  t.receive(receipt('q',{from:'other@example',scope:'session'})); assert.equal(c.pendingMessageCount,1);
  assert.equal(errors.length,0); c.dispose();
});
test('cumulative receipt cannot cross an incomplete stream even across threads', () => {
  const {client:c,transport:t,errors} = channel();
  c.sendMessage({id:'a',type:'text',thread:'t1',stream:'start'});
  c.sendMessage(msg('b',{thread:'t2'}));
  t.receive(receipt('b',{scope:'session'})); assert.equal(c.pendingMessageCount,2); assert.match(errors[0].error.message,/incomplete/);
  t.receive(receipt('b')); assert.equal(c.pendingMessageCount,1);
  c.sendMessage({id:'a',stream:'data',content:'done'}); c.sendMessage({id:'a',stream:'end'});
  t.receive(receipt('b',{scope:'session'})); assert.equal(c.pendingMessageCount,0); c.dispose();
});
test('consumed and failed notifications never clear delivery buffer', () => {
  const {client:c,transport:t,notifications,errors} = channel();
  c.sendMessage(msg('m',{thread:'t'}));
  t.receive({id:'m',event:'consumed',scope:'thread',thread:'t'});
  t.receive({id:'m',event:'failed',reason:{code:21}});
  assert.equal(c.pendingMessageCount,1); assert.equal(notifications.length,2); assert.equal(errors.length,0);
  t.receive(receipt('m')); c.dispose();
});
test('rejects malformed, unresolved, cross-recipient, wrong revision, and mismatched thread notifications', () => {
  const {client:c,transport:t,errors} = channel(); c.sendMessage(msg('m',{thread:'t'}));
  const bad = [receipt('unknown'),receipt('m',{rev:2}),receipt('m',{from:'other'}),receipt('m',{to:'elsewhere'}),receipt('m',{thread:'wrong'}),
    receipt('m',{scope:'thread',thread:'t'}),receipt('m',{scope:'bad'}),{id:'m',event:'consumed',scope:'session'},
    {id:'m',event:'consumed',scope:'thread'},{id:'m',event:'failed'}, {id:'m',event:'failed',reason:{code:'1'}},
    {id:'m',event:'failed',reason:{code:1,description:1}},{id:'m',event:'failed',scope:'session',reason:{code:1}},
    {id:'m',event:'accepted'},receipt(''),receipt('m',{rev:0}), {id:'unknown',event:'consumed'}];
  for (const value of bad) t.receive(value);
  assert.equal(errors.length,bad.length); assert.equal(c.pendingMessageCount,1);
  assert.throws(()=>c.sendNotification({id:'m',event:'accepted'})); c.dispose();
});
test('an incomplete stream is not individually receiptable and an unknown destination cannot correlate by id', () => {
  const {client:c,transport:t,errors} = channel(); c.sendMessage({id:'a',type:'text',stream:'start'});
  t.receive(receipt('a')); assert.match(errors[0].error.message,/Incomplete/);
  t.receive({id:'a',event:'failed',reason:{code:21}}); assert.equal(c.pendingMessageCount,1); c.dispose();
});
test('retry buffers keep full content, preserve identity, and isolate caller mutations', () => {
  const {client:c,transport:t,deliveries} = channel({maxRetryAttempts:2});
  const original=msg('m',{type:'json',content:{a:1}}); c.sendMessage(original); original.content.a=99;
  c.sendMessage({id:'s',rev:2,type:'text',stream:'start'});
  c.sendMessage({id:'s',rev:2,stream:'data',content:'one'}); c.sendMessage({id:'s',rev:2,stream:'data',content:'two'});
  c.retryUnacknowledged(); assert.deepEqual(t.sent.at(-1).content,{a:1});
  c.sendMessage({id:'s',rev:2,stream:'end'}); c.retryUnacknowledged();
  assert.deepEqual(t.sent.at(-1),{id:'s',rev:2,type:'text/plain',content:'onetwo'});
  assert.equal(deliveries.length,1); assert.equal(c.pendingMessageCount,2);
  t.receive(receipt('m')); t.receive(receipt('s',{rev:2})); c.dispose();
});
test('automatic retries are bounded and are not postponed by later sends', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {client:c,transport:transport,deliveries} = channel({retryInterval:100,maxRetryAttempts:2});
  c.sendMessage(msg('a')); t.mock.timers.tick(50); c.sendMessage(msg('b')); t.mock.timers.tick(50);
  assert.equal(transport.sent.length,4); t.mock.timers.tick(100); assert.equal(transport.sent.length,6);
  assert.equal(deliveries.length,2); t.mock.timers.tick(1000); assert.equal(transport.sent.length,6);
  assert.equal(c.pendingMessageCount,2); c.dispose();
});
test('synchronous retry receipts cancel the timer without reporting exhausted delivery', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {client:c,transport:transport,deliveries} = channel({retryInterval:100,maxRetryAttempts:1});
  c.sendMessage(msg('m')); transport.respond=e=>transport.receive(receipt(e.id));
  t.mock.timers.tick(100); assert.equal(c.pendingMessageCount,0); assert.equal(deliveries.length,0); c.dispose();
});
test('send errors roll back stream state and capacity; retry errors retain unacknowledged delivery', () => {
  const {client:c,transport:t,deliveries} = channel({maxPendingMessages:1,maxRetryAttempts:1});
  t.failSend=true; assert.throws(()=>c.sendMessage(msg('a')),/send failed/); assert.equal(c.pendingMessageCount,0);
  t.failSend=false; c.sendMessage({id:'a',type:'text',stream:'start'});
  assert.throws(()=>c.sendMessage(msg('b')),/capacity/); assert.throws(()=>c.sendMessage({id:'a',type:'text',stream:'start'}),/already pending/);
  t.failSend=true; assert.throws(()=>c.sendMessage({id:'a',stream:'data',content:'bad'})); assert.equal(c.pendingMessageCount,0);
  t.failSend=false; c.sendMessage(msg('b')); t.failSend=true; c.retryUnacknowledged();
  assert.equal(c.pendingMessageCount,1); assert.equal(deliveries.length,2); c.dispose();
});
test('invalid client options and send messages fail before sending', () => {
  for (const options of [{version:3},{maxPendingMessages:0},{maxPendingCommands:-1},{retryInterval:NaN},{retryInterval:2147483648},{maxRetryAttempts:-1}]) assert.throws(()=>channel(options));
  const {client:c,transport:t}=channel();
  assert.throws(()=>c.sendMessage({id:'m',type:'invented',content:1})); assert.equal(c.pendingMessageCount,0);
  c.sendMessage({type:'text',content:'fire and forget'}); assert.equal(c.pendingMessageCount,0);
  c.dispose(); assert.throws(()=>c.sendMessage(msg('m'))); assert.throws(()=>c.sendCommand({method:'get'}));
  const before=t.sent.length; t.receive(msg('incoming')); assert.equal(t.sent.length,before);
});
test('command correlation is safe for prototype keys, reuses ids after response, and honors source/recipient', async () => {
  const {client:c,transport:t,commands}=channel();
  const p=c.processCommand({id:'__proto__',method:'get',uri:'/test',to:'other@example'});
  t.receive({id:'__proto__',method:'get',status:'success',from:'wrong'});
  t.receive({id:'__proto__',method:'get',status:'success',from:'other@example',to:'someone'});
  assert.equal(c.pendingCommandCount,1); assert.equal(commands.length,2);
  t.receive({id:'__proto__',method:'get',status:'success',from:'other@example',resource:42});
  assert.equal((await p).resource,42); assert.equal(c.pendingCommandCount,0);
  const p2=c.processCommand({id:'__proto__',method:'get',uri:'/test'});
  t.receive({id:'__proto__',method:'get',status:'failure',reason:{code:61}});
  assert.equal((await p2).status,'failure'); c.dispose();
});
test('command timeout uses controlled time, clears its entry, and does not leak command resource data', async t => {
  t.mock.timers.enable({apis:['setTimeout']}); const {client:c}=channel();
  const p=c.processCommand({id:'x',method:'set',uri:'/private',resource:{secret:'sensitive'}},25);
  const failure=assert.rejects(p,error=>/timed out/.test(error.message)&&!error.message.includes('sensitive'));
  t.mock.timers.tick(25); await failure; assert.equal(c.pendingCommandCount,0); c.dispose();
});
test('response cancels command timeout; synchronous send errors and dispose reject cleanly', async t => {
  t.mock.timers.enable({apis:['setTimeout']}); const {client:c,transport:transport}=channel();
  const p=c.processCommand({id:'m',method:'get'},10); transport.receive({id:'m',method:'get',status:'success'}); await p;
  t.mock.timers.tick(100); assert.equal(c.pendingCommandCount,0);
  transport.failSend=true; await assert.rejects(c.processCommand({id:'m',method:'get'}),/send failed/); assert.equal(c.pendingCommandCount,0);
  transport.failSend=false; const pending=c.processCommand({id:'m',method:'get'}); const rejected=assert.rejects(pending,/disposed/); c.dispose(); await rejected;
});
test('command validation bounds correlation and rejects duplicate in-flight identifiers', async () => {
  const {client:c}=channel({maxPendingCommands:1});
  for (const [cmd,timeout] of [[{id:1,method:'get'},1],[{method:'get'},1],[{id:'m',method:'get',status:'success'},1],[{id:'m',method:'get'},-1],[{id:'m',method:'get'},Infinity],[{id:'m',method:'get'},2147483648]]) assert.throws(()=>c.processCommand(cmd,timeout));
  const pending=c.processCommand({id:'m',method:'get'}); const rejected=assert.rejects(pending,/disposed/);
  assert.throws(()=>c.processCommand({id:'m',method:'get'}),/already/); assert.throws(()=>c.processCommand({id:'n',method:'get'}),/capacity/);
  c.dispose(); await rejected;
});
test('ping replies match exact identity or instance boundary and never use a prefix identity match', () => {
  const {client:c,transport:t,commands}=channel();
  const ping={id:'p',method:'get',uri:'/ping',from:'server@example'};
  t.receive({...ping,to:'client@example'}); assert.equal(t.sent.length,1); assert.equal(t.sent[0].status,'success');
  t.receive({...ping,to:'client@exam'}); assert.equal(t.sent.length,1);
  t.receive({...ping,status:'success'}); assert.equal(t.sent.length,1); assert.equal(commands.length,3); c.dispose();
});
test('session exchange timeout is deterministic, terminal, and closes transport', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const transport=new FakeTransport();const c=new Lime.ClientChannel(transport,true,undefined,{sessionTimeout:20});
  const pending=c.startNewSession();const failure=assert.rejects(pending,/timed out/);
  t.mock.timers.tick(20);await failure;assert.equal(c.state,'failed');assert.equal(transport.closed,1);
  for (const sessionTimeout of [0,-1,Infinity,2147483648]) assert.throws(()=>new Lime.ClientChannel(new FakeTransport(),true,undefined,{sessionTimeout}));
});
test('a new established session cannot inherit existing deliveries or ignore selected version', () => {
  const {client:c,transport:t,errors}=channel();
  c.sendMessage(msg('m'));t.receive({id:'other',state:'established'});t.receive({id:'s',state:'finishing',version:1});
  assert.equal(c.sessionId,'s');assert.equal(c.pendingMessageCount,1);assert.equal(errors.length,2);c.dispose();
});
test('terminal session state cannot be reopened by delayed establishment', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const transport=new FakeTransport();const c=new Lime.ClientChannel(transport,true,undefined,{sessionTimeout:20});const errors=[];c.onProtocolError=e=>errors.push(e);
  const p=c.startNewSession();const rejected=assert.rejects(p,/timed out/);t.mock.timers.tick(20);await rejected;
  transport.receive({id:'late',state:'established'});assert.equal(c.state,'failed');assert.equal(errors.length,1);
});
test('session ids stay bound and transport negotiation failures reject with their actual cause', async () => {
  const transport=new FakeTransport();const c=new Lime.ClientChannel(transport);const errors=[];c.onProtocolError=e=>errors.push(e);
  const pending=c.startNewSession();transport.receive({id:'s',state:'authenticating'});await pending;
  transport.receive({id:'different',state:'established'});assert.equal(c.state,'authenticating');assert.equal(errors.length,1);c.dispose();
  const badTransport=new FakeTransport();const badClient=new Lime.ClientChannel(badTransport);const failures=[];badClient.onProtocolError=e=>failures.push(e);
  badTransport.setEncryption=()=>{throw new Error('Unsupported encryption');};
  const session=badClient.startNewSession();badTransport.receive({id:'s',state:'negotiating',encryption:'tls'});
  await assert.rejects(session,/Unsupported encryption/);assert.equal(badClient.state,'failed');assert.equal(badTransport.closed,1);assert.equal(failures.length,1);
});
test('pending stream identity and thread metadata do not retain the caller envelope', () => {
  const {client:c,transport:t,errors}=channel();
  const start={id:'m',thread:'t',type:'text',stream:'start'};c.sendMessage(start);start.thread='mutated';start.id='mutated';
  t.receive({id:'m',thread:'t',event:'failed',reason:{code:21}});
  assert.equal(errors.length,0);assert.equal(c.pendingMessageCount,1);
  c.sendMessage({id:'m',stream:'end'});t.receive(receipt('m',{thread:'t'}));assert.equal(c.pendingMessageCount,0);c.dispose();
});
