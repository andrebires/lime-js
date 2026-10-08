const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Lime } = require('./helpers.cjs');
test('CommonJS, ESM, browser and AMD builds expose the same API', async () => {
  const esm = await import('../dist/lime.mjs');
  assert.deepEqual(Object.keys(esm).sort(),Object.keys(Lime).sort());
  for (const file of ['lime.js','lime.min.js']) {
    const source = fs.readFileSync(`dist/${file}`,'utf8');
    const browser={}; vm.runInNewContext(source,browser);
    assert.equal(browser.Lime.NotificationEvent.FAILED,'failed');
    let amd; const define=(_,factory)=>{amd=factory();}; define.amd=true;
    vm.runInNewContext(source,{define}); assert.equal(amd.ContentTypes.TEXT,'text/plain');
  }
});
test('UUID uses native crypto, secure fallback and explicit missing-crypto failure', () => {
  assert.match(Lime.Guid(),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const source=fs.readFileSync('dist/lime.js','utf8'); const browser={crypto:{getRandomValues: value=>value.fill(0)}};
  vm.runInNewContext(source,browser); assert.equal(browser.Lime.Guid(),'00000000-0000-4000-8000-000000000000');
  const none={};vm.runInNewContext(source,none);assert.throws(()=>none.Lime.Guid(),/Web Crypto/);
});
test('identity/node round trip and authentication exports remain usable in legacy mode', () => {
  const identity=new Lime.Identity('a','example');const node=identity.toNode();
  assert.equal(identity.toString(),'a@example'); assert.equal(node.toIdentity(),identity); assert.equal(node.toString(),'a@example');
  const instance=Lime.Node.parse('a@example/mobile');assert.equal(instance.toString(),'a@example/mobile');
  assert.equal(Lime.Node.parse(instance),instance); assert.equal(Lime.Identity.parse(instance).name,'a');
  assert.equal(Lime.Identity.parse(identity),identity);assert.equal(Lime.Node.parse(identity).toIdentity(),identity);
  assert.equal(Lime.Identity.parse('invalid'),undefined);assert.equal(Lime.Node.parse('invalid'),undefined);
  assert.equal(new Lime.KeyAuthentication('key').key,'key');
  assert.equal(new Lime.ExternalAuthentication('token','issuer').issuer,'issuer');
  assert.equal(new Lime.GuestAuthentication().scheme,'guest');
  const reason=new Lime.Reason(21);assert.equal(reason.toString(),' (Code 21)');
});
