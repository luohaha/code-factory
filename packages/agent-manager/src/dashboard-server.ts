import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type WorkerModule = {
  default: {
    fetch: (
      request: Request,
      environment: { ASSETS: { fetch: (request: Request) => Promise<Response> } },
      context: { waitUntil: (promise: Promise<unknown>) => void; passThroughOnException: () => void },
    ) => Promise<Response>;
  };
};

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function requestUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? '127.0.0.1';
  return `http://${host}${request.url ?? '/'}`;
}

async function requestBody(request: IncomingMessage): Promise<ArrayBuffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  const combined = Buffer.concat(chunks);
  const body = new ArrayBuffer(combined.byteLength);
  new Uint8Array(body).set(combined);
  return body;
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

async function writeResponse(response: ServerResponse, webResponse: Response, headOnly: boolean): Promise<void> {
  response.statusCode = webResponse.status;
  response.statusMessage = webResponse.statusText;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  if (headOnly || !webResponse.body) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!response.write(Buffer.from(chunk.value))) {
        await new Promise<void>((resolveDrain) => response.once('drain', resolveDrain));
      }
    }
    response.end();
  } catch (error) {
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

export class DashboardServer {
  readonly #dashboardRoot = resolve(fileURLToPath(new URL('../dashboard/', import.meta.url)));
  readonly #clientRoot = resolve(fileURLToPath(new URL('../dashboard/client/', import.meta.url)));
  #worker: Promise<WorkerModule> | null = null;

  get available(): boolean {
    return existsSync(resolve(this.#dashboardRoot, 'server', 'index.js'));
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!this.available) return false;
    if (request.method === 'GET' || request.method === 'HEAD') {
      const assetResponse = await this.serveAsset(new Request(requestUrl(request), { method: request.method }));
      if (assetResponse.status !== 404) {
        await writeResponse(response, assetResponse, request.method === 'HEAD');
        return true;
      }
    }
    const worker = await this.loadWorker();
    const body = await requestBody(request);
    const webRequest = new Request(requestUrl(request), {
      method: request.method ?? 'GET',
      headers: requestHeaders(request),
      ...(body ? { body } : {}),
    });
    const context = {
      waitUntil: (promise: Promise<unknown>) => { void promise.catch(() => undefined); },
      passThroughOnException: () => undefined,
    };
    const webResponse = await worker.default.fetch(
      webRequest,
      { ASSETS: { fetch: (assetRequest) => this.serveAsset(assetRequest) } },
      context,
    );
    await writeResponse(response, webResponse, request.method === 'HEAD');
    return true;
  }

  private loadWorker(): Promise<WorkerModule> {
    this.#worker ??= import(pathToFileURL(resolve(this.#dashboardRoot, 'server', 'index.js')).href) as Promise<WorkerModule>;
    return this.#worker;
  }

  private async serveAsset(request: Request): Promise<Response> {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    const relativePath = pathname.replace(/^\/+/, '');
    const filePath = resolve(this.#clientRoot, relativePath);
    if (filePath !== this.#clientRoot && !filePath.startsWith(`${this.#clientRoot}${sep}`)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return new Response('Not Found', { status: 404 });
    const contents = await readFile(filePath);
    const headers = new Headers({
      'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': relativePath.startsWith('_next/static/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=300',
    });
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(contents), { status: 200, headers });
  }
}
