import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export interface LoggedRequest extends Request { requestId?: string }

const logger = new Logger('GatewayHttp');
const messageRoute = /^\/v1\/conversations\/[0-9a-f-]{36}\/messages$/i;

function safeRoute(path: string): string {
  if (path === '/') return '/';
  if (path === '/v1/public-config' || path === '/v1/health' || path === '/v1/events' || path === '/v1/conversations' ||
      path === '/v1/conversations/care-contacts' || path === '/v1/conversations/current-doctor') return path;
  if (messageRoute.test(path)) return '/v1/conversations/:id/messages';
  return '/v1/unmatched';
}

export function requestLogging(req: LoggedRequest, res: Response, next: NextFunction): void {
  if (req.path !== '/' && !req.path.startsWith('/v1/')) return next();
  const requestId = randomUUID();
  const started = performance.now();
  const route = safeRoute(req.path);
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  logger.log(`service=api-gateway stage=http.start requestId=${requestId} method=${req.method} route=${route}`);
  res.once('finish', () => {
    logger.log(`service=api-gateway stage=http.done requestId=${requestId} method=${req.method} route=${route} status=${res.statusCode} durationMs=${Math.round(performance.now() - started)}`);
  });
  res.once('close', () => {
    if (!res.writableEnded) {
      logger.warn(`service=api-gateway stage=http.closed requestId=${requestId} method=${req.method} route=${route} durationMs=${Math.round(performance.now() - started)}`);
    }
  });
  next();
}
