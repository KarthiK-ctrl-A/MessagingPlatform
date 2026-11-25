import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { ActorRequest } from '../../security/auth.guard';
import { AuthGuard } from '../../security/auth.guard';
import { NatsGatewayService } from '../nats/nats-gateway.service';

const createSchema = z.object({ otherUserId: z.uuid() }).strict();
const sendSchema = z.object({ clientMessageId: z.uuid(), content: z.string().trim().min(1).max(2000) }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Invalid request');
  return result.data;
}

function actor(req: ActorRequest) {
  if (!req.actor) throw new Error('Authenticated actor missing');
  return req.actor;
}

@Controller('conversations')
@UseGuards(AuthGuard)
export class ConversationsController {
  constructor(private readonly messaging: NatsGatewayService) {}

  @Post()
  create(@Req() req: ActorRequest, @Body() body: unknown) {
    return this.messaging.execute('createConversation', parse(createSchema, body), actor(req));
  }

  @Post('current-doctor')
  openCurrentDoctor(@Req() req: ActorRequest) {
    return this.messaging.execute('openCurrentDoctor', {}, actor(req));
  }

  @Get('care-contacts')
  careContacts(@Req() req: ActorRequest) {
    return this.messaging.execute('careContacts', {}, actor(req));
  }

  @Get()
  list(@Req() req: ActorRequest, @Query('limit') limit?: string) {
    return this.messaging.execute('listConversations', { limit: parse(z.coerce.number().int().min(1).max(50), limit ?? '50') }, actor(req));
  }

  @Get(':id/messages')
  history(@Req() req: ActorRequest, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string, @Query('before') before?: string) {
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(50), before: z.string().max(256).optional() }).strict(), { limit: limit ?? '50', before });
    return this.messaging.execute('listMessages', { conversationId: id, ...query }, actor(req));
  }

  @Post(':id/messages')
  send(@Req() req: ActorRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.messaging.execute('sendMessage', { conversationId: id, ...parse(sendSchema, body) }, actor(req));
  }
}
