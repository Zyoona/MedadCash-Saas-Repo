import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
