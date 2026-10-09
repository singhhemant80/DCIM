CREATE TYPE "public"."cable_end" AS ENUM('a', 'b');--> statement-breakpoint
CREATE TYPE "public"."cable_status" AS ENUM('planned', 'connected', 'decommissioning');--> statement-breakpoint
CREATE TYPE "public"."cable_type" AS ENUM('cat5e', 'cat6', 'cat6a', 'dac', 'aoc', 'mmf', 'smf', 'other');--> statement-breakpoint
CREATE TYPE "public"."circuit_status" AS ENUM('planned', 'provisioning', 'active', 'decommissioned');--> statement-breakpoint
CREATE TYPE "public"."circuit_type" AS ENUM('internet_transit', 'ip_peering', 'transport', 'cross_connect', 'mpls', 'other');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('snmp_v2c', 'snmp_v3', 'routeros_rest', 'fortios_rest', 'nxapi');--> statement-breakpoint
CREATE TYPE "public"."discovery_mode" AS ENUM('test', 'discover');--> statement-breakpoint
CREATE TYPE "public"."discovery_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."interface_kind" AS ENUM('physical', 'lag', 'vlan', 'bridge', 'tunnel', 'loopback', 'virtual', 'management');--> statement-breakpoint
CREATE TYPE "public"."interface_media" AS ENUM('copper', 'sfp', 'sfp_plus', 'sfp28', 'qsfp_plus', 'qsfp28', 'qsfp_dd', 'other');--> statement-breakpoint
CREATE TYPE "public"."ip_role" AS ENUM('primary', 'secondary', 'gateway', 'vip', 'anycast', 'loopback', 'management');--> statement-breakpoint
CREATE TYPE "public"."ip_status" AS ENUM('reserved', 'allocated', 'deprecated', 'released');--> statement-breakpoint
CREATE TYPE "public"."neighbor_protocol" AS ENUM('lldp', 'cdp', 'mndp');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('routeros', 'nxos', 'ios', 'iosxe', 'fortios', 'junos', 'linux', 'windows', 'proxmox', 'other');--> statement-breakpoint
CREATE TYPE "public"."prefix_status" AS ENUM('container', 'active', 'reserved', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."vlan_mode" AS ENUM('access', 'tagged', 'tagged_all');--> statement-breakpoint
CREATE TYPE "public"."vlan_status" AS ENUM('active', 'reserved', 'deprecated');--> statement-breakpoint
CREATE TABLE "cable_ends" (
	"cable_id" uuid NOT NULL,
	"end" "cable_end" NOT NULL,
	"interface_id" uuid NOT NULL,
	CONSTRAINT "cable_ends_cable_id_end_pk" PRIMARY KEY("cable_id","end")
);
--> statement-breakpoint
CREATE TABLE "cables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "cable_type",
	"status" "cable_status" DEFAULT 'connected' NOT NULL,
	"label" text,
	"color" text,
	"length_m" numeric(8, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "circuit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"circuit_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"kind" text NOT NULL,
	"summary" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "circuits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"cid" text NOT NULL,
	"type" "circuit_type" NOT NULL,
	"status" "circuit_status" DEFAULT 'active' NOT NULL,
	"commit_bps" bigint,
	"port_speed_bps" bigint,
	"install_date" date,
	"term_end_date" date,
	"datacenter_id" uuid,
	"interface_id" uuid,
	"z_side" text,
	"customer_id" uuid,
	"description" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"host" text,
	"port" integer,
	"username" text,
	"secret_enc" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_message" text,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"credential_kind" "credential_kind" NOT NULL,
	"mode" "discovery_mode" NOT NULL,
	"status" "discovery_status" DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"requested_label" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"result" jsonb,
	"applied_at" timestamp with time zone,
	"applied_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interface_tagged_vlans" (
	"interface_id" uuid NOT NULL,
	"vlan_id" uuid NOT NULL,
	CONSTRAINT "interface_tagged_vlans_interface_id_vlan_id_pk" PRIMARY KEY("interface_id","vlan_id")
);
--> statement-breakpoint
CREATE TABLE "interfaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "interface_kind" NOT NULL,
	"media" "interface_media",
	"description" text,
	"mac_address" "macaddr",
	"mtu" integer,
	"speed_bps" bigint,
	"enabled" boolean DEFAULT true NOT NULL,
	"lag_id" uuid,
	"parent_id" uuid,
	"mode" "vlan_mode",
	"untagged_vlan_id" uuid,
	"if_index" integer,
	"monitored" boolean DEFAULT true NOT NULL,
	"count_in_totals" boolean DEFAULT false NOT NULL,
	"discovered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interfaces_mtu_ck" CHECK ("interfaces"."mtu" is null or "interfaces"."mtu" between 64 and 65535),
	CONSTRAINT "interfaces_speed_ck" CHECK ("interfaces"."speed_bps" is null or "interfaces"."speed_bps" > 0),
	CONSTRAINT "interfaces_not_self_ck" CHECK ("interfaces"."lag_id" is distinct from "interfaces"."id" and "interfaces"."parent_id" is distinct from "interfaces"."id")
);
--> statement-breakpoint
CREATE TABLE "ip_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"vrf_id" uuid,
	"address" "inet" NOT NULL,
	"prefix_length" integer,
	"status" "ip_status" NOT NULL,
	"role" "ip_role",
	"dns_name" text,
	"reverse_dns" text,
	"customer_id" uuid,
	"device_id" uuid,
	"interface_id" uuid,
	"service_ref" text,
	"reserved_until" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ip_addresses_host_ck" CHECK (masklen("ip_addresses"."address") = case family("ip_addresses"."address") when 4 then 32 else 128 end),
	CONSTRAINT "ip_addresses_prefix_length_ck" CHECK ("ip_addresses"."prefix_length" is null or "ip_addresses"."prefix_length" between 0 and case family("ip_addresses"."address") when 4 then 32 else 128 end),
	CONSTRAINT "ip_addresses_released_ck" CHECK ("ip_addresses"."status" <> 'released' or ("ip_addresses"."device_id" is null and "ip_addresses"."interface_id" is null and "ip_addresses"."customer_id" is null))
);
--> statement-breakpoint
CREATE TABLE "ip_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"ip_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "neighbor_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"interface_id" uuid NOT NULL,
	"protocol" "neighbor_protocol" NOT NULL,
	"remote_chassis_id" text DEFAULT '' NOT NULL,
	"remote_system_name" text,
	"remote_port_id" text DEFAULT '' NOT NULL,
	"remote_port_description" text,
	"remote_mgmt_address" text,
	"remote_platform" text,
	"matched_interface_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prefixes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"vrf_id" uuid,
	"prefix" "cidr" NOT NULL,
	"status" "prefix_status" DEFAULT 'active' NOT NULL,
	"is_pool" boolean DEFAULT false NOT NULL,
	"datacenter_id" uuid,
	"vlan_id" uuid,
	"customer_id" uuid,
	"gateway" "inet",
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prefixes_gateway_ck" CHECK ("prefixes"."gateway" is null or ("prefixes"."gateway" <<= "prefixes"."prefix" and masklen("prefixes"."gateway") = case family("prefixes"."gateway") when 4 then 32 else 128 end))
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"asn" bigint,
	"account_number" text,
	"portal_url" text,
	"noc_email" text,
	"noc_phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vlans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"datacenter_id" uuid,
	"vid" integer NOT NULL,
	"name" text NOT NULL,
	"status" "vlan_status" DEFAULT 'active' NOT NULL,
	"customer_id" uuid,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vlans_vid_ck" CHECK ("vlans"."vid" between 1 and 4094)
);
--> statement-breakpoint
CREATE TABLE "vrfs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rd" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "platform" "platform";--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "network_role" text;--> statement-breakpoint
ALTER TABLE "cable_ends" ADD CONSTRAINT "cable_ends_cable_id_cables_id_fk" FOREIGN KEY ("cable_id") REFERENCES "public"."cables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cable_ends" ADD CONSTRAINT "cable_ends_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cables" ADD CONSTRAINT "cables_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuit_events" ADD CONSTRAINT "circuit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuit_events" ADD CONSTRAINT "circuit_events_circuit_id_circuits_id_fk" FOREIGN KEY ("circuit_id") REFERENCES "public"."circuits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuits" ADD CONSTRAINT "circuits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuits" ADD CONSTRAINT "circuits_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuits" ADD CONSTRAINT "circuits_datacenter_id_datacenters_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuits" ADD CONSTRAINT "circuits_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuits" ADD CONSTRAINT "circuits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_tagged_vlans" ADD CONSTRAINT "interface_tagged_vlans_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_tagged_vlans" ADD CONSTRAINT "interface_tagged_vlans_vlan_id_vlans_id_fk" FOREIGN KEY ("vlan_id") REFERENCES "public"."vlans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interfaces" ADD CONSTRAINT "interfaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interfaces" ADD CONSTRAINT "interfaces_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interfaces" ADD CONSTRAINT "interfaces_lag_id_interfaces_id_fk" FOREIGN KEY ("lag_id") REFERENCES "public"."interfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interfaces" ADD CONSTRAINT "interfaces_parent_id_interfaces_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."interfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interfaces" ADD CONSTRAINT "interfaces_untagged_vlan_id_vlans_id_fk" FOREIGN KEY ("untagged_vlan_id") REFERENCES "public"."vlans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD CONSTRAINT "ip_addresses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD CONSTRAINT "ip_addresses_vrf_id_vrfs_id_fk" FOREIGN KEY ("vrf_id") REFERENCES "public"."vrfs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD CONSTRAINT "ip_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD CONSTRAINT "ip_addresses_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD CONSTRAINT "ip_addresses_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_events" ADD CONSTRAINT "ip_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_events" ADD CONSTRAINT "ip_events_ip_id_ip_addresses_id_fk" FOREIGN KEY ("ip_id") REFERENCES "public"."ip_addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighbor_observations" ADD CONSTRAINT "neighbor_observations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighbor_observations" ADD CONSTRAINT "neighbor_observations_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighbor_observations" ADD CONSTRAINT "neighbor_observations_matched_interface_id_interfaces_id_fk" FOREIGN KEY ("matched_interface_id") REFERENCES "public"."interfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prefixes" ADD CONSTRAINT "prefixes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prefixes" ADD CONSTRAINT "prefixes_vrf_id_vrfs_id_fk" FOREIGN KEY ("vrf_id") REFERENCES "public"."vrfs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prefixes" ADD CONSTRAINT "prefixes_datacenter_id_datacenters_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prefixes" ADD CONSTRAINT "prefixes_vlan_id_vlans_id_fk" FOREIGN KEY ("vlan_id") REFERENCES "public"."vlans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prefixes" ADD CONSTRAINT "prefixes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vlans" ADD CONSTRAINT "vlans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vlans" ADD CONSTRAINT "vlans_datacenter_id_datacenters_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vlans" ADD CONSTRAINT "vlans_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vrfs" ADD CONSTRAINT "vrfs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cable_ends_interface_uq" ON "cable_ends" USING btree ("interface_id");--> statement-breakpoint
CREATE INDEX "circuit_events_circuit_idx" ON "circuit_events" USING btree ("circuit_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "circuits_provider_cid_uq" ON "circuits" USING btree ("provider_id",lower("cid"));--> statement-breakpoint
CREATE UNIQUE INDEX "circuits_interface_uq" ON "circuits" USING btree ("interface_id") WHERE "circuits"."interface_id" is not null and "circuits"."status" <> 'decommissioned';--> statement-breakpoint
CREATE UNIQUE INDEX "device_credentials_device_kind_uq" ON "device_credentials" USING btree ("device_id","kind");--> statement-breakpoint
CREATE INDEX "discovery_runs_device_idx" ON "discovery_runs" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_runs_one_active_uq" ON "discovery_runs" USING btree ("device_id") WHERE "discovery_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "interface_tagged_vlans_vlan_idx" ON "interface_tagged_vlans" USING btree ("vlan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interfaces_device_name_uq" ON "interfaces" USING btree ("device_id",lower("name"));--> statement-breakpoint
CREATE INDEX "interfaces_org_idx" ON "interfaces" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "interfaces_lag_idx" ON "interfaces" USING btree ("lag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ip_addresses_vrf_address_uq" ON "ip_addresses" USING btree ("org_id",coalesce("vrf_id", '00000000-0000-0000-0000-000000000000'::uuid),"address");--> statement-breakpoint
CREATE INDEX "ip_addresses_customer_idx" ON "ip_addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "ip_addresses_device_idx" ON "ip_addresses" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "ip_addresses_interface_idx" ON "ip_addresses" USING btree ("interface_id");--> statement-breakpoint
CREATE INDEX "ip_events_ip_idx" ON "ip_events" USING btree ("ip_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "neighbor_obs_uq" ON "neighbor_observations" USING btree ("interface_id","protocol","remote_chassis_id","remote_port_id");--> statement-breakpoint
CREATE INDEX "neighbor_obs_matched_idx" ON "neighbor_observations" USING btree ("matched_interface_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prefixes_vrf_prefix_uq" ON "prefixes" USING btree ("org_id",coalesce("vrf_id", '00000000-0000-0000-0000-000000000000'::uuid),"prefix");--> statement-breakpoint
CREATE INDEX "prefixes_org_idx" ON "prefixes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "prefixes_customer_idx" ON "prefixes" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "providers_org_name_uq" ON "providers" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "vlans_scope_vid_uq" ON "vlans" USING btree ("org_id",coalesce("datacenter_id", '00000000-0000-0000-0000-000000000000'::uuid),"vid");--> statement-breakpoint
CREATE UNIQUE INDEX "vrfs_org_name_uq" ON "vrfs" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "vrfs_org_rd_uq" ON "vrfs" USING btree ("org_id","rd") WHERE "vrfs"."rd" is not null;