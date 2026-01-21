const TARIFFS = {
  base: { title: "База", usd: 299, uah: 12999, glow: "white" },
  ground: { title: "Ґрунт", usd: 499, uah: 20999, glow: "green" },
  foundation: { title: "Фундамент", usd: 799, uah: 33999, glow: "yellow" },
}

// ✅ TEST MODE: whitepay = 1 USDT (для всіх тарифів)
const IS_TEST = process.env.PAYMENTS_TEST_MODE === "true"

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

function isValidEmail(v) {
  const s = String(v || "").trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(s)
}

function makeExternalOrderId(tariffId) {
  return `d3_${tariffId}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

async function airtableCreate(fields) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE

  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
    throw new Error(
      "Missing Airtable env vars (AIRTABLE_TOKEN / AIRTABLE_BASE_ID / AIRTABLE_TABLE)"
    )
  }

  const url = `https://api.airtable.com/v0/${encodeURIComponent(
    AIRTABLE_BASE_ID
  )}/${encodeURIComponent(AIRTABLE_TABLE)}`

  const r = await fetch(url, {
    method: "POST",
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

  if (!r.ok) {
    const msg =
      data?.error?.message ||
      data?.error ||
      `Airtable create failed (${r.status})`
    throw new Error(msg)
  }

  return data
}

module.exports = async (req, res) => {
  setCors(req, res)

  if (req.method === "OPTIONS") {
    res.statusCode = 204
    return res.end()
  }
  if (req.method !== "POST")
    return sendJson(res, 405, { error: "Method not allowed" })

  const WHITEPAY_API_TOKEN = process.env.WHITEPAY_API_TOKEN
  const WHITEPAY_SLUG = process.env.WHITEPAY_SLUG
  const SITE_URL = process.env.SITE_URL

  if (!WHITEPAY_API_TOKEN || !WHITEPAY_SLUG || !SITE_URL) {
    return sendJson(res, 500, {
      error: "Missing env vars",
      required: ["WHITEPAY_API_TOKEN", "WHITEPAY_SLUG", "SITE_URL"],
    })
  }

  // parse body
  let body = req.body
  if (!body || typeof body !== "object") {
    try {
      body = JSON.parse(req.body || "{}")
    } catch (e) {
      return sendJson(res, 400, { error: "Invalid JSON body" })
    }
  }

  const tariffId = safeString(body.tariffId ?? body.tariff_id ?? body.tariff, 32)
  const email = safeString(body.email, 255)
  const name = safeString(body.name, 255)
  const phone = safeString(body.phone, 64)

  const tariff = TARIFFS[tariffId]
  if (!tariff) return sendJson(res, 400, { error: "Invalid tariffId" })
  if (!email) return sendJson(res, 400, { error: "Email is required" })
  if (!isValidEmail(email))
    return sendJson(res, 400, { error: "Invalid email" })

  const external_order_id = makeExternalOrderId(tariffId)

  // ✅ ТЕСТ: 1 USDT, ПРОД: тариф.usd
  const amount = IS_TEST ? 1 : Number(tariff.usd)
  const tariffTitle = tariff.title

  const paymentDesc = `Оплата за тариф "${tariffTitle}"`

  // 1) Create WhitePay order
  const wpUrl = `https://api.whitepay.com/private-api/crypto-orders/${encodeURIComponent(
    WHITEPAY_SLUG
  )}`

  const successUrl = `${SITE_URL}/payment-success?tariff=${encodeURIComponent(
    tariffId
  )}&order=${encodeURIComponent(external_order_id)}&provider=whitepay`

  const failureUrl = `${SITE_URL}/payment-failed?tariff=${encodeURIComponent(
    tariffId
  )}&order=${encodeURIComponent(external_order_id)}&provider=whitepay`

  const wpPayload = {
    amount: String(amount),
    currency: "USDT",
    external_order_id,
    email,
    description: `${paymentDesc} — D3 Education`,
    successful_link: successUrl,
    failure_link: failureUrl,
    form_additional_data: paymentDesc,
  }

  let wpRes
  try {
    wpRes = await fetch(wpUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${WHITEPAY_API_TOKEN}`,
      },
      body: JSON.stringify(wpPayload),
    })
  } catch (e) {
    return sendJson(res, 502, {
      error: "Whitepay request failed",
      details: String(e),
    })
  }

  const wpText = await wpRes.text()
  let wpData
  try {
    wpData = JSON.parse(wpText)
  } catch (e) {
    wpData = { raw: wpText }
  }

  if (!wpRes.ok) {
    return sendJson(res, 502, {
      error: "Whitepay create order failed",
      status: wpRes.status,
      data: wpData,
    })
  }

  const acquiring_url = wpData?.order?.acquiring_url
  const whitepay_order_id = wpData?.order?.id
  const status = wpData?.order?.status

  if (!acquiring_url || !whitepay_order_id) {
    return sendJson(res, 502, {
      error: "Whitepay response missing acquiring_url/id",
      data: wpData,
    })
  }

  // 2) Create Airtable record (PENDING)
  try {
    const fields = {
      customer_name: name || "",
      email: email,
      phone: phone || "",
      provider: "whitepay",

      "External Order ID": external_order_id,
      "Whitepay Order ID": String(whitepay_order_id),

      "Tariff ID": tariffId,
      "Tariff Title": tariffTitle,

      "Amount USDT": Number(amount),
      currency: "USDT",

      status: "PENDING",
      "Acquiring URL": String(acquiring_url),

      created_at: new Date().toISOString(),
    }

    const at = await airtableCreate(fields)

    return sendJson(res, 200, {
      ok: true,
      provider: "whitepay",
      tariffId,
      amount_usdt: amount,
      external_order_id,
      whitepay_order_id,
      status,
      acquiring_url,
      airtable_record_id: at?.id || null,
      success_url: successUrl,
      fail_url: failureUrl,
      test_mode: IS_TEST,
    })
  } catch (e) {
    // оплату не блокуємо
    return sendJson(res, 200, {
      ok: true,
      provider: "whitepay",
      tariffId,
      amount_usdt: amount,
      external_order_id,
      whitepay_order_id,
      status,
      acquiring_url,
      airtable_error: String(e?.message || e),
      test_mode: IS_TEST,
    })
  }
}
