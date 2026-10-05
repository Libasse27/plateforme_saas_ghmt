import { Global, Module } from '@nestjs/common';
import { PlatformAuditService } from './platform-audit.service';

/** Journal d'audit plateforme, partagé par les modules `platform` et `subscriptions`. */
@Global()
@Module({ providers: [PlatformAuditService], exports: [PlatformAuditService] })
export class PlatformAuditModule {}
