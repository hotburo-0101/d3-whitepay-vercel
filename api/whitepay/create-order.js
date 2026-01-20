const TARIFFS = {
  base: { title: "База", usd: 299, uah: 12999, glow: "white" },
  ground: { title: "Ґрунт", usd: 499, uah: 20999, glow: "green" },
  foundation: { title: "Фундамент", usd: 799, uah: 33999, glow: "yellow" },
}

function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(data))
}

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  res.setHeader("Access-Control-Max-Age", "86400")
}

function safeString(v, max = 255) {
  const s = String(v ?? "").trim()
  return s.length > max ? s.slice(0, max) : s
}

function makeExternalOrderId(tariffId) {
  return `d3_${tariffId}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

async function airtableCreateRecord({ baseId, tableName, token, fields }) {
  const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  })
  const data = await r.json().catch(() => null)
  if (!r.ok) {
    const err = new Error("Airtable create failed")
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

  const WHITEPAY_API_TOKEN = process.env.WHITEPAY_API_TOKEN
  const WHITEPAY_SLUG = process.env.WHITEPAY_SLUG
  const SITE_URL = process.env.SITE_URL

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE

  if (!WHITEPAY_API_TOKEN || !WHITEPAY_SLUG || !SITE_URL) {
    return sendJson(res, 500, {
      error: "Missing env vars",
      required: ["WHITEPAY_API_TOKEN", "WHITEPAY_SLUG", "SITE_URL"],
    })
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

  const tariffId = safeString(body.tariffId, 32)
  const email = safeString(body.email, 255)
  const name = safeString(body.name, 255)
  const phone = safeString(body.phone, 64)

  if (!TARIFFS[tariffId]) return sendJson(res, 400, { error: "Invalid tariffId" })
  if (!email) return sendJson(res, 400, { error: "Email is required" })

  const external_order_id = makeExternalOrderId(tariffId)
  const amount = TARIFFS[tariffId].usd
  const tariffTitle = TARIFFS[tariffId].title

  const paymentDesc = `Оплата за тариф "${tariffTitle}"`

  const whitepayUrl = `https://api.whitepay.com/private-api/crypto-orders/${encodeURIComponent(WHITEPAY_SLUG)}`
  const payload = {
    amount: String(amount),
    currency: "USDT",
    external_order_id,
    email,
    description: `${paymentDesc} — D3 Education`,
    successful_link: `${SITE_URL}/payment-success?tariff=${encodeURIComponent(tariffId)}&order=${encodeURIComponent(external_order_id)}`,
    failure_link: `${SITE_URL}/payment-failed?tariff=${encodeURIComponent(tariffId)}&order=${encodeURIComponent(external_order_id)}`,
    form_additional_data: paymentDesc,
  }

  let r
  try {
    r = await fetch(whitepayUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${WHITEPAY_API_TOKEN}`,
      },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    return sendJson(res, 502, { error: "Whitepay request failed", details: String(e) })
  }

  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    data = { raw: text }
  }

  if (!r.ok) {
    return sendJson(res, 502, { error: "Whitepay create order failed", status: r.status, data })
  }

  const acquiring_url = data?.order?.acquiring_url
  const whitepay_order_id = data?.order?.id
  const status = String(data?.order?.status || "").toUpperCase()

  if (!acquiring_url || !whitepay_order_id) {
    return sendJson(res, 502, { error: "Whitepay response missing acquiring_url/id", data })
  }

  // ✅ Пишемо PENDING у Airtable
  let airtableRecordId = null
  try {
    const created = await airtableCreateRecord({
      baseId: AIRTABLE_BASE_ID,
      tableName: AIRTABLE_TABLE,
      token: AIRTABLE_TOKEN,
      fields: {
        Name: name || "",
        email,
        provider: "WHITEPAY",
        phone: phone || "",
        "External Order ID": external_order_id,
        "Whitepay Order ID": String(whitepay_order_id),
        "Tariff ID": tariffId,
        "Tariff Title": tariffTitle,
        "Amount USDT": Number(amount),
        currency: "USDT",
        status: "PENDING",
        "Acquiring URL": acquiring_url,
        created_at: new Date().toISOString(),
      },
    })
    airtableRecordId = created?.id || null
  } catch (e) {
    // Не валимо оплату, але вертаємо помилку Airtable щоб ти бачив її одразу
    return sendJson(res, 200, {
      ok: true,
      warning: "Order created in Whitepay, but Airtable write failed",
      airtable_error: String(e?.message || e),
      airtable_details: e?.details || null,

      tariffId,
      amount_usdt: amount,
      external_order_id,
      whitepay_order_id,
      status,
      acquiring_url,
    })
  }

  return sendJson(res, 200, {
    ok: true,
    airtableRecordId,
    tariffId,
    amount_usdt: amount,
    external_order_id,
    whitepay_order_id,
    status,
    acquiring_url,
  })
}
