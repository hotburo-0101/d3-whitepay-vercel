const crypto = require("crypto")

function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(data))
}

// Signature = HMAC_SHA256(JSON.stringify(body).replace(/\//g, "\\/"), secret)
function calcSignature(body, secret) {
  const json = JSON.stringify(body).replace(/\//g, "\\/")
  return crypto.createHmac("sha256", secret).update(json).digest("hex")
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" })

  const WHITEPAY_WEBHOOK_SECRET = process.env.WHITEPAY_WEBHOOK_SECRET
  if (!WHITEPAY_WEBHOOK_SECRET) {
    return sendJson(res, 500, { error: "Missing env var WHITEPAY_WEBHOOK_SECRET" })
  }

  // Vercel зазвичай дає req.body як object
  let body = req.body
  if (!body || typeof body !== "object") {
    try {
      body = JSON.parse(req.body || "{}")
    } catch (e) {
      return sendJson(res, 400, { error: "Invalid JSON body" })
    }
  }

  const signature =
    req.headers["signature"] ||
    req.headers["Signature"] ||
    req.headers["SIGNATURE"] ||
    ""

  const expected = calcSignature(body, WHITEPAY_WEBHOOK_SECRET)

  if (!signature || String(signature) !== expected) {
    return sendJson(res, 401, { error: "Invalid signature" })
  }

  // Під різні webhook-пейлоади дістаємо order/status максимально безпечно
  const order = body.order || body.data?.order || body.crypto_order || body
  const status = String(order?.status || body.status || "").toUpperCase()
  const whitepay_order_id = String(order?.id || "")
  const external_order_id = String(order?.external_order_id || "")

  // SUCCESS CASE
  if (status === "COMPLETE") {
    // Тут далі: (1) зафіксувати оплату (2) додати в email-сервіс (3) відправити доступ
    // Поки повертаємо OK, щоб Whitepay не ретраїв webhook.
    return sendJson(res, 200, {
      ok: true,
      handled: "paid",
      status,
      whitepay_order_id,
      external_order_id,
    })
  }

  return sendJson(res, 200, {
    ok: true,
    handled: "ignored",
    status,
    whitepay_order_id,
    external_order_id,
  })
}
