const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Lime,FakeTransport } = require('./helpers.cjs');
function pair() {
  const leftTransport=new FakeTransport(),rightTransport=new FakeTransport();
  const left=new Lime.ClientChannel(leftTransport,true,undefined,{retryInterval:0});
  const right=new Lime.ClientChannel(rightTransport,true,undefined,{retryInterval:0});
  left.onSession({id:'session',state:'established',from:'right@example',to:'left@example'});
  right.onSession({id:'session',state:'established',from:'left@example',to:'right@example'});
  leftTransport.respond=e=>rightTransport.receive(JSON.parse(JSON.stringify(e)));
  rightTransport.respond=e=>leftTransport.receive(JSON.parse(JSON.stringify(e)));
  return {left,right,leftTransport,rightTransport};
}
test('serialized transport contract completes text/JSON streams, routes receipts, and preserves revisions', () => {
  const {left,right,leftTransport,rightTransport}=pair();const messages=[];right.onMessage=m=>messages.push(m);
  left.sendMessage({id:'text',rev:2,type:'text',thread:'t',stream:'start'});
  left.sendMessage({id:'text',rev:2,stream:'data',content:'hello'});
  assert.equal(messages.length,0);assert.equal(left.pendingMessageCount,1);assert.equal(rightTransport.sent.length,0);
  left.sendMessage({id:'text',rev:2,stream:'end'});
  assert.equal(messages[0].content,'hello');assert.equal(left.pendingMessageCount,0);
  assert.equal(rightTransport.sent[0].rev,2);
  left.sendMessage({id:'json',type:'select',stream:'start'});
  left.sendMessage({id:'json',stream:'data',content:{options:[1,2],title:'old'}});
  left.sendMessage({id:'json',stream:'data',content:{options:[3],title:null}});
  left.sendMessage({id:'json',stream:'end'});
  assert.deepEqual(messages[1].content,{options:[3]});assert.equal(left.pendingMessageCount,0);
  left.dispose();right.dispose();
});
test('lost terminal frame retries as a full revision without duplicating partial text', () => {
  const {left,right,leftTransport,rightTransport}=pair();const messages=[];right.onMessage=m=>messages.push(m);
  const forward=leftTransport.respond;leftTransport.respond=e=>{if(e.stream!=='end')forward(e);};
  left.sendMessage({id:'m',type:'text',stream:'start'});left.sendMessage({id:'m',stream:'data',content:'once'});
  left.sendMessage({id:'m',stream:'end'});assert.equal(messages.length,0);assert.equal(left.pendingMessageCount,1);
  left.retryUnacknowledged();assert.equal(messages[0].content,'once');assert.equal(left.pendingMessageCount,0);
  assert.equal(leftTransport.sent.at(-1).stream,undefined);assert.equal(rightTransport.sent.length,1);
  left.dispose();right.dispose();
});
test('lost receipt causes at-least-once delivery with the same message revision', () => {
  const {left,right,rightTransport}=pair();const messages=[];right.onMessage=m=>messages.push(m);
  const forward=rightTransport.respond;rightTransport.respond=()=>{};
  left.sendMessage({id:'m',rev:3,type:'text',content:'once'});assert.equal(left.pendingMessageCount,1);
  rightTransport.respond=forward;left.retryUnacknowledged();assert.equal(left.pendingMessageCount,0);
  assert.deepEqual(messages.map(m=>[m.id,m.rev,m.content]),[['m',3,'once'],['m',3,'once']]);
  left.dispose();right.dispose();
});
