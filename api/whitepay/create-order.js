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

/** Airtable helpers */
function getAirtableConfig() {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE

  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
    return null
  }
  return { AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE }
}

async function airtableCreateOrderRecord(fields) {
  const cfg = getAirtableConfig()
  if (!cfg) return { ok: false, skipped: true, reason: "Missing Airtable env vars" }

  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE } = cfg
  const endpoint = `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(
    AIRTABLE_TABLE
  )}`

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records: [{ fields }] }),
  })

  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    data = { raw: text }
  }

  if (!r.ok) {
    return { ok: false, status: r.status, data }
  }

  const recordId = data?.records?.[0]?.id
  return { ok: true, recordId, data }
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

  if (!WHITEPAY_API_TOKEN || !WHITEPAY_SLUG || !SITE_URL) {
    return sendJson(res, 500, {
      error: "Missing env vars",
      required: ["WHITEPAY_API_TOKEN", "WHITEPAY_SLUG", "SITE_URL"],
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

  if (!TARIFFS[tariffId]) return sendJson(res, 400, { error: "Invalid tariffId" })
  if (!email) return sendJson(res, 400, { error: "Email is required" })

  const external_order_id = makeExternalOrderId(tariffId)
  const amount = TARIFFS[tariffId].usd
  const tariffTitle = TARIFFS[tariffId].title

  const url = `https://api.whitepay.com/private-api/crypto-orders/${encodeURIComponent(WHITEPAY_SLUG)}`

  const paymentDesc = `Оплата за тариф "${tariffTitle}"`
  const payload = {
    amount: String(amount),
    currency: "USDT",
    external_order_id,
    email,
    description: `${paymentDesc} — D3 Education`,
    successful_link: `${SITE_URL}/payment-success?tariff=${encodeURIComponent(tariffId)}&order=${encodeURIComponent(
      external_order_id
    )}`,
    failure_link: `${SITE_URL}/payment-failed?tariff=${encodeURIComponent(tariffId)}&order=${encodeURIComponent(
      external_order_id
    )}`,
    // у тебе саме воно підтягується як "Опис платежу"
    form_additional_data: paymentDesc,
  }

  let r
  try {
    r = await fetch(url, {
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
  const status = data?.order?.status

  if (!acquiring_url || !whitepay_order_id) {
    return sendJson(res, 502, { error: "Whitepay response missing acquiring_url/id", data })
  }

  // ✅ пишемо pending в Airtable
  const nowIso = new Date().toISOString()
  const airtableRes = await airtableCreateOrderRecord({
    "External Order ID": external_order_id,
    "Whitepay Order ID": String(whitepay_order_id),
    Email: email,
    Name: name || "",
    "Tariff ID": tariffId,
    "Tariff Title": tariffTitle,
    "Amount USDT": Number(amount),
    Currency: "USDT",
    Status: "pending",
    "Acquiring URL": acquiring_url,
    "Created At": nowIso,
  })

  return sendJson(res, 200, {
    ok: true,
    tariffId,
    tariffTitle,
    amount_usdt: amount,
    external_order_id,
    whitepay_order_id,
    status,
    acquiring_url,
    airtable: airtableRes,
  })
}
