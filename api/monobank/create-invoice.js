const crypto = require("crypto")

const TARIFFS = {
  base: {
    title: "База",
    usd: 299,
    uah: 12999,
    icon: "https://framerusercontent.com/images/HSaFjfNthR65bMjzLtrVHtskgE.png",
  },
  ground: {
    title: "Ґрунт",
    usd: 499,
    uah: 20999,
    icon: "https://framerusercontent.com/images/lU1NmBLgPCHrBUlG0P90JHH5sNs.png",
  },
  foundation: {
    title: "Фундамент",
    usd: 799,
    uah: 33999,
    icon: "https://framerusercontent.com/images/kwJutTe19dT4guedyUWDqQKIHzA.png",
  },
}

// ✅ TEST MODE: mono = 10 грн (для всіх тарифів)
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

  const MONO_TOKEN = process.env.MONO_TOKEN
  const SITE_URL = process.env.SITE_URL
  const BACKEND_URL = process.env.BACKEND_URL // домен цього vercel бекенда

  if (!MONO_TOKEN || !SITE_URL || !BACKEND_URL) {
    return sendJson(res, 500, {
      error: "Missing env vars",
      required: ["MONO_TOKEN", "SITE_URL", "BACKEND_URL"],
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

  // ✅ ТЕСТ: 10 грн, ПРОД: тариф.uah
  const amountUah = IS_TEST ? 10 : Number(tariff.uah) // грн
  const amountKop = Math.round(amountUah * 100) // копійки
  const tariffTitle = tariff.title

  const successUrl = `${SITE_URL}/payment-success?tariff=${encodeURIComponent(
    tariffId
  )}&order=${encodeURIComponent(external_order_id)}&provider=mono`

  const failUrl = `${SITE_URL}/payment-failed?tariff=${encodeURIComponent(
    tariffId
  )}&order=${encodeURIComponent(external_order_id)}&provider=mono`

  const payload = {
    amount: amountKop,
    ccy: 980, // UAH
    merchantPaymInfo: {
      reference: external_order_id, // webhook шукає по цьому
      destination: `Оплата за тариф "${tariffTitle}" — D3 Education`,
      comment: `Оплата за тариф "${tariffTitle}" — D3 Education`,
      customerEmails: email ? [email] : [],
      basketOrder: [
        {
          name: `D3 Education — ${tariffTitle}`,
          qty: 1,
          sum: amountKop,
          total: amountKop,
          unit: "шт.",
          code: external_order_id,
          icon: tariff.icon, // ✅ картинка для різних тарифів (mono її показує в cart items)
        },
      ],
    },
    redirectUrl: successUrl,
    webHookUrl: `${BACKEND_URL.replace(/\/+$/, "")}/api/monobank/webhook`,
  }

  let monoRes
  try {
    monoRes = await fetch("https://api.monobank.ua/api/merchant/invoice/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Token": MONO_TOKEN,
      },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    return sendJson(res, 502, {
      error: "Monobank request failed",
      details: String(e),
    })
  }

  const monoText = await monoRes.text()
  let monoData
  try {
    monoData = JSON.parse(monoText)
  } catch (e) {
    monoData = { raw: monoText }
  }

  if (!monoRes.ok) {
    return sendJson(res, 502, {
      error: "Monobank create invoice failed",
      status: monoRes.status,
      data: monoData,
    })
  }

  const invoiceId = monoData?.invoiceId
  const pageUrl = monoData?.pageUrl

  if (!invoiceId || !pageUrl) {
    return sendJson(res, 502, {
      error: "Monobank response missing invoiceId/pageUrl",
      data: monoData,
    })
  }

  // 2) Create Airtable record (PENDING)
  try {
    const fields = {
      customer_name: name || "",
      email: email,
      phone: phone || "",
      provider: "monobank",

      "External Order ID": external_order_id,
      // ✅ лишаємо як є (у тебе поле так назване). Пишемо туди mono invoiceId.
      "Whitepay Order ID": String(invoiceId),

      "Tariff ID": tariffId,
      "Tariff Title": tariffTitle,

      // ✅ у тебе в таблиці є "Amount USDT" + currency
      // щоб не ламати схему — пишемо суму в amount, а currency="UAH"
      "Amount USDT": Number(amountUah),
      currency: "UAH",

      status: "PENDING",
      "Acquiring URL": String(pageUrl),
      created_at: new Date().toISOString(),
    }

    const at = await airtableCreate(fields)

    return sendJson(res, 200, {
      ok: true,
      provider: "monobank",
      tariffId,
      amount_uah: amountUah,
      external_order_id,
      invoiceId,
      acquiring_url: pageUrl, // ✅ уніфікований ключ під фронт
      airtable_record_id: at?.id || null,
      success_url: successUrl,
      fail_url: failUrl,
      test_mode: IS_TEST,
    })
  } catch (e) {
    // оплату не блокуємо
    return sendJson(res, 200, {
      ok: true,
      provider: "monobank",
      tariffId,
      amount_uah: amountUah,
      external_order_id,
      invoiceId,
      acquiring_url: pageUrl,
      airtable_error: String(e?.message || e),
      test_mode: IS_TEST,
    })
  }
}
