import { Controller, Get, Header } from '@nestjs/common';

@Controller('public-config')
export class PublicConfigController {
  @Get()
  @Header('Cache-Control', 'no-store')
  getConfig() {
    return {
      supabaseUrl: process.env.SUPABASE_URL ?? '',
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
    };
  }
}
