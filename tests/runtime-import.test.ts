import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'node:test';
import ts from 'typescript';

it('emitted Vercel API handlers load with the native Node ESM loader', async () => {
  const root = resolve(process.cwd());
  const work = join(root, 'work', 'runtime-imports');
  await mkdir(work, { recursive: true });
  const output = await mkdtemp(join(work, 'run-'));
  const sources = ['api/mobile.ts', 'api/[...path].ts', 'server/database.ts', 'server/mobile.ts', 'server/presence.ts',
    'server/bluepal.ts', 'server/serviceControl.ts', 'server/proxyImport.ts', 'shared/proxyImport.ts',
    'server/proxyBulk.ts', 'api/proxies/import.ts', 'api/proxies/bulk.ts',
    'server/subscriptionUsage.ts', 'api/user-subscriptions/reset-usage.ts'];
  for (const source of sources) {
    const code = await readFile(join(root, source), 'utf8');
    const compiled = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true },
      fileName: source,
    });
    const target = join(output, source.replace(/\.ts$/, '.js'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, compiled.outputText);
  }
  await writeFile(join(output, 'package.json'), '{"type":"module"}');
  const urls = ['api/mobile.js', 'api/[...path].js', 'api/proxies/import.js', 'api/proxies/bulk.js', 'api/user-subscriptions/reset-usage.js'].map(path => pathToFileURL(join(output, path)).href);
  const code = `for (const url of ${JSON.stringify(urls)}) {
    const module = await import(url);
    if (typeof module.default !== 'function') throw new Error('Missing API handler');
  }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: output, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Node API import failed');
});
