<?php
/**
 * NexoraDC hooks for WHMCS.
 *
 *  - Client changes (added, edited, closed) are sent as client.upsert events so
 *    NexoraDC's customer stays in step. A closed client is only flagged for
 *    review in NexoraDC: it does not lock anyone out automatically.
 *  - Once a day the WHMCS cron sends a snapshot of all services using the
 *    NexoraDC module for reconciliation. NexoraDC reports differences and
 *    changes nothing.
 *
 * Uses the first enabled server of type "nexoradc" for the URL, integration id
 * and secret.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once dirname(__DIR__, 2) . '/modules/servers/nexoradc/lib/NexoraClient.php';

use NexoraDC\ApiError;
use NexoraDC\NexoraClient;
use WHMCS\Database\Capsule;

/** @return NexoraClient|null */
function nexoradc_hook_client()
{
    $server = Capsule::table('tblservers')->where('type', 'nexoradc')->where('disabled', 0)->orderBy('id')->first();
    if (!$server) {
        return null;
    }
    $dec = localAPI('DecryptPassword', array('password2' => $server->password));
    $secret = isset($dec['password']) ? $dec['password'] : '';
    $host = $server->hostname !== '' ? $server->hostname : $server->ipaddress;
    return new NexoraClient(($server->secure ? 'https://' : 'http://') . $host, $server->username, $secret);
}

function nexoradc_hook_client_event($userId, $status)
{
    $client = nexoradc_hook_client();
    if (!$client) {
        return;
    }
    $c = Capsule::table('tblclients')->where('id', (int) $userId)->first();
    if (!$c) {
        return;
    }
    $name = trim($c->companyname !== '' ? $c->companyname : trim($c->firstname . ' ' . $c->lastname));
    $data = array('clientId' => (string) $c->id, 'name' => $name !== '' ? $name : ('WHMCS client ' . $c->id), 'email' => $c->email, 'status' => $status ?: $c->status);
    try {
        $r = $client->sendEvent('client.upsert', $data);
        logActivity('NexoraDC: client ' . $c->id . ' sync: ' . (isset($r['status']) ? $r['status'] : 'sent'));
    } catch (ApiError $e) {
        logActivity('NexoraDC: client ' . $c->id . ' sync failed: ' . $e->getMessage());
    }
}

add_hook('ClientAdd', 1, function ($vars) {
    nexoradc_hook_client_event($vars['userid'] ?? $vars['client_id'] ?? 0, 'Active');
});

add_hook('ClientEdit', 1, function ($vars) {
    nexoradc_hook_client_event($vars['userid'] ?? 0, null);
});

add_hook('ClientClose', 1, function ($vars) {
    nexoradc_hook_client_event($vars['userid'] ?? 0, 'Closed');
});

add_hook('DailyCronJob', 1, function ($vars) {
    $client = nexoradc_hook_client();
    if (!$client) {
        return;
    }
    $rows = Capsule::table('tblhosting')
        ->join('tblproducts', 'tblproducts.id', '=', 'tblhosting.packageid')
        ->where('tblproducts.servertype', 'nexoradc')
        ->select('tblhosting.id', 'tblhosting.userid', 'tblhosting.packageid', 'tblhosting.domainstatus', 'tblhosting.domain', 'tblproducts.name')
        ->get();
    $services = array();
    foreach ($rows as $r) {
        $services[] = array(
            'serviceId' => (string) $r->id,
            'clientId' => (string) $r->userid,
            'productId' => (string) $r->packageid,
            'status' => (string) $r->domainstatus,
            'name' => $r->domain !== '' ? $r->domain : $r->name,
        );
    }
    try {
        $res = $client->reconcile($services);
        $s = $res['summary'];
        logActivity(sprintf('NexoraDC reconciliation: %d matched, %d missing in NexoraDC, %d missing in WHMCS, %d status and %d customer differences', $s['matched'], $s['missingInNexoradc'], $s['missingInWhmcs'], $s['statusMismatch'], $s['customerMismatch']));
    } catch (ApiError $e) {
        logActivity('NexoraDC reconciliation failed: ' . $e->getMessage());
    }
});
