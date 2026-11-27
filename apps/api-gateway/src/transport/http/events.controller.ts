import { Controller, Get, Logger, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { ActorRequest } from '../../security/auth.guard';
import { AuthGuard } from '../../security/auth.guard';
import { EventHub } from '../events/event-hub.service';
import type { EventSink } from '../events/event-router';

const HEARTBEAT_MS = Number(process.env.EVENT_HEARTBEAT_MS ?? 25_000);

/** Server-sent events written to an Express response. */
export class SseSink implements EventSink {
  constructor(private readonly res: Response) {}
  send(event: string, data: unknown, id?: string): void {
    if (this.res.writableEnded) return;
    this.res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  comment(text: string): void { if (!this.res.writableEnded) this.res.write(`: ${text}\n\n`); }
  close(): void { if (!this.res.writableEnded) this.res.end(); }
}

/**
 * Live notifications for the signed-in user. Events identify new messages only;
 * the client fetches them with GET /conversations/:id/messages?after=<cursor>.
 * The stream ends when the access token expires; clients reconnect with a fresh token.
 */
@Controller('events')
@UseGuards(AuthGuard)
export class EventsController {
  private readonly logger = new Logger(EventsController.name);
  constructor(private readonly hub: EventHub) {}

  @Get()
  stream(@Req() req: ActorRequest, @Res() res: Response): void {
    const actor = req.actor;
    if (!actor) throw new Error('Authenticated actor missing');
    // Accepting a stream that can never receive events would leave clients waiting
    // on a 2-minute safety poll; a 503 makes them poll every 15 s and retry later.
    if (this.hub.status() !== 'connected') throw new ServiceUnavailableException('Live updates are temporarily unavailable');
    const sink = new SseSink(res);
    const unregister = this.hub.register(actor.id, sink); // throws 429/503 before any bytes are sent

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    sink.send('ready', { heartbeatSeconds: Math.round(HEARTBEAT_MS / 1000), expiresAt: actor.expiresAt ?? null });

    const heartbeat = setInterval(() => sink.comment('ping'), HEARTBEAT_MS);
    const expiresInMs = actor.expiresAt ? actor.expiresAt * 1000 - Date.now() : undefined;
    const expiry = expiresInMs !== undefined
      ? setTimeout(() => { sink.send('session-expired', {}); sink.close(); }, Math.min(Math.max(expiresInMs, 0), 2 ** 31 - 1))
      : undefined;
    this.logger.log(`service=api-gateway stage=events.open requestId=${actor.requestId ?? 'unknown'} connections=${this.hub.router.connections}`);

    res.on('close', () => {
      clearInterval(heartbeat);
      if (expiry) clearTimeout(expiry);
      unregister();
      this.logger.log(`service=api-gateway stage=events.close requestId=${actor.requestId ?? 'unknown'} connections=${this.hub.router.connections}`);
    });
  }
}
