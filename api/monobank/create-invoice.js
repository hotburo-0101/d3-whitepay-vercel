const crypto = require("crypto")

const TARIFFS = {
  base: { title: "База", usd: 299, uah: 12999, icon: "https://framerusercontent.com/images/HSaFjfNthR65bMjzLtrVHtskgE.png" },
  ground: { title: "Ґрунт", usd: 499, uah: 20999, icon: "https://framerusercontent.com/images/lU1NmBLgPCHrBUlG0P90JHH5sNs.png" },
  foundation: { title: "Фундамент", usd: 799, uah: 33999, icon: "https://framerusercontent.com/images/kwJutTe19dT4guedyUWDqQKIHzA.png" },
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

function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body
  try {
    return JSON.parse(req.body || "{}")
  } catch {
    return null
  }
}

function makeExternalOrderId(tariffId) {
  return `d3_${tariffId}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function isTestMode() {
  return String(process.env.TEST_MODE || "").trim() === "1"
}

function getPriceUah(tariffId) {
  if (isTestMode()) {
    const v = Number(process.env.TEST_PRICE_UAH || 10)
    return Number.isFinite(v) && v > 0 ? v : 10
  }
  return Number(TARIFFS[tariffId].uah)
}

async function airtableCreate(fields) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE

  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
    throw new Error("Missing Airtable env vars (AIRTABLE_TOKEN / AIRTABLE_BASE_ID / AIRTABLE_TABLE)")
  }

  const url = `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(AIRTABLE_TABLE)}`

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  })

  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`Airtable create failed (${r.status}): ${JSON.stringify(data)}`)
  return data
}

async function airtablePatch(recordId, fields) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE

  const url = `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(AIRTABLE_TABLE)}/${encodeURIComponent(recordId)}`

  const r = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  })

  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`Airtable patch failed (${r.status}): ${JSON.stringify(data)}`)
  return data
}

module.exports = async (req, res) => {
  setCors(req, res)

  if (req.method === "OPTIONS") return res.end()
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" })

  const MONO_TOKEN = process.env.MONO_TOKEN
  const SITE_URL = process.env.SITE_URL
  const BACKEND_URL = process.env.BACKEND_URL

  if (!MONO_TOKEN || !SITE_URL || !BACKEND_URL) {
    return sendJson(res, 500, { error: "Missing env vars", required: ["MONO_TOKEN", "SITE_URL", "BACKEND_URL"] })
  }

  const body = parseBody(req)
  if (!body) return sendJson(res, 400, { error: "Invalid JSON body" })

  const tariffId = safeString(body.tariffId ?? body.tariff_id ?? body.tariff, 32)
  const email = safeString(body.email, 255)
  const name = safeString(body.name, 255)
  const phone = safeString(body.phone, 64)

  if (!TARIFFS[tariffId]) return sendJson(res, 400, { error: "Invalid tariffId" })
  if (!email) return sendJson(res, 400, { error: "Email is required" })

  const external_order_id = makeExternalOrderId(tariffId)
  const amountUah = getPriceUah(tariffId)
  const amountKop = Math.round(amountUah * 100)
  const tariffTitle = TARIFFS[tariffId].title

  // ✅ 1) Airtable завжди створюємо ПЕРШЕ
  let airtableRecordId = null
  try {
    const at = await airtableCreate({
      customer_name: name || "",
      email,
      phone: phone || "",
      provider: "monobank",

      "External Order ID": external_order_id,
      "Whitepay Order ID": "",

      "Tariff ID": tariffId,
      "Tariff Title": tariffTitle,

      "Amount USDT": Number(amountUah),
      currency: "UAH",

      status: "PENDING",
      "Acquiring URL": "",
      created_at: new Date().toISOString(),
    })
    airtableRecordId = at?.id || null
  } catch (e) {
    // навіть якщо Airtable впав — повертаємо помилку, бо це критично для тебе
    return sendJson(res, 500, { error: "Airtable create failed", details: String(e) })
  }

  const successUrl = `${SITE_URL}/payment-success?tariff=${encodeURIComponent(tariffId)}&order=${encodeURIComponent(external_order_id)}&provider=mono`
  const failUrl = `${SITE_URL}/payment-failed?tariff=${encodeURIComponent(tariffId)}&order=${encodeURIComponent(external_order_id)}&provider=mono`

  const payload = {
    amount: amountKop,
    ccy: 980,
    merchantPaymInfo: {
      reference: external_order_id,
      destination: `Оплата за тариф "${tariffTitle}" — D3 Education`,
      comment: `Оплата за тариф "${tariffTitle}" — D3 Education`,
      customerEmails: [email],
      basketOrder: [
        {
          name: `D3 Education — ${tariffTitle}`,
          qty: 1,
          sum: amountKop,
          total: amountKop,
          unit: "шт.",
          code: external_order_id,
        },
      ],
    },
    redirectUrl: successUrl,
    webHookUrl: `${BACKEND_URL.replace(/\/+$/, "")}/api/monobank/webhook`,
  }

  // 2) створюємо інвойс в Mono
  let monoRes, monoData
  try {
    monoRes = await fetch("https://api.monobank.ua/api/merchant/invoice/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": MONO_TOKEN },
      body: JSON.stringify(payload),
    })
    monoData = await monoRes.json().catch(() => null)
  } catch (e) {
    await airtablePatch(airtableRecordId, { status: "FAILED" })
    return sendJson(res, 502, { error: "Monobank request failed", details: String(e), airtable_record_id: airtableRecordId })
  }

  if (!monoRes.ok) {
    await airtablePatch(airtableRecordId, { status: "FAILED" })
    return sendJson(res, 502, { error: "Monobank create invoice failed", status: monoRes.status, data: monoData, airtable_record_id: airtableRecordId })
  }

  const invoiceId = monoData?.invoiceId
  const pageUrl = monoData?.pageUrl

  if (!invoiceId || !pageUrl) {
    await airtablePatch(airtableRecordId, { status: "FAILED" })
    return sendJson(res, 502, { error: "Monobank response missing invoiceId/pageUrl", data: monoData, airtable_record_id: airtableRecordId })
  }

  // ✅ 3) патчимо Airtable даними провайдера
  await airtablePatch(airtableRecordId, {
    "Whitepay Order ID": String(invoiceId),
    "Acquiring URL": String(pageUrl),
  })

  return sendJson(res, 200, {
    ok: true,
    provider: "monobank",
    test_mode: isTestMode(),
    tariffId,
    amount_uah: amountUah,
    external_order_id,
    invoiceId,
    acquiring_url: pageUrl,
    airtable_record_id: airtableRecordId,
    success_url: successUrl,
    fail_url: failUrl,
  })
}
