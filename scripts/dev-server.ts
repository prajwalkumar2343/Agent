import { createServer, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Local dev server — mounts api/**\/*.ts handlers on plain Node HTTP so the
 * Slack app can be pointed at a tunnel without a Vercel deploy. Handlers are
 * Vercel-shaped: (req: IncomingMessage-ish, res) — res gets status/send/json
 * adapters here. Loads .env (same KEY=value format; ` #` trailing comments
 * are stripped, keep secrets free of that sequence).
 *
 *   node --experimental-strip-types scripts/dev-server.ts [port]
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(): void {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1);
    if (!/^['"]/.test(val.trim())) val = val.replace(/\s+#.*$/, '');
    val = val.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

function adaptRes(res: ServerResponse): void {
  const r = res as ServerResponse & {
    status(code: number): typeof r;
    send(b: unknown): typeof r;
    json(b: unknown): typeof r;
  };
  r.status = (code) => {
    res.statusCode = code;
    return r;
  };
  r.send = (b) => {
    res.end(typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b));
    return r;
  };
  r.json = (b) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(b));
    return r;
  };
}

async function main(): Promise<void> {
  loadEnv();
  const port = Number(process.argv[2] ?? 3000);

  const server = createServer(async (req, res) => {
    adaptRes(res);
    const route = path
      .normalize(decodeURIComponent((req.url ?? '').split('?')[0] ?? ''))
      .replace(/^\/+|\/+$/g, '');
    const file = path.join(root, `${route}.ts`);
    if (!route.startsWith('api/') || !existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    try {
      const mod = (await import(pathToFileURL(file).href)) as {
        default: (q: unknown, s: unknown) => unknown;
      };
      await mod.default(req, res);
    } catch (err) {
      console.error(`${route} threw:`, err);
      if (!res.headersSent) res.statusCode = 500;
      res.end('internal error');
    }
  });

  server.listen(port, () => {
    console.log(`dev server → http://localhost:${port} (routes: api/**/*.ts)`);
  });
}

await main();
