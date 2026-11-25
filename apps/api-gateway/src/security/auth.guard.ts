import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { SupabaseJwtVerifier } from '@messaging/security';
import type { LoggedRequest } from '../transport/http/request-logging';

export interface Actor { id: string; accessToken: string; requestId?: string }
export interface ActorRequest extends LoggedRequest { actor?: Actor }

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  constructor(private readonly verifier: SupabaseJwtVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ActorRequest>();
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!match) {
      this.logger.warn(`service=api-gateway stage=auth.reject requestId=${req.requestId ?? 'unknown'} reason=missing_bearer`);
      throw new UnauthorizedException('Bearer token required');
    }
    try {
      const id = await this.verifier.verify(match[1]);
      req.actor = { id, accessToken: match[1], requestId: req.requestId };
      this.logger.log(`service=api-gateway stage=auth.accept requestId=${req.requestId ?? 'unknown'}`);
      return true;
    } catch {
      this.logger.warn(`service=api-gateway stage=auth.reject requestId=${req.requestId ?? 'unknown'} reason=invalid_token`);
      throw new UnauthorizedException('Invalid access token');
    }
  }
}
