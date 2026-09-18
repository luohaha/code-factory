import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';

import { AgentManager, MAX_MESSAGE_ATTACHMENT_BYTES } from './agent-manager.js';
import { validateAgentManagerConfigurationPatch } from './configuration.js';
import { DashboardServer } from './dashboard-server.js';
import type { Logger } from './logger.js';
import { StoreConflictError, StoreNotFoundError } from './store.js';
import type { AgentProvider, AgentReasoningEffort, ManagerEvent, PullRequestStatus } from './types.js';
import { CODE_FACTORY_VERSION } from './version.js';

export interface AgentManagerServerOptions {
  host?: string;
  port?: number;
  allowedOrigin?: string;
  logger?: Logger;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 1_000_000) throw new RangeError('Request body exceeds 1 MB');
  }
  if (!body) return {};
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a JSON object');
  return value as Record<string, unknown>;
}

async function readBinary(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteSize += value.length;
    if (byteSize > limit) throw new RangeError(`Request body exceeds ${limit / 1024 / 1024} MB`);
    chunks.push(value);
  }
  return Buffer.concat(chunks, byteSize);
}

function stringField(body: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = body[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value.trim())) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function providerField(value: unknown): AgentProvider {
  if (value !== 'codex' && value !== 'claude-code') throw new TypeError('provider must be codex or claude-code');
  return value;
}

function reasoningEffortField(value: unknown): AgentReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (value !== 'low' && value !== 'medium' && value !== 'high' && value !== 'xhigh' && value !== 'max') {
    throw new TypeError('reasoningEffort must be low, medium, high, xhigh, or max');
  }
  return value;
}

function pullRequestStatusField(value: unknown): PullRequestStatus {
  if (value !== 'draft' && value !== 'open' && value !== 'closed' && value !== 'merged') {
    throw new TypeError('status must be draft, open, closed, or merged');
  }
  return value;
}

function agentTimerScheduleField(value: unknown): 'once' | 'recurring' {
  if (value !== 'once' && value !== 'recurring') throw new TypeError('schedule must be once or recurring');
  return value;
}

function positiveIntegerField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (!Number.isInteger(value) || Number(value) <= 0) throw new TypeError(`${name} must be a positive integer`);
  return Number(value);
}

function stringArrayField(body: Record<string, unknown>, name: string): string[] {
  const value = body[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
  return value as string[];
}

function fileNameHeader(request: IncomingMessage): string {
  const header = request.headers['x-file-name'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return 'attachment';
  try {
    return decodeURIComponent(value);
  } catch {
    throw new TypeError('x-file-name must be URI encoded');
  }
}

export function createAgentManagerServer(manager: AgentManager, options: AgentManagerServerOptions = {}): Server {
  const allowedOrigin = options.allowedOrigin;
  const logger = (options.logger ?? manager.logger).child({ component: 'http' });
  const dashboard = new DashboardServer();
  const server = createServer(async (request, response) => {
    const startedAt = performance.now();
    response.once('finish', () => {
      const context = {
        method: request.method ?? 'UNKNOWN',
        path: request.url?.split('?', 1)[0] ?? '/',
        statusCode: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
      if (response.statusCode >= 500) logger.error('HTTP request completed', context);
      else if (response.statusCode >= 400) logger.warn('HTTP request completed', context);
      else logger.info('HTTP request completed', context);
    });
    if (allowedOrigin) {
      response.setHeader('access-control-allow-origin', allowedOrigin);
      response.setHeader('access-control-allow-headers', 'content-type, x-file-name');
      response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }

    const url = new URL(request.url ?? '/', 'http://agent-manager.local');
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, {
          ok: true,
          version: CODE_FACTORY_VERSION,
          workspaceRoot: manager.workspaceRoot,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/workspace') {
        sendJson(response, 200, {
          root: manager.workspaceRoot,
          databasePath: manager.databasePath,
          logFilePath: manager.logFilePath,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/configuration') {
        sendJson(response, 200, manager.getConfiguration());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/agent-models') {
        sendJson(response, 200, await manager.listAgentModels());
        return;
      }
      if (request.method === 'PATCH' && url.pathname === '/api/configuration') {
        const patch = validateAgentManagerConfigurationPatch(await readJson(request));
        sendJson(response, 200, manager.updateConfiguration(patch));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/search') {
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        sendJson(response, 200, { items: manager.search(url.searchParams.get('q') ?? '', limit) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/requirements') {
        sendJson(response, 200, { items: manager.listRequirements() });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        sendJson(response, 200, { items: manager.listSessions() });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/runs') {
        sendJson(response, 200, { items: manager.listRuns(url.searchParams.get('requirementId') ?? undefined) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/pull-requests') {
        sendJson(response, 200, { items: manager.listPullRequests(url.searchParams.get('requirementId') ?? undefined) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/review-requests') {
        sendJson(response, 200, { items: manager.listReviewRequests(url.searchParams.get('pullRequestId') ?? undefined) });
        return;
      }
      const attachment = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (request.method === 'GET' && attachment) {
        const attachmentId = decodeURIComponent(attachment[1]!);
        const item = manager.getMessageAttachment(attachmentId);
        if (!item) throw new StoreNotFoundError(`Attachment ${attachmentId} not found`);
        const data = await readFile(item.localPath);
        response.writeHead(200, {
          'content-type': item.mediaType,
          'content-length': data.length,
          'content-disposition': `${item.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.fileName)}`,
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        });
        response.end(data);
        return;
      }
      const messages = url.pathname.match(/^\/api\/requirements\/([^/]+)\/messages$/);
      if (request.method === 'GET' && messages) {
        const requirementId = decodeURIComponent(messages[1]!);
        sendJson(response, 200, { items: manager.listMessages(requirementId) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/timers') {
        sendJson(response, 200, { items: manager.listAgentTimers() });
        return;
      }
      const agentTimers = url.pathname.match(/^\/api\/requirements\/([^/]+)\/timers$/);
      if (request.method === 'GET' && agentTimers) {
        const requirementId = decodeURIComponent(agentTimers[1]!);
        sendJson(response, 200, { items: manager.listAgentTimers(requirementId) });
        return;
      }
      if (request.method === 'POST' && agentTimers) {
        const requirementId = decodeURIComponent(agentTimers[1]!);
        const body = await readJson(request);
        const item = manager.createAgentTimer(requirementId, {
          description: stringField(body, 'description', true)!,
          schedule: agentTimerScheduleField(body.schedule),
          intervalSeconds: positiveIntegerField(body, 'intervalSeconds'),
        });
        sendJson(response, 201, item);
        return;
      }
      const agentTimer = url.pathname.match(
        /^\/api\/requirements\/([^/]+)\/timers\/([^/]+)$/,
      );
      if (request.method === 'DELETE' && agentTimer) {
        const requirementId = decodeURIComponent(agentTimer[1]!);
        const timerId = decodeURIComponent(agentTimer[2]!);
        sendJson(response, 200, manager.cancelAgentTimer(timerId, requirementId));
        return;
      }
      const attachmentUpload = url.pathname.match(/^\/api\/requirements\/([^/]+)\/attachments$/);
      if (request.method === 'POST' && attachmentUpload) {
        const requirementId = decodeURIComponent(attachmentUpload[1]!);
        const item = manager.uploadMessageAttachment(requirementId, {
          fileName: fileNameHeader(request),
          mediaType: Array.isArray(request.headers['content-type']) ? request.headers['content-type'][0] : request.headers['content-type'],
          data: await readBinary(request, MAX_MESSAGE_ATTACHMENT_BYTES),
        });
        sendJson(response, 201, item);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const afterId = Number(url.searchParams.get('after') ?? 0);
        for (const event of manager.listEvents(Number.isFinite(afterId) ? afterId : 0)) {
          response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        const listener = (event: ManagerEvent) => {
          response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        manager.on('event', listener);
        request.once('close', () => manager.off('event', listener));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/requirements') {
        const body = await readJson(request);
        const model = stringField(body, 'model')?.trim();
        const reasoningEffort = reasoningEffortField(body.reasoningEffort);
        const item = manager.createRequirement({
          title: stringField(body, 'title', true)!,
          description: stringField(body, 'description', true)!,
          provider: providerField(body.provider),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        });
        sendJson(response, 201, item);
        return;
      }

      const requirement = url.pathname.match(/^\/api\/requirements\/([^/]+)$/);
      if (request.method === 'GET' && requirement) {
        const requirementId = decodeURIComponent(requirement[1]!);
        const item = manager.getRequirement(requirementId);
        if (!item) throw new StoreNotFoundError(`Requirement ${requirementId} not found`);
        sendJson(response, 200, item);
        return;
      }
      if (request.method === 'DELETE' && requirement) {
        manager.deleteRequirement(decodeURIComponent(requirement[1]!));
        response.writeHead(204).end();
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/requirements') {
        const body = await readJson(request);
        const sourceSessionId = stringField(body, 'sourceSessionId', true)!;
        const source = manager.listSessions().find((session) => session.id === sourceSessionId);
        if (!source) throw new StoreNotFoundError(`Session ${sourceSessionId} not found`);
        const model = stringField(body, 'model')?.trim();
        const reasoningEffort = reasoningEffortField(body.reasoningEffort);
        const item = manager.createRequirement({
          title: stringField(body, 'title', true)!,
          description: stringField(body, 'description', true)!,
          provider: body.provider === undefined ? source.provider : providerField(body.provider),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          createdBy: 'rd_agent',
          sourceSessionId,
          parentRequirementId: stringField(body, 'parentRequirementId') ?? source.requirementId,
        });
        sendJson(response, 201, item);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/pull-requests') {
        const body = await readJson(request);
        const item = manager.registerAgentPullRequest({
          requirementId: stringField(body, 'requirementId', true)!,
          repository: stringField(body, 'repository', true)!,
          number: positiveIntegerField(body, 'number'),
          url: stringField(body, 'url', true)!,
          title: stringField(body, 'title', true)!,
          baseBranch: stringField(body, 'baseBranch', true)!,
          headBranch: stringField(body, 'headBranch', true)!,
          headSha: stringField(body, 'headSha', true)!,
          status: pullRequestStatusField(body.status),
        });
        sendJson(response, 200, item);
        return;
      }

      const reviewRequest = url.pathname.match(/^\/api\/pull-requests\/([^/]+)\/review-requests$/);
      if (request.method === 'POST' && reviewRequest) {
        const pullRequestId = decodeURIComponent(reviewRequest[1]!);
        const body = await readJson(request);
        const provider = providerField(body.provider);
        const model = stringField(body, 'model')?.trim();
        const reasoningEffort = reasoningEffortField(body.reasoningEffort);
        const prompt = stringField(body, 'prompt');
        void manager.requestReview(pullRequestId, {
          provider,
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(prompt ? { prompt } : {}),
        })
          .catch((error: unknown) => logger.error('Reviewer run failed unexpectedly', { pullRequestId, error }));
        sendJson(response, 202, {
          accepted: true,
          pullRequestId,
          provider,
          model: model ?? null,
          reasoningEffort: reasoningEffort ?? null,
        });
        return;
      }

      const action = url.pathname.match(/^\/api\/requirements\/([^/]+)\/(start|reply|interrupt|confirm)$/);
      if (request.method === 'POST' && action) {
        const requirementId = decodeURIComponent(action[1]!);
        const name = action[2]!;
        const body = await readJson(request);
        if (name === 'confirm') {
          sendJson(response, 200, manager.confirmRequirement(requirementId));
          return;
        }
        if (name === 'interrupt') {
          const result = manager.interruptRdRun(requirementId);
          sendJson(response, 202, { accepted: true, requirementId, action: name, runId: result.runId });
          return;
        }
        if (name === 'reply') {
          const result = manager.postHumanMessage(
            requirementId,
            stringField(body, 'message') ?? '',
            stringArrayField(body, 'attachmentIds'),
          );
          sendJson(response, 202, {
            accepted: true,
            requirementId,
            action: name,
            queued: result.queued,
            message: result.message,
            requirement: result.requirement,
          });
          return;
        }
        const message = stringField(body, 'message');
        const attachmentIds = stringArrayField(body, 'attachmentIds');
        void manager.runRequirement(requirementId, message, attachmentIds)
          .catch((error: unknown) => logger.error('RD run failed unexpectedly', { requirementId, error }));
        sendJson(response, 202, { accepted: true, requirementId, action: name });
        return;
      }

      if (await dashboard.handle(request, response)) return;
      sendJson(response, 404, {
        error: 'Dashboard bundle not found. Run npm run build before starting Agent Manager.',
      });
    } catch (error) {
      if (error instanceof StoreNotFoundError || (error instanceof Error && error.message.endsWith('not found'))) {
        sendJson(response, 404, { error: error.message });
      } else if (error instanceof StoreConflictError) {
        sendJson(response, 409, { error: error.message });
      } else if (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError) {
        sendJson(response, 400, { error: error.message });
      } else {
        logger.error('HTTP request failed unexpectedly', {
          method: request.method ?? 'UNKNOWN',
          path: url.pathname,
          error,
        });
        sendJson(response, 500, { error: 'Internal server error' });
      }
    }
  });
  server.on('listening', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return;
    const host = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
    manager.setApiBaseUrl(`http://${host}:${address.port}/api`);
    logger.info('HTTP server listening', { host, port: address.port });
  });
  return server;
}

export async function listen(
  server: Server,
  options: AgentManagerServerOptions = {},
): Promise<{ host: string; port: number }> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4310;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { host, port };
}
