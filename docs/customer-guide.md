# Customer portal guide

For customers of a datacenter that runs NexoraDC. You see only your own
company's equipment and services.

## Signing in

Your datacenter creates your account and sends you the address of the portal.
Sign in with your email and password, then go to **Account** to:

* change your password,
* turn on two-factor sign-in (recommended): scan the QR code with an authenticator app and keep the recovery codes somewhere safe,
* see and end your active sessions.

Your role decides what you can do:

| Role | Can |
|---|---|
| Customer Administrator | See everything below, open and reply to tickets, use power actions and consoles on your own servers where the datacenter allows it, run reports |
| Customer Viewer | See everything below, read tickets |

## What you can see

| Page | Contents |
|---|---|
| **Overview** | A summary of your equipment, power and bandwidth |
| **Servers & Hardware** | Your servers and devices with their rack position, BMC (iDRAC/iLO) and server addresses, reachability, and power now with energy and cost per period. On a server's page: serial number, firmware and warranty; the hardware read from its BMC (CPUs, memory modules, disks and RAID, power supplies, fans and temperatures, network ports, health and the BMC event log); its IP addresses; the switch ports it is cabled to with live traffic; and the cables and accessories fitted with it |
| **IP Address Management** | Your IP addresses and prefixes |
| **Network Monitoring** | Traffic on the ports connected to your equipment, live and as history, with the 95th percentile |
| **Power Consumption** | Power and energy per server and in total, measured or estimated, for any date range. Amounts in money appear only if the datacenter shows them |
| **Colocation** | Your rack space with contracted power and use, and cross-connects |
| **Orders & Services** | Your services and their status |
| **Remote Hands & Tickets** | Requests to the datacenter team (remote hands, receiving goods, visits) with replies |
| **Maintenance & Incidents** | Notices that affect your equipment |
| **Reports** | CSV and PDF reports for your account |

All lists can be filtered by date. Figures marked **estimated** come from the
equipment's typical draw because no meter reads that device. **Measured**
figures come from its BMC or PDU.

## Remote console and power

If your datacenter has enabled it for your server and your role, the server
page offers:

* **Console**: the server's screen and keyboard, in the browser.
* **Serial console**: a text console over the BMC.
* **Power on, off or restart**: you must type the server's name to confirm.

Only one person can use a server's console at a time. A session ends after
15 minutes without activity. Every session and power action is recorded.

## Getting help

Open a ticket under **Remote Hands & Tickets**. For anything urgent, use the
phone number your datacenter gave you.
