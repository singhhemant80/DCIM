<?php
/**
 * NexoraDC API client for the WHMCS module.
 *
 * Every call is signed with the integration's shared secret:
 *   X-NexoraDC-Timestamp: <unix seconds>
 *   X-NexoraDC-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 * NexoraDC rejects timestamps more than 5 minutes off, so keep the WHMCS
 * server's clock in sync (NTP).
 *
 * Events carry an id. NexoraDC applies each id once and answers a repeat with
 * {"duplicate": true}, so a call can be retried safely with the same id.
 */

namespace NexoraDC;

class ApiError extends \Exception
{
    /** @var int */
    public $status;

    public function __construct($message, $status = 0)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

class NexoraClient
{
    /** @var string */
    private $baseUrl;
    /** @var string */
    private $integrationId;
    /** @var string */
    private $secret;
    /** @var bool */
    private $verifyTls;
    /** @var int */
    private $timeout;

    public function __construct($baseUrl, $integrationId, $secret, $verifyTls = true, $timeout = 15)
    {
        $baseUrl = trim((string) $baseUrl);
        if ($baseUrl !== '' && !preg_match('#^https?://#i', $baseUrl)) {
            $baseUrl = 'https://' . $baseUrl;
        }
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->integrationId = trim((string) $integrationId);
        $this->secret = (string) $secret;
        $this->verifyTls = (bool) $verifyTls;
        $this->timeout = (int) $timeout;
    }

    /** HMAC-SHA256 signature header value for a timestamp and raw body. */
    public static function sign($secret, $timestamp, $rawBody)
    {
        return 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
    }

    /**
     * A new id for each change WHMCS makes. The client's own retries reuse it
     * (same body), so a call that timed out after NexoraDC applied it is not
     * applied twice; a separate change always gets a separate id.
     */
    public static function eventId()
    {
        return 'whmcs-' . bin2hex(random_bytes(16));
    }

    public function sendEvent($type, array $data, $id = null)
    {
        $event = array(
            'id' => $id !== null ? $id : self::eventId(),
            'type' => $type,
            'occurredAt' => gmdate('c'),
            'data' => $data,
        );
        return $this->post('events', $event, 3);
    }

    /** Signed connection test; changes nothing. */
    public function ping()
    {
        return $this->post('ping', array('ping' => true), 1);
    }

    public function reconcile(array $services)
    {
        return $this->post('reconcile', array('services' => $services), 1);
    }

    public function usage($billingReference, $fromIso, $toIso)
    {
        return $this->post('usage', array('billingReference' => (string) $billingReference, 'from' => $fromIso, 'to' => $toIso), 1);
    }

    /** Signed POST with retries on network errors and 5xx (same body and event id each time). */
    public function post($path, array $payload, $attempts = 3)
    {
        if ($this->baseUrl === '' || $this->integrationId === '' || $this->secret === '') {
            throw new ApiError('The NexoraDC server is not configured (URL, integration id and secret are required)');
        }
        $raw = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($raw === false) {
            throw new ApiError('Could not encode the request');
        }
        $url = $this->baseUrl . '/api/v1/billing/whmcs/' . rawurlencode($this->integrationId) . '/' . $path;
        $last = null;
        for ($i = 1; $i <= max(1, (int) $attempts); $i++) {
            $ts = (string) time();
            $ch = curl_init($url);
            curl_setopt_array($ch, array(
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $raw,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => $this->timeout,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_SSL_VERIFYPEER => $this->verifyTls,
                CURLOPT_SSL_VERIFYHOST => $this->verifyTls ? 2 : 0,
                CURLOPT_HTTPHEADER => array(
                    'Content-Type: application/json',
                    'User-Agent: NexoraDC-WHMCS/1.0',
                    'X-NexoraDC-Timestamp: ' . $ts,
                    'X-NexoraDC-Signature: ' . self::sign($this->secret, $ts, $raw),
                ),
            ));
            $body = curl_exec($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $err = curl_error($ch);
            curl_close($ch);
            if ($body === false) {
                $last = new ApiError('Could not reach NexoraDC: ' . $err);
            } else {
                $json = json_decode($body, true);
                if ($status >= 200 && $status < 300 && is_array($json)) {
                    return $json;
                }
                $msg = is_array($json) && isset($json['message']) ? $json['message'] : ('HTTP ' . $status);
                $last = new ApiError('NexoraDC: ' . $msg, $status);
                if ($status < 500) {
                    break; // 4xx: retrying the same request won't help.
                }
            }
            if ($i < $attempts) {
                usleep(500000 * $i);
            }
        }
        throw $last;
    }
}
