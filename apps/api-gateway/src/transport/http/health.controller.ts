import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { NatsGatewayService } from '../nats/nats-gateway.service';
import { EventHub } from '../events/event-hub.service';

@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(private readonly messaging: NatsGatewayService, private readonly events: EventHub) {}

  /** Liveness and broker connectivity for orchestrator health checks. */
  @Get()
  @Header('Cache-Control', 'no-store')
  check() {
    const nats = this.messaging.connectionStatus();
    if (nats === 'disconnected' || nats === 'reconnecting') throw new ServiceUnavailableException('Messaging broker disconnected');
    return { status: 'ok', nats, events: this.events.status(), eventStreams: this.events.router.connections };
  }
}
