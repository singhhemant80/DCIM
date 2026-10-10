import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { REPORT_LABELS, REPORT_PERIODS, REPORT_TYPES, reportQuerySchema, reportScheduleSchema } from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { ReportsService } from './reports.service';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const UUID = new ParseUUIDPipe();

/** Reports (JSON, CSV, PDF). Customers get their own account; schedules are staff work. */
@ApiTags('reports')
@ApiCookieAuth()
@ApiBearerAuth()
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get('types')
  @RequirePermissions('reports.read')
  types(@CurrentPrincipal() p: Principal) {
    return {
      types: REPORT_TYPES.filter((t) => p.userType === 'staff' || t !== 'capacity').map((t) => ({ key: t, label: REPORT_LABELS[t] })),
      periods: REPORT_PERIODS,
    };
  }

  @Get()
  @RequirePermissions('reports.read')
  @ApiOperation({ summary: 'Generate a report. format=csv or pdf returns a file download.' })
  @ApiZodQuery(reportQuerySchema)
  async report(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(reportQuerySchema)) q: Infer<typeof reportQuerySchema>, @Res({ passthrough: true }) res: Response) {
    const out = await this.svc.render(p, q.type, q.period, q.format);
    if (!out.body) return out.report;
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(out.body, { type: out.contentType, disposition: `attachment; filename="${out.filename}"`, length: out.body.length });
  }

  @Get('schedules')
  @StaffOnly()
  @RequirePermissions('reports.read')
  schedules(@CurrentPrincipal() p: Principal) {
    return this.svc.schedules(p);
  }

  @Post('schedules')
  @StaffOnly()
  @RequirePermissions('reports.read', 'alerts.manage')
  @ApiOperation({ summary: 'Email a report on a schedule through an email notification channel.' })
  @ApiZodBody(reportScheduleSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(reportScheduleSchema)) b: Infer<typeof reportScheduleSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.createSchedule(p, b, meta);
  }

  @Put('schedules/:id')
  @StaffOnly()
  @RequirePermissions('reports.read', 'alerts.manage')
  @ApiZodBody(reportScheduleSchema)
  update(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(reportScheduleSchema)) b: Infer<typeof reportScheduleSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.updateSchedule(p, id, b, meta);
  }

  @Post('schedules/:id/run')
  @HttpCode(200)
  @StaffOnly()
  @RequirePermissions('reports.read', 'alerts.manage')
  run(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.runNow(p, id, meta);
  }

  @Delete('schedules/:id')
  @StaffOnly()
  @RequirePermissions('reports.read', 'alerts.manage')
  remove(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.deleteSchedule(p, id, meta);
  }
}
