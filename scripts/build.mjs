import { build, context } from 'esbuild';
import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
const options = { entryPoints: ['src/Lime/Lime.ts'], bundle: true, sourcemap: true, target: 'es2018' };
const umd = {
  banner: { js: `(function(root,factory){if(typeof module==='object'&&module.exports){module.exports=factory();}else if(typeof define==='function'&&define.amd){define([],factory);}else{root.Lime=factory();}})(typeof globalThis!=='undefined'?globalThis:this,function(){var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;});' }
};
const builds = [
  { ...options, outfile: 'dist/lime.mjs', format: 'esm' },
  { ...options, ...umd, outfile: 'dist/lime.js', format: 'cjs' },
  { ...options, ...umd, outfile: 'dist/lime.min.js', format: 'cjs', minify: true }
];
if (process.argv.includes('--watch')) {
  for (const config of builds) { const watcher = await context(config); await watcher.watch(); }
} else {
  for (const config of builds) await build(config);
}
