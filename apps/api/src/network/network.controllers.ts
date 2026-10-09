import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  CIRCUIT_STATUSES,
  CREDENTIAL_KINDS,
  cableSchema,
  cableUpdateSchema,
  circuitSchema,
  credentialSchema,
  discoveryApplySchema,
  interfaceBulkCreateSchema,
  interfaceSchema,
  ipAllocateNextSchema,
  ipAssignSchema,
  ipListQuerySchema,
  ipReleaseSchema,
  ipUpdateSchema,
  ipamImportSchema,
  networkDetailsSchema,
  prefixListQuerySchema,
  prefixSchema,
  prefixUpdateSchema,
  providerSchema,
  vlanSchema,
  vrfSchema,
  type CredentialInput,
  type CredentialKind,
} from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { InterfacesService } from './interfaces.service';
import { NetworkInventoryService } from './inventory.service';
import { IpamService } from './ipam.service';
import { CredentialsService } from './credentials.service';
import { DiscoveryService } from './discovery/discovery.service';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const UUID = new ParseUUIDPipe();

const deviceListQuery = z.object({ q: z.string().trim().max(100).optional(), datacenterId: z.string().uuid().optional(), all: z.enum(['true', 'false']).optional() });
const cableListQuery = z.object({ deviceId: z.string().uuid().optional() });
const dcQuery = z.object({ datacenterId: z.string().uuid().optional() });
const circuitListQuery = z.object({ providerId: z.string().uuid().optional(), status: z.enum(CIRCUIT_STATUSES).optional() });
const discoveryStartSchema = z.object({ kind: z.enum(CREDENTIAL_KINDS), mode: z.enum(['test', 'discover']).default('discover') });
const exportKind = z.object({ kind: z.enum(['prefixes', 'addresses']).default('addresses') });
const kindParam = new ZodPipe(z.enum(CREDENTIAL_KINDS));

/* ------------------------------------------------------------ network */

@ApiTags('network')
@ApiCookieAuth()
@StaffOnly()
@Controller({ path: 'network', version: '1' })
export class NetworkController {
  constructor(
    private readonly ifaces: InterfacesService,
    private readonly inv: NetworkInventoryService,
  ) {}

  @Get('summary')
  @RequirePermissions('network.read')
  summary(@CurrentPrincipal() p: Principal) {
    return this.inv.summary(p);
  }

  @Get('devices')
  @RequirePermissions('network.read')
  @ApiOperation({ summary: 'Network devices (routers, switches, firewalls…) with port counts and last discovery. `all=true` lists every device.' })
  @ApiZodQuery(deviceListQuery)
  devices(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(deviceListQuery)) q: Infer<typeof deviceListQuery>) {
    return this.ifaces.listNetworkDevices(p, q);
  }

  @Get('devices/:id')
  @RequirePermissions('network.read')
  device(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.ifaces.deviceSummary(p, id);
  }

  @Patch('devices/:id')
  @RequirePermissions('network.write')
  @ApiOperation({ summary: 'Set platform and network role (the management address is part of the hardware record).' })
  @ApiZodBody(networkDetailsSchema)
  setDetails(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(networkDetailsSchema)) b: Infer<typeof networkDetailsSchema>, @ReqMeta() m: RequestMeta) {
    return this.ifaces.setNetworkDetails(p, id, b, m);
  }

  @Get('devices/:id/interfaces')
  @RequirePermissions('network.read')
  deviceInterfaces(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.ifaces.listForDevice(p, id);
  }

  @Get('interfaces/:id')
  @RequirePermissions('network.read')
  getInterface(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.ifaces.get(p, id);
  }

  @Post('interfaces')
  @RequirePermissions('network.write')
  @ApiZodBody(interfaceSchema)
  createInterface(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(interfaceSchema)) b: Infer<typeof interfaceSchema>, @ReqMeta() m: RequestMeta) {
    return this.ifaces.create(p, b, m);
  }

  @Post('interfaces/bulk')
  @RequirePermissions('network.write')
  @ApiOperation({ summary: 'Create ports from a pattern such as "ether[1-24]". Existing names are skipped.' })
  @ApiZodBody(interfaceBulkCreateSchema)
  bulkInterfaces(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(interfaceBulkCreateSchema)) b: Infer<typeof interfaceBulkCreateSchema>, @ReqMeta() m: RequestMeta) {
    return this.ifaces.bulkCreate(p, b, m);
  }

  @Put('interfaces/:id')
  @RequirePermissions('network.write')
  @ApiZodBody(interfaceSchema)
  updateInterface(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(interfaceSchema)) b: Infer<typeof interfaceSchema>, @ReqMeta() m: RequestMeta) {
    return this.ifaces.update(p, id, b, m);
  }

  @Delete('interfaces/:id')
  @HttpCode(204)
  @RequirePermissions('network.write')
  async deleteInterface(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.ifaces.remove(p, id, m);
  }

  // Cables -------------------------------------------------------------

  @Get('cables')
  @RequirePermissions('network.read')
  @ApiZodQuery(cableListQuery)
  cables(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(cableListQuery)) q: Infer<typeof cableListQuery>) {
    return this.inv.listCables(p, q);
  }

  @Post('cables')
  @RequirePermissions('network.write')
  @ApiZodBody(cableSchema)
  createCable(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(cableSchema)) b: Infer<typeof cableSchema>, @ReqMeta() m: RequestMeta) {
    return this.inv.createCable(p, b, m);
  }

  @Patch('cables/:id')
  @RequirePermissions('network.write')
  @ApiZodBody(cableUpdateSchema)
  updateCable(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(cableUpdateSchema)) b: Infer<typeof cableUpdateSchema>, @ReqMeta() m: RequestMeta) {
    return this.inv.updateCable(p, id, b, m);
  }

  @Delete('cables/:id')
  @HttpCode(204)
  @RequirePermissions('network.write')
  async deleteCable(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.inv.deleteCable(p, id, m);
  }

  // VLANs / VRFs -------------------------------------------------------

  @Get('vlans')
  @RequirePermissions('network.read')
  @ApiZodQuery(dcQuery)
  vlans(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(dcQuery)) q: Infer<typeof dcQuery>) {
    return this.inv.listVlans(p, q);
  }

  @Get('vlans/:id/ports')
  @RequirePermissions('network.read')
  vlanPorts(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.inv.vlanPorts(p, id);
  }

  @Post('vlans')
  @RequirePermissions('network.write')
  @ApiZodBody(vlanSchema)
  createVlan(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(vlanSchema)) b: Infer<typeof vlanSchema>, @ReqMeta() m: RequestMeta) {
    return this.inv.createVlan(p, b, m);
  }

  @Put('vlans/:id')
  @RequirePermissions('network.write')
  @ApiZodBody(vlanSchema)
  updateVlan(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(vlanSchema)) b: Infer<typeof vlanSchema>, @ReqMeta() m: RequestMeta) {
    return this.inv.updateVlan(p, id, b, m);
  }

  @Delete('vlans/:id')
  @HttpCode(204)
  @RequirePermissions('network.write')
  async deleteVlan(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.inv.deleteVlan(p, id, m);
  }

  @Get('vrfs')
  @RequirePermissions('network.read')
  vrfs(@CurrentPrincipal() p: Principal) {
    return this.inv.listVrfs(p);
  }

  @Post('vrfs')
  @RequirePermissions('network.write')
  @ApiZodBody(vrfSchema)
  createVrf(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(vrfSchema)) b: Infer<typeof vrfSchema>, @ReqMeta() m: RequestMeta) {
    return this.inv.createVrf(p, b, m);
  }

  @Put('vrfs/:id')
  @RequirePermissions('network.write')
  @ApiZodBody(vrfSchema)
  updateVrf(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(vrfSchema)) b: Infer<typeof vrfSchema>, @ReqMeta() m: RequestMeta) {
    return this.inv.updateVrf(p, id, b, m);
  }

  @Delete('vrfs/:id')
  @HttpCode(204)
  @RequirePermissions('network.write')
  async deleteVrf(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.inv.deleteVrf(p, id, m);
  }

  // Providers / circuits ----------------------------------------------

  @Get('providers')
  @RequirePermissions('network.read')
  providers(@CurrentPrincipal() p: Principal) {
    return this.inv.listProviders(p);
  }

  @Post('providers')
  @RequirePermissions('network.write')
  @ApiZodBody(providerSchema)
  createProvider(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(providerSchema)) b: Infer<typeof providerSchema>, @ReqMeta() m: RequestMeta) {
    return this.inv.createProvider(p, b, m);
  }

  @Put('providers/:id')
  @RequirePermissions('network.write')
  @ApiZodBody(providerSchema)
  updateProvider(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(providerSchema)) b: Infer<typeof providerSchema>, @ReqMeta() m: RequestMeta) {
    return this.inv.updateProvider(p, id, b, m);
  }

  @Delete('providers/:id')
  @HttpCode(204)
  @RequirePermissions('network.write')
  async deleteProvider(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.inv.deleteProvider(p, id, m);
  }

  @Get('circuits')
  @RequirePermissions('network.read')
  @ApiZodQuery(circuitListQuery)
  circuits(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(circuitListQuery)) q: Infer<typeof circuitListQuery>) {
    return this.inv.listCircuits(p, q);
  }

  @Get('circuits/:id/events')
  @RequirePermissions('network.read')
  circuitEvents(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.inv.circuitEventsFor(p, id);
  }

  @Post('circuits')
  @RequirePermissions('network.write')
  @ApiZodBody(circuitSchema)
  createCircuit(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(circuitSchema)) b: Infer<typeof circuitSchema>, @ReqMeta() m: RequestMeta) {
    return this.inv.createCircuit(p, b, m);
  }

  @Put('circuits/:id')
  @RequirePermissions('network.write')
  @ApiZodBody(circuitSchema)
  updateCircuit(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(circuitSchema)) b: Infer<typeof circuitSchema>, @ReqMeta() m: RequestMeta) {
    return this.inv.updateCircuit(p, id, b, m);
  }

  @Delete('circuits/:id')
  @HttpCode(204)
  @RequirePermissions('network.write')
  async deleteCircuit(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.inv.deleteCircuit(p, id, m);
  }

  @Get('topology')
  @RequirePermissions('network.read')
  @ApiOperation({ summary: 'Graph from documented cables, LLDP/CDP observations and circuits. Relationships are never inferred.' })
  @ApiZodQuery(dcQuery)
  topology(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(dcQuery)) q: Infer<typeof dcQuery>) {
    return this.inv.topology(p, q);
  }
}

/* ------------------------------------------------ credentials & discovery */

@ApiTags('network: discovery')
@ApiCookieAuth()
@StaffOnly()
@Controller({ path: 'network', version: '1' })
export class DiscoveryController {
  constructor(
    private readonly creds: CredentialsService,
    private readonly discovery: DiscoveryService,
  ) {}

  @Get('devices/:id/credentials')
  @RequirePermissions('network.read')
  @ApiOperation({ summary: 'Configured credentials (settings only; secrets are never returned).' })
  credentials(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.creds.list(p, id);
  }

  @Put('devices/:id/credentials')
  @RequirePermissions('monitoring.configure')
  @ApiOperation({ summary: 'Create or replace a read-only access credential. Secrets are write-only.' })
  putCredential(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(credentialSchema)) b: CredentialInput, @ReqMeta() m: RequestMeta) {
    return this.creds.put(p, id, b, m);
  }

  @Delete('devices/:id/credentials/:kind')
  @HttpCode(204)
  @RequirePermissions('monitoring.configure')
  async deleteCredential(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Param('kind', kindParam) kind: CredentialKind, @ReqMeta() m: RequestMeta) {
    await this.creds.remove(p, id, kind, m);
  }

  @Get('devices/:id/discovery')
  @RequirePermissions('network.read')
  runs(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.discovery.listRuns(p, id);
  }

  @Post('devices/:id/discovery')
  @RequirePermissions('network.write')
  @ApiOperation({ summary: 'Queue a connection test or a read-only discovery. The worker process does the collection.' })
  @ApiZodBody(discoveryStartSchema)
  start(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(discoveryStartSchema)) b: Infer<typeof discoveryStartSchema>, @ReqMeta() m: RequestMeta) {
    return this.discovery.start(p, id, b.kind, b.mode, m);
  }

  @Get('discovery/:runId')
  @RequirePermissions('network.read')
  @ApiOperation({ summary: 'Run status, collected data and the preview of changes.' })
  run(@CurrentPrincipal() p: Principal, @Param('runId', UUID) runId: string) {
    return this.discovery.getRun(p, runId);
  }

  @Post('discovery/:runId/apply')
  @RequirePermissions('network.write')
  @ApiOperation({ summary: 'Write the selected interfaces, neighbors and facts into inventory. Never deletes and never touches device configuration.' })
  @ApiZodBody(discoveryApplySchema)
  apply(@CurrentPrincipal() p: Principal, @Param('runId', UUID) runId: string, @Body(new ZodPipe(discoveryApplySchema)) b: Infer<typeof discoveryApplySchema>, @ReqMeta() m: RequestMeta) {
    return this.discovery.apply(p, runId, b, m);
  }
}

/* --------------------------------------------------------------- IPAM */

@ApiTags('ipam')
@ApiCookieAuth()
@Controller({ path: 'ipam', version: '1' })
export class IpamController {
  constructor(private readonly ipam: IpamService) {}

  @Get('summary')
  @StaffOnly()
  @RequirePermissions('ipam.read')
  summary(@CurrentPrincipal() p: Principal) {
    return this.ipam.summary(p);
  }

  @Get('prefixes')
  @RequirePermissions('ipam.read')
  @ApiOperation({ summary: 'Prefixes with hierarchy depth and utilization. Customers see only prefixes assigned to them.' })
  @ApiZodQuery(prefixListQuerySchema)
  prefixes(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(prefixListQuerySchema)) q: Infer<typeof prefixListQuerySchema>) {
    return this.ipam.listPrefixes(p, q);
  }

  @Get('prefixes/:id')
  @RequirePermissions('ipam.read')
  prefix(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.ipam.getPrefix(p, id);
  }

  @Post('prefixes')
  @StaffOnly()
  @RequirePermissions('ipam.write')
  @ApiZodBody(prefixSchema)
  createPrefix(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(prefixSchema)) b: Infer<typeof prefixSchema>, @ReqMeta() m: RequestMeta) {
    return this.ipam.createPrefix(p, b, m);
  }

  @Put('prefixes/:id')
  @StaffOnly()
  @RequirePermissions('ipam.write')
  @ApiZodBody(prefixUpdateSchema)
  updatePrefix(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(prefixUpdateSchema)) b: Infer<typeof prefixUpdateSchema>, @ReqMeta() m: RequestMeta) {
    return this.ipam.updatePrefix(p, id, b, m);
  }

  @Delete('prefixes/:id')
  @HttpCode(204)
  @StaffOnly()
  @RequirePermissions('ipam.write')
  async deletePrefix(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.ipam.deletePrefix(p, id, m);
  }

  @Get('addresses')
  @RequirePermissions('ipam.read')
  @ApiZodQuery(ipListQuerySchema)
  addresses(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(ipListQuerySchema)) q: Infer<typeof ipListQuerySchema>) {
    return this.ipam.listAddresses(p, q);
  }

  @Get('addresses/:id')
  @RequirePermissions('ipam.read')
  address(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.ipam.getAddress(p, id);
  }

  @Get('addresses/:id/history')
  @StaffOnly()
  @RequirePermissions('ipam.read')
  history(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.ipam.history(p, id);
  }

  @Post('addresses')
  @StaffOnly()
  @RequirePermissions('ipam.write')
  @ApiOperation({ summary: 'Reserve or allocate a specific address. Does not configure any device or announce any route.' })
  @ApiZodBody(ipAssignSchema)
  assign(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(ipAssignSchema)) b: Infer<typeof ipAssignSchema>, @ReqMeta() m: RequestMeta) {
    return this.ipam.assign(p, b, m);
  }

  @Post('allocate-next')
  @StaffOnly()
  @RequirePermissions('ipam.write')
  @ApiOperation({ summary: 'Atomically allocate the next N free addresses of a prefix.' })
  @ApiZodBody(ipAllocateNextSchema)
  allocateNext(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(ipAllocateNextSchema)) b: Infer<typeof ipAllocateNextSchema>, @ReqMeta() m: RequestMeta) {
    return this.ipam.allocateNext(p, b, m);
  }

  @Patch('addresses/:id')
  @StaffOnly()
  @RequirePermissions('ipam.write')
  @ApiZodBody(ipUpdateSchema)
  updateAddress(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(ipUpdateSchema)) b: Infer<typeof ipUpdateSchema>, @ReqMeta() m: RequestMeta) {
    return this.ipam.updateAddress(p, id, b, m);
  }

  @Post('addresses/:id/release')
  @StaffOnly()
  @RequirePermissions('ipam.write')
  @ApiZodBody(ipReleaseSchema)
  release(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(ipReleaseSchema)) b: Infer<typeof ipReleaseSchema>, @ReqMeta() m: RequestMeta) {
    return this.ipam.release(p, id, b.reason, m);
  }

  @Get('conflicts')
  @StaffOnly()
  @RequirePermissions('ipam.read')
  conflicts(@CurrentPrincipal() p: Principal) {
    return this.ipam.conflicts(p);
  }

  @Get('export.csv')
  @StaffOnly()
  @RequirePermissions('ipam.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="ipam.csv"')
  @ApiZodQuery(exportKind)
  exportCsv(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(exportKind)) q: Infer<typeof exportKind>) {
    return this.ipam.exportCsv(p, q.kind);
  }

  @Post('import')
  @StaffOnly()
  @RequirePermissions('ipam.write')
  @ApiOperation({ summary: 'CSV import of prefixes or addresses. dryRun (default true) validates without saving.' })
  @ApiZodBody(ipamImportSchema)
  importCsv(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(ipamImportSchema)) b: Infer<typeof ipamImportSchema>, @ReqMeta() m: RequestMeta) {
    return this.ipam.importCsv(p, b.kind, b.csv, b.dryRun, m);
  }
}
