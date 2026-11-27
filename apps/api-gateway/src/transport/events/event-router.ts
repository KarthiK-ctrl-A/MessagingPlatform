import { HttpException, HttpStatus } from '@nestjs/common';
import type { MessageCreatedEvent } from '@messaging/contracts';

/** One connected client stream. */
export interface EventSink {
  send(event: string, data: unknown, id?: string): void;
  close(): void;
}

export interface RouterLimits { perUser: number; total: number; dedupeWindow: number }

/**
 * Routes verified events to the streams of their participants. Pure logic
 * (no I/O) so delivery, de-duplication and connection limits are unit-testable.
 */
export class EventRouter {
  private readonly streams = new Map<string, Set<EventSink>>();
  private readonly seen = new Set<string>();
  private count = 0;

  constructor(private readonly limits: RouterLimits) {}

  get connections(): number { return this.count; }

  /** Registers a stream; returns the function that unregisters it. */
  register(userId: string, sink: EventSink): () => void {
    const existing = this.streams.get(userId) ?? new Set<EventSink>();
    if (existing.size >= this.limits.perUser) {
      throw new HttpException('Too many open event streams for this user', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (this.count >= this.limits.total) {
      throw new HttpException('Event streams are at capacity', HttpStatus.SERVICE_UNAVAILABLE);
    }
    existing.add(sink);
    this.streams.set(userId, existing);
    this.count++;
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      existing.delete(sink);
      this.count--;
      if (existing.size === 0) this.streams.delete(userId);
    };
  }

  /** Delivers an event to every stream of its participants; returns streams notified (0 for duplicates). */
  deliver(event: MessageCreatedEvent): number {
    // The relay may republish after a crash; never notify twice for one event.
    if (this.seen.has(event.eventId)) return 0;
    this.seen.add(event.eventId);
    if (this.seen.size > this.limits.dedupeWindow) this.seen.delete(this.seen.values().next().value as string);
    const payload = {
      eventId: event.eventId, conversationId: event.conversationId,
      messageId: event.messageId, occurredAt: event.occurredAt,
    };
    let delivered = 0;
    for (const userId of new Set(event.participants)) {
      for (const sink of this.streams.get(userId) ?? []) {
        sink.send('message-created', payload, event.eventId);
        delivered++;
      }
    }
    return delivered;
  }

  /** Closes every stream, e.g. on shutdown; clients reconnect with backoff. */
  closeAll(): void {
    for (const sinks of this.streams.values()) for (const sink of sinks) sink.close();
  }
}
