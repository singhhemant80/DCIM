<?php
/**
 * Offline checks for the NexoraDC WHMCS client: run with `php tests/client_test.php`.
 * The signature vector is the one the API's tests use, so both sides agree.
 */
require __DIR__ . '/../modules/servers/nexoradc/lib/NexoraClient.php';

use NexoraDC\NexoraClient;

$fail = 0;
function check($name, $ok)
{
    global $fail;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $fail++;
    }
}

check('signature matches the API (HMAC-SHA256 over "<timestamp>.<body>")', NexoraClient::sign('k', '1700000000', '{"a":1}') === 'sha256=1b6ad1bc9bf48c52ce01939866d5877c6cc4e87ddad27e16673cb8c4964394a3');
$a = NexoraClient::eventId();
$b = NexoraClient::eventId();
check('event ids are unique per change', $a !== $b);
check('event ids fit the API limit (120 chars)', strlen($a) <= 120 && preg_match('/^whmcs-[0-9a-f]{32}$/', $a) === 1);
try {
    (new NexoraClient('', '', ''))->ping();
    check('unconfigured client refuses to send', false);
} catch (NexoraDC\ApiError $e) {
    check('unconfigured client refuses to send', strpos($e->getMessage(), 'not configured') !== false);
}
exit($fail ? 1 : 0);
