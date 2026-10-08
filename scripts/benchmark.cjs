const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { readFileSync } = require('node:fs');
const { gzipSync } = require('node:zlib');
const { resolve, dirname, join } = require('node:path');
const current = resolve('dist/lime.js');
const baseline = process.env.LIME_BASELINE_BUNDLE && resolve(process.env.LIME_BASELINE_BUNDLE);
const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
const originalWindow = Object.getOwnPropertyDescriptor(global, "window");
const timers = new Set();
global.setTimeout = (callback, delay, ...args) => {
  const timer = realSetTimeout((...values) => { timers.delete(timer); callback(...values); }, delay, ...args);
  timers.add(timer); return timer;
};
global.clearTimeout = timer => { timers.delete(timer); realClearTimeout(timer); };
const median = values => values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)];
function makeClient(Lime,version) {
  const transport = { send(e) { if (e.method) this.onEnvelope({id:e.id,method:e.method,status:'success'}); }, close() {}, setCompression() {}, setEncryption() {} };
  const client = new Lime.ClientChannel(transport,true,false,{version,retryInterval:0,maxPendingCommands:10000});
  client.onSession({id:'s',state:'established',from:'peer@example',to:'client@example/browser'});
  return { client,transport };
}
async function commands(Lime) {
  const {client} = makeClient(Lime,2); const results=[]; const retained=[];
  for (let round=0;round<8;round++) {
    const start=performance.now(); const requests=[];
    for (let i=0;i<5000;i++) requests.push(client.processCommand({id:`${round}:${i}`,method:'get',uri:'/benchmark'},60000));
    const responses=await Promise.all(requests); assert.equal(responses.length,5000); assert.equal(responses[0].status,'success');
    if (round) {results.push(performance.now()-start);retained.push(timers.size);}
    for (const timer of Array.from(timers)) global.clearTimeout(timer);
  }
  client.dispose?.();return {commands:5000,medianMs:median(results),timersAfterResponses:median(retained)};
}
function receive(Lime, version) {
  const {client,transport}=makeClient(Lime,version);let count=0; client.onMessage=()=>count++;
  const envelope={type:'text/plain',content:'hello'};const samples=[];
  for(let round=0;round<8;round++) {
    const start=performance.now();for(let i=0;i<100000;i++)transport.onEnvelope(envelope);
    if(round)samples.push(performance.now()-start);
  }
  assert.equal(count,800000);client.dispose?.();return {messages:100000,medianMs:median(samples)};
}
function stream(Lime) {
  const {client,transport}=makeClient(Lime,2);const samples=[];let completed;
  client.onMessage=message=>completed=message;
  for(let round=0;round<8;round++) {
    const start=performance.now();transport.onEnvelope({id:'m',type:'text',stream:'start'});
    for(let i=0;i<10000;i++)transport.onEnvelope({id:'m',stream:'data',content:'abcdefghijklmnopqrstuvwxyz012345'});
    transport.onEnvelope({id:'m',stream:'end'});assert.equal(completed.content.length,320000);
    if(round)samples.push(performance.now()-start);
  }
  client.dispose();return {contributions:10000,characters:320000,medianMs:median(samples)};
}
(async()=>{
  const result={node:process.version,platform:process.platform,arch:process.arch,samples:7,warmups:1};
  for(const [name,path] of [['current',current],...(baseline?[['baseline',baseline]]:[])]) {
    // Original webpack UMD references window even when loaded through CommonJS.
    if(name === "baseline") global.window = global;
    const Lime=require(path);const min=readFileSync(join(dirname(path),'lime.min.js'));
    result[name]={minifiedBytes:min.length,gzipBytes:gzipSync(min,{level:9}).length,commandRoundTrips:await commands(Lime),completeMessageReceive:receive(Lime,2)};
    if(name==='current') {result[name].legacyMessageReceive=receive(Lime,1);result[name].textStream=stream(Lime);}
  }
  console.log(JSON.stringify(result,null,2));
})().finally(()=>{for(const timer of Array.from(timers))global.clearTimeout(timer);global.setTimeout=realSetTimeout;global.clearTimeout=realClearTimeout;if(originalWindow)Object.defineProperty(global,"window",originalWindow);else delete global.window;});
