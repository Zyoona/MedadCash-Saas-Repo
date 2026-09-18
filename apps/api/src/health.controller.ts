import { Controller, Get } from '@nestjs/common';
import { Public } from './modules/auth/auth.guard.js';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  health() {
    return { status: 'ok', service: 'medad-api', time: new Date().toISOString() };
  }
}
