# IndigoPay Webhook Receiver Guide

IndigoPay sends signed HTTP POSTs to project-configured URLs whenever
a milestone is reached. The body, headers, retry policy, and
verification flow are designed to be easy to consume in any language.

## Delivery Headers

| Header | Description |
|--------|-------------|
| `X-Webhook-Id`        | Stable event id (sha256 of canonical milestone fields). Use for **idempotent dedup**. |
| `X-Webhook-Event-Type`| Currently always `milestone.reached`. |
| `X-Webhook-Delivery-Id` | Internal `webhook_deliveries` row uuid. |
| `X-Webhook-Timestamp` | Unix seconds at sign time. |
| `X-Webhook-Signature` | `t=<unix>,v1=<hex hmac-sha256(secret, "<ts>.<body>")>` |
| `X-Webhook-Attempt`   | 1-based attempt counter. |
| `User-Agent`          | `IndigoPay-Webhook/1.0` |
| `Content-Type`        | `application/json` |

## Body

```json
{
  "id": "8e1b…",                       // mirrors X-Webhook-Id
  "type": "milestone.reached",
  "event": "milestone.reached",
  "projectId": "f0c9…",
  "milestoneId": "0d3a…",
  "milestone": "First canopy planted",
  "percentage": 25,
  "totalRaisedXLM": "1234.5000000",
  "timestamp": "2026-07-09T10:30:00.000Z"
}
```

The raw body **must** be used verbatim for signature verification. If
your framework re-serializes the JSON, sign the bytes you actually
received, not the parsed object.

## Signature Verification

```js
const crypto = require("crypto");

function verify(body, secret, header) {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k.trim(), v.trim()];
    })
  );
  const t = Number.parseInt(parts.t, 10);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: "malformed" };

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${body}`)
    .digest();
  const got = Buffer.from(v1, "hex");
  if (got.length !== expected.length) return { ok: false, reason: "length" };
  if (!crypto.timingSafeEqual(got, expected)) return { ok: false, reason: "mismatch" };

  // Replay window: reject events whose timestamp is more than 5 minutes
  // away from local clock.
  const skew = Math.abs(Math.floor(Date.now() / 1000) - t);
  if (skew > 5 * 60) return { ok: false, reason: "stale" };

  return { ok: true };
}
```

## Retry Policy

IndigoPay retries on any non-2xx response or network failure with the
following backoff: 30s → 2m → 10m → 30m → 2h → 6h (six attempts).
After the final failure the event is moved to `webhook_dlq` and the
project owner is expected to inspect it via the admin audit log.

## Idempotency

Use `X-Webhook-Id` as a **stable dedup key**. IndigoPay will never
deliver two different bodies with the same id. Persist it alongside
the processing result so retries are safe.

## Replay Defense

- Reject events whose `X-Webhook-Timestamp` is more than **5 minutes**
  away from your local clock.
- Persist `X-Webhook-Id` for at least the project's retry window
  (~6 hours) to absorb a slow receiver that eventually catches up.

## Sample Receivers

### Node (Express)

```js
app.post("/indigopay/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const result = verify(req.body, process.env.WEBHOOK_SECRET, req.get("X-Webhook-Signature"));
  if (!result.ok) return res.status(401).json({ error: result.reason });
  const event = JSON.parse(req.body.toString("utf8"));
  // process event.id idempotently
  res.status(204).end();
});
```

### Go (net/http)

```go
func verify(secret, body, header string) (bool, string) {
  parts := strings.SplitN(header, ",", 2)
  if len(parts) != 2 { return false, "malformed" }
  ts, v1 := strings.TrimPrefix(parts[0], "t="), strings.TrimPrefix(parts[1], "v1=")
  mac := hmac.New(sha256.New, []byte(secret))
  mac.Write([]byte(ts + "." + body))
  expected := hex.EncodeToString(mac.Sum(nil))
  if !hmac.Equal([]byte(expected), []byte(v1)) { return false, "mismatch" }
  if math.Abs(float64(time.Now().Unix() - parseTs(ts))) > 300 {
    return false, "stale"
  }
  return true, ""
}
```

### Python (Flask)

```python
import hmac, hashlib, time
from flask import request, abort

def verify(secret: str, body: bytes, header: str) -> bool:
    t, _, v1 = header.partition(",")
    if not t.startswith("t=") or not v1.startswith("v1="):
        return False
    ts = int(t[2:]); sig = v1[3:]
    mac = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, sig): return False
    if abs(int(time.time()) - ts) > 300: return False
    return True

@app.post("/indigopay/webhook")
def webhook():
    if not verify(SECRET, request.get_data(), request.headers["X-Webhook-Signature"]):
        abort(401)
    # process request.get_json() idempotently using request.headers["X-Webhook-Id"]
    return "", 204
```

## Rotating the Secret

The signing secret is stored per project in `projects.webhook_secret`.
Update it from the admin console (or via a direct SQL update if you
provisioned it manually). IndigoPay will use the new value on the
**next** signed delivery — there is no overlap window, so coordinate
the cutover with your receiver's first successful verification.
