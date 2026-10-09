import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { customerSchema, type CustomerInput } from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { CustomersService, customerListQuerySchema } from './customers.service';

@ApiTags('customers')
@ApiCookieAuth()
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(private readonly customersSvc: CustomersService) {}

  @Get('me')
  @ApiOperation({ summary: "Customer-portal users: the customer account they belong to." })
  mine(@CurrentPrincipal() p: Principal) {
    if (p.userType !== 'customer' || !p.customerId) {
      throw new ForbiddenException({ error: 'forbidden', message: 'Only customer users have a customer account' });
    }
    return this.customersSvc.get(p, p.customerId);
  }

  @Get()
  @RequirePermissions('customers.read')
  @ApiZodQuery(customerListQuerySchema)
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(customerListQuerySchema)) q: z.infer<typeof customerListQuerySchema>) {
    return this.customersSvc.list(p, q);
  }

  @Get(':id')
  @RequirePermissions('customers.read')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.customersSvc.get(p, id);
  }

  @Post()
  @RequirePermissions('customers.write')
  @ApiZodBody(customerSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(customerSchema)) body: CustomerInput, @ReqMeta() meta: RequestMeta) {
    return this.customersSvc.create(p, body, meta);
  }

  @Patch(':id')
  @RequirePermissions('customers.write')
  @ApiZodBody(customerSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(customerSchema)) body: CustomerInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.customersSvc.update(p, id, body, meta);
  }
}
