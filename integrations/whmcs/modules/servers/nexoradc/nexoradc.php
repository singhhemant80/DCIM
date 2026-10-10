<?php
/**
 * NexoraDC provisioning module for WHMCS.
 *
 * Keeps NexoraDC's service records in step with WHMCS: create, suspend,
 * unsuspend and terminate send signed, idempotent events. NexoraDC records the
 * change only — it never powers equipment off or changes the network because
 * of a billing event; datacenter staff act on suspended services themselves.
 *
 * Server setup in WHMCS (System Settings → Servers → Add New Server):
 *   Module:    NexoraDC
 *   Hostname:  your NexoraDC address, e.g. dcim.example.com
 *   Username:  the integration id shown in NexoraDC → Billing integrations
 *   Password:  the shared secret shown once when the integration was created
 *   Secure:    tick to use HTTPS (recommended; required outside a lab)
 *
 * The NexoraDC service is matched by the WHMCS service id (its billing
 * reference) and the customer by the WHMCS client id.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once __DIR__ . '/lib/NexoraClient.php';

use NexoraDC\ApiError;
use NexoraDC\NexoraClient;

function nexoradc_MetaData()
{
    return array(
        'DisplayName' => 'NexoraDC',
        'APIVersion' => '1.1',
        'RequiresServer' => true,
        'ServiceSingleSignOnLabel' => false,
        'AdminSingleSignOnLabel' => false,
    );
}

function nexoradc_ConfigOptions()
{
    return array(
        'Verify TLS' => array('Type' => 'yesno', 'Default' => 'on', 'Description' => 'Verify the NexoraDC certificate (turn off only in a lab)'),
        'Show usage' => array('Type' => 'yesno', 'Default' => 'on', 'Description' => 'Show energy and 95th-percentile bandwidth in the client area'),
    );
}

/** @return NexoraClient */
function nexoradc_client(array $params)
{
    $scheme = !empty($params['serversecure']) ? 'https://' : 'http://';
    $host = isset($params['serverhostname']) && $params['serverhostname'] !== '' ? $params['serverhostname'] : (isset($params['serverip']) ? $params['serverip'] : '');
    // WHMCS stores a ticked yes/no option as 'on' and an unticked one as ''.
    $verify = !isset($params['configoption1']) || $params['configoption1'] === 'on';
    return new NexoraClient($scheme . $host, $params['serverusername'], $params['serverpassword'], $verify);
}

function nexoradc_serviceData(array $params, $reason = null)
{
    $data = array(
        'serviceId' => (string) $params['serviceid'],
        'clientId' => (string) $params['userid'],
        'productId' => (string) $params['pid'],
        'name' => trim((string) (isset($params['domain']) && $params['domain'] !== '' ? $params['domain'] : (isset($params['model']->product->name) ? $params['model']->product->name : ''))),
    );
    if ($data['name'] === '') {
        unset($data['name']);
    }
    if ($reason !== null && $reason !== '') {
        $data['reason'] = substr((string) $reason, 0, 500);
    }
    return $data;
}

function nexoradc_clientData(array $params)
{
    $c = isset($params['clientsdetails']) ? $params['clientsdetails'] : array();
    $name = trim((isset($c['companyname']) && $c['companyname'] !== '') ? $c['companyname'] : trim((isset($c['firstname']) ? $c['firstname'] : '') . ' ' . (isset($c['lastname']) ? $c['lastname'] : '')));
    return array(
        'clientId' => (string) $params['userid'],
        'name' => $name !== '' ? $name : ('WHMCS client ' . $params['userid']),
        'email' => isset($c['email']) ? $c['email'] : null,
        'status' => 'Active',
    );
}

/** Sends one event and turns the answer into a WHMCS module result. */
function nexoradc_send(array $params, $type, array $data, $action)
{
    try {
        $r = nexoradc_client($params)->sendEvent($type, $data);
        logModuleCall('nexoradc', $action, array('type' => $type, 'data' => $data), $r, $r, array());
        if (isset($r['status']) && $r['status'] === 'rejected') {
            return 'NexoraDC refused the change: ' . (isset($r['message']) ? $r['message'] : 'unknown reason');
        }
        // 'applied', 'ignored' (already in that state) and 'review' (held for staff) are all accepted.
        return 'success';
    } catch (ApiError $e) {
        logModuleCall('nexoradc', $action, array('type' => $type, 'data' => $data), $e->getMessage(), '', array());
        return $e->getMessage();
    }
}

function nexoradc_CreateAccount(array $params)
{
    // Make sure the customer exists first (matched by WHMCS client id).
    $r = nexoradc_send($params, 'client.upsert', nexoradc_clientData($params), 'CreateAccount:client');
    if ($r !== 'success') {
        return $r;
    }
    $r = nexoradc_send($params, 'service.created', nexoradc_serviceData($params), 'CreateAccount');
    if ($r !== 'success') {
        return $r;
    }
    return nexoradc_send($params, 'service.activated', nexoradc_serviceData($params), 'CreateAccount:activate');
}

function nexoradc_SuspendAccount(array $params)
{
    return nexoradc_send($params, 'service.suspended', nexoradc_serviceData($params, isset($params['suspendreason']) ? $params['suspendreason'] : null), 'SuspendAccount');
}

function nexoradc_UnsuspendAccount(array $params)
{
    return nexoradc_send($params, 'service.unsuspended', nexoradc_serviceData($params), 'UnsuspendAccount');
}

function nexoradc_TerminateAccount(array $params)
{
    return nexoradc_send($params, 'service.terminated', nexoradc_serviceData($params), 'TerminateAccount');
}

function nexoradc_TestConnection(array $params)
{
    try {
        // Proves the URL, integration id, secret and clock; nothing is changed.
        nexoradc_client($params)->ping();
        return array('success' => true, 'error' => '');
    } catch (ApiError $e) {
        return array('success' => false, 'error' => $e->getMessage());
    }
}

function nexoradc_AdminServicesTabFields(array $params)
{
    return array('NexoraDC' => 'Service records are kept in step automatically. Billing events never switch equipment off.');
}

/** Client area: this month's usage (measured and estimated energy apart, 95th-percentile bandwidth). */
function nexoradc_ClientArea(array $params)
{
    if (isset($params['configoption2']) && $params['configoption2'] !== 'on') {
        return '';
    }
    try {
        $from = gmdate('Y-m-01\T00:00:00\Z');
        $to = gmdate('Y-m-d\TH:i:s\Z');
        $u = nexoradc_client($params)->usage($params['serviceid'], $from, $to);
    } catch (ApiError $e) {
        return '<p class="text-muted">Usage is not available right now.</p>';
    }
    $e = $u['energy'];
    $b = $u['bandwidth'];
    $mbps = function ($v) {
        return $v === null ? '—' : number_format($v / 1e6, 2) . ' Mbit/s';
    };
    $h = function ($s) {
        return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
    };
    return '<div class="nexoradc-usage"><h4>Usage this month</h4><table class="table table-sm">'
        . '<tr><td>Energy (measured)</td><td>' . $h(number_format($e['measuredKwh'], 3)) . ' kWh</td></tr>'
        . '<tr><td>Energy (estimated, not metered)</td><td>' . $h(number_format($e['estimatedKwh'], 3)) . ' kWh</td></tr>'
        . '<tr><td>Bandwidth 95th percentile</td><td>' . $h($mbps($b['billableP95Bps'])) . '</td></tr>'
        . '<tr><td>Bandwidth sample coverage</td><td>' . $h($b['coverage'] === null ? '—' : $b['coverage'] . '%') . '</td></tr>'
        . '</table></div>';
}
