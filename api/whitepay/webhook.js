const crypto = require("crypto")

function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(data))
}

function setCors(req, res) {
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

function mapWhitepayStatusToCrm(statusUpper) {
  // Підлаштовано під CRM-статуси
  if (statusUpper === "COMPLETE" || statusUpper === "PAID") return "PAID"
  if (statusUpper === "FAILED" || statusUpper === "CANCELED" || statusUpper === "CANCELLED" || statusUpper === "EXPIRED")
    return "FAILED"
  return "PENDING"
}

async function airtableFindByExternalOrderId({ baseId, tableName, token, externalOrderId }) {
  const formula = `{External Order ID}="${String(externalOrderId).replace(/"/g, '\\"')}"`
  const url =
    `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}` +
    `?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`

  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await r.json().catch(() => null)
  if (!r.ok) {
    const err = new Error("Airtable find failed")
    err.details = data
    err.status = r.status
    throw err
  }
  return data?.records?.[0] || null
}

async function airtableFindByWhitepayOrderId({ baseId, tableName, token, whitepayOrderId }) {
  const formula = `{Whitepay Order ID}="${String(whitepayOrderId).replace(/"/g, '\\"')}"`
  const url =
    `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}` +
    `?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`

  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await r.json().catch(() => null)
  if (!r.ok) {
    const err = new Error("Airtable find failed")
    err.details = data
    err.status = r.status
    throw err
  }
  return data?.records?.[0] || null
}

async function airtableUpdateRecord({ baseId, tableName, token, recordId, fields }) {
  const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}/${encodeURIComponent(recordId)}`
  const r = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  })
  const data = await r.json().catch(() => null)
  if (!r.ok) {
    const err = new Error("Airtable update failed")
    err.details = data
    err.status = r.status
    throw err
  }
  return data
}

module.exports = async (req, res) => {
  setCors(req, res)

  if (req.method === "OPTIONS") {
    res.statusCode = 204
    return res.end()
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" })

  const WHITEPAY_WEBHOOK_SECRET = process.env.WHITEPAY_WEBHOOK_SECRET
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE

  if (!WHITEPAY_WEBHOOK_SECRET) {
    return sendJson(res, 500, { error: "Missing env var WHITEPAY_WEBHOOK_SECRET" })
  }
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
    return sendJson(res, 500, {
      error: "Missing Airtable env vars",
      required: ["AIRTABLE_TOKEN", "AIRTABLE_BASE_ID", "AIRTABLE_TABLE"],
    })
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

  const order = body.order || body.data?.order || body.crypto_order || body
  const statusUpper = String(order?.status || body.status || "").toUpperCase()

  const whitepay_order_id = String(order?.id || "")
  const external_order_id = String(order?.external_order_id || "")

  const crmStatus = mapWhitepayStatusToCrm(statusUpper)

  // ✅ Знайдемо запис у Airtable і оновимо статус
  try {
    let rec = null

    if (external_order_id) {
      rec = await airtableFindByExternalOrderId({
        baseId: AIRTABLE_BASE_ID,
        tableName: AIRTABLE_TABLE,
        token: AIRTABLE_TOKEN,
        externalOrderId: external_order_id,
      })
    }

    if (!rec && whitepay_order_id) {
      rec = await airtableFindByWhitepayOrderId({
        baseId: AIRTABLE_BASE_ID,
        tableName: AIRTABLE_TABLE,
        token: AIRTABLE_TOKEN,
        whitepayOrderId: whitepay_order_id,
      })
    }

    if (!rec) {
      // Не валимо webhook — Whitepay не має ретраїти нескінченно
      return sendJson(res, 200, {
        ok: true,
        handled: "no_record",
        status: statusUpper,
        crmStatus,
        whitepay_order_id,
        external_order_id,
      })
    }

    await airtableUpdateRecord({
      baseId: AIRTABLE_BASE_ID,
      tableName: AIRTABLE_TABLE,
      token: AIRTABLE_TOKEN,
      recordId: rec.id,
      fields: {
        status: crmStatus,
        "Whitepay Order ID": whitepay_order_id || rec.fields?.["Whitepay Order ID"] || "",
        "External Order ID": external_order_id || rec.fields?.["External Order ID"] || "",
      },
    })

    return sendJson(res, 200, {
      ok: true,
      handled: "updated",
      status: statusUpper,
      crmStatus,
      recordId: rec.id,
      whitepay_order_id,
      external_order_id,
    })
  } catch (e) {
    return sendJson(res, 200, {
      ok: true,
      handled: "airtable_error",
      status: statusUpper,
      crmStatus,
      whitepay_order_id,
      external_order_id,
      airtable_error: String(e?.message || e),
      airtable_details: e?.details || null,
    })
  }
}
