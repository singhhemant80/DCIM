import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { auditQuerySchema } from '@crapplet/shared';
import { ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { AuditService } from './audit.service';

@ApiTags('audit')
@ApiCookieAuth()
@StaffOnly()
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  @ApiZodQuery(auditQuerySchema)
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(auditQuerySchema)) q: z.infer<typeof auditQuerySchema>) {
    return this.audit.list(p, q);
  }

  @Get('verify')
  @RequirePermissions('audit.read')
  @ApiOperation({ summary: 'Recompute the hash chain and report the first tampered record, if any.' })
  verify(@CurrentPrincipal() p: Principal) {
    return this.audit.verifyChain(p.orgId);
  }
}
