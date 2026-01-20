const crypto = require("crypto")

function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(data))
}

function setCors(req, res) {
  // webhooks приходять з серверів, CORS не критичний, але хай буде ок
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Signature")
  res.setHeader("Access-Control-Max-Age", "86400")
}

// Signature = HMAC_SHA256(JSON.stringify(body).replace(/\//g, "\\/"), secret)
function calcSignature(body, secret) {
  const json = JSON.stringify(body).replace(/\//g, "\\/")
  return crypto.createHmac("sha256", secret).update(json).digest("hex")
}

/** Airtable helpers */
function getAirtableConfig() {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) return null
  return { AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE }
}

async function airtableFindRecordIdByExternalOrderId(externalOrderId) {
  const cfg = getAirtableConfig()
  if (!cfg) return { ok: false, skipped: true, reason: "Missing Airtable env vars" }

  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE } = cfg
  const endpoint = `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(
    AIRTABLE_TABLE
  )}?filterByFormula=${encodeURIComponent(`{External Order ID}='${externalOrderId}'`)}&maxRecords=1`

  const r = await fetch(endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  })

  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    data = { raw: text }
  }

  if (!r.ok) return { ok: false, status: r.status, data }

  const recordId = data?.records?.[0]?.id
  if (!recordId) return { ok: false, notFound: true, data }

  return { ok: true, recordId }
}

async function airtableUpdateRecord(recordId, fields) {
  const cfg = getAirtableConfig()
  if (!cfg) return { ok: false, skipped: true, reason: "Missing Airtable env vars" }

  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE } = cfg
  const endpoint = `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(
    AIRTABLE_TABLE
  )}/${encodeURIComponent(recordId)}`

  const r = await fetch(endpoint, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  })

  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    data = { raw: text }
  }

  if (!r.ok) return { ok: false, status: r.status, data }
  return { ok: true, data }
}

// нормалізація статусів Whitepay -> наші
function mapStatusToCrm(statusUpper) {
  // найважливіше: COMPLETE = paid
  if (statusUpper === "COMPLETE") return "paid"
  if (statusUpper === "FAILED") return "failed"
  if (statusUpper === "EXPIRED") return "expired"
  // інші: PENDING/PROCESSING тощо
  return "pending"
}

module.exports = async (req, res) => {
  setCors(req, res)

  if (req.method === "OPTIONS") {
    res.statusCode = 204
    return res.end()
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" })

  const WHITEPAY_WEBHOOK_SECRET = process.env.WHITEPAY_WEBHOOK_SECRET
  if (!WHITEPAY_WEBHOOK_SECRET) {
    return sendJson(res, 500, { error: "Missing env var WHITEPAY_WEBHOOK_SECRET" })
  }

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
  const statusUpper = String(order?.status || body.status || "").toUpperCase()
  const whitepay_order_id = String(order?.id || "")
  const external_order_id = String(order?.external_order_id || "")

  if (!external_order_id) {
    // якщо нема external_order_id — нам нема чим матчити в Airtable
    return sendJson(res, 200, {
      ok: true,
      handled: "ignored",
      reason: "missing external_order_id",
      status: statusUpper,
      whitepay_order_id,
    })
  }

  const crmStatus = mapStatusToCrm(statusUpper)
  const nowIso = new Date().toISOString()

  // ✅ знайти запис по External Order ID
  const findRes = await airtableFindRecordIdByExternalOrderId(external_order_id)

  if (!findRes.ok) {
    // не валимо webhook — повертаємо 200 щоб Whitepay не ретраїв нескінченно
    return sendJson(res, 200, {
      ok: true,
      handled: "airtable_lookup_failed",
      status: statusUpper,
      crmStatus,
      whitepay_order_id,
      external_order_id,
      airtable: findRes,
    })
  }

  // ✅ апдейт запису
  const fieldsToUpdate = {
    Status: crmStatus,
    "Whitepay Order ID": whitepay_order_id || "",
    "Webhook Payload": JSON.stringify(body),
  }

  if (crmStatus === "paid") {
    fieldsToUpdate["Paid At"] = nowIso
  }

  const updRes = await airtableUpdateRecord(findRes.recordId, fieldsToUpdate)

  return sendJson(res, 200, {
    ok: true,
    handled: crmStatus === "paid" ? "paid" : "updated",
    status: statusUpper,
    crmStatus,
    whitepay_order_id,
    external_order_id,
    airtable: updRes,
  })
}
