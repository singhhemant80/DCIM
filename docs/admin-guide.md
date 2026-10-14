# Administrator guide

For datacenter staff using NexoraDC. Running the server itself (install,
backups, upgrades) is in the [operations guide](operations.md).

## First day

1. Sign in with the administrator account the installer printed. Change its password and turn on two-factor sign-in under **Account**.
2. **System Settings**: organization name, time zone (date filters and daily energy use it) and currency.
3. **Users & Permissions**: create staff accounts. Give each person the narrowest built-in role that fits:

   | Role | For |
   |---|---|
   | Super Administrator | Everything, including roles, settings, API keys and billing |
   | Operations Administrator | Everything except roles, settings, API keys and billing |
   | NOC Engineer | Read everything, acknowledge alerts, work tickets |
   | Datacenter Technician | Physical inventory, read network/IP/power, tickets |
   | Auditor | Read everything, change nothing |

   Custom roles can be built from the permission catalog. Permissions marked staff-only can never be given to customers.
4. Build the physical tree: **Datacenters** → **Buildings & Rooms** (rows, floor tiles) → **Racks & Elevation**.
5. Add device models (manufacturer, height, depth, typical power), then **Servers & Hardware**. A device moves through lifecycle states (inventory → racked → provisioning → active → maintenance → retired). The rules are enforced, and every move and change is in its history.

## Physical inventory

* **Rack elevation:** drag devices into free units. The database refuses overlaps. Colours show reachability: green when the BMC and OS answer, amber when only one does, red when neither does, grey when not checked.
* **Servers & Hardware:** filter by state, customer and dates; select devices to print labels (QR codes); import and export CSV.
* **Device page:**
  * BMC and OS addresses with reachability.
  * Power now, plus energy and cost for a period.
  * **Hardware from the BMC**: CPUs, memory, disks, RAID, power supplies, fans, temperatures, NICs and the event log, read only with a Redfish credential. Older Dell iDRACs list memory over WS-Man.
  * Equipment and accessories (cables, rails, trays), with optional spare-stock movements.
  * Remote console.
* **Spare parts:** stock levels with movements and low-stock warnings.

## Network and IP

* **Network Infrastructure:**
  * Devices, ports, cables, VLANs, VRFs, providers and circuits.
  * Topology is drawn only from verified sources: cables you record and neighbours the devices report.
  * Credentials are write-only: nobody can read them back, not even administrators.
  * Discovery is read-only and shows a preview before anything is applied.
* **Network Monitoring:** per-port rates, 95th percentile, history and a live view. Polling runs in the worker whether or not anyone has the page open.
* **IP Address Management:** prefixes and addresses. "Allocate next" is atomic, so two people never get the same address. Allocation **never** changes a router or announces BGP; it is a record, plus DNS records if DNS servers are configured.

## Power

Readings come from Redfish, IPMI DCMI, metered PDUs (SNMP) and switch supplies:

* Each device is counted once, from its best source.
* Figures are labelled **measured**, **estimated** (model typical draw) or **unknown**, and these are never mixed silently.
* Energy is time-weighted per hour.
* Tariffs give cost.
* Totals are available per rack, datacenter, category and customer, with CSV export.

## Alerts and maintenance

* **Monitoring & Alerts:**
  * Rules on port metrics, with a duration and a number of consecutive samples.
  * Notifications go by email, webhook, Slack or Telegram.
  * Alerts **never** shut ports or change routes; they only notify.
* **Maintenance & Incidents:** maintenance windows suppress alerts for the affected equipment. Incident and maintenance notices are shown to the affected customers.

## Customers and services

* **Customers & Tenants:** customer accounts and their users (Customer Administrator or Customer Viewer). Customers see only their own equipment, addresses, power, bandwidth, tickets and services.
* **Colocation:**
  * Rack allocations (full, half, quarter or custom U range) with contracted power.
  * Customer equipment, including servers racked without an allocation.
  * Cross-connects, receiving and visitors.
* **Orders & Services:** each service links to its rack space, servers, VMs and cross-connects, with a billing reference. It is kept in step with WHMCS when the billing integration is set up.
* **Remote Hands & Tickets:** requests from customers and staff, with replies and status.

## Provisioning and consoles

* **Server Provisioning:**
  * OS installs over PXE/iPXE or Redfish virtual media, from the **OS & Images** library (checksums verified).
  * Power actions need the `hardware.control` permission and a typed confirmation.
  * A job reports "completed" only after its result has been checked.
* **Remote console:** graphical (VNC through the worker), serial over LAN, or a link to the BMC web interface (staff only).
  * Sessions are one at a time per device and recorded in the audit log.
  * A session ends after 15 minutes idle or 8 hours.
  * Customers get console access only to their own servers, and only if their role allows it.
* **Proxmox / Virtualizor:** read-only inventory sync, plus VM and VPS actions through provisioning jobs.

## Automation, reports, integrations

* **Automation & Workflows:** triggers, conditions, approvals and dry-run.
* **Reports & Analytics:** CSV and PDF reports, scheduled by email.
* **API & Integrations:** API keys (shown once, with scoped permissions) and signed webhook subscriptions.
* **Billing Integrations:** WHMCS. Events are signed and idempotent, so a duplicate is ignored.

## Audit

Every change, sign-in and console session is in **Audit Logs**:

* Each organization's log is a hash chain, and the database refuses to edit or delete entries.
* "Verify" re-checks the chain.
* The daily anchor (see the operations guide) also detects removal of the newest entries.
* Secrets are never written to the log.
