const TARIFFS = {
  base: { title: "База", usd: 299, uah: 12999, glow: "white" },
  ground: { title: "Ґрунт", usd: 499, uah: 20999, glow: "green" },
  foundation: { title: "Фундамент", usd: 799, uah: 33999, glow: "yellow" },
}

function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(data))
}

function safeString(v, max = 255) {
  const s = String(v ?? "").trim()
  return s.length > max ? s.slice(0, max) : s
}

function makeExternalOrderId(tariffId) {
  return `d3_${tariffId}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" })

  const WHITEPAY_API_TOKEN = process.env.WHITEPAY_API_TOKEN
  const WHITEPAY_SLUG = process.env.WHITEPAY_SLUG // у тебе: d3-education
  const SITE_URL = process.env.SITE_URL // https://d3.education

  if (!WHITEPAY_API_TOKEN || !WHITEPAY_SLUG || !SITE_URL) {
    return sendJson(res, 500, {
      error: "Missing env vars",
      required: ["WHITEPAY_API_TOKEN", "WHITEPAY_SLUG", "SITE_URL"],
    })
  }

  // Vercel зазвичай дає req.body як object, але підстрахуємось
  let body = req.body
  if (!body || typeof body !== "object") {
    try {
      body = JSON.parse(req.body || "{}")
    } catch (e) {
      return sendJson(res, 400, { error: "Invalid JSON body" })
    }
  }

  const tariffId = safeString(body.tariffId, 32)
  const email = safeString(body.email, 255).toLowerCase()
  const name = safeString(body.name, 255)

  if (!TARIFFS[tariffId]) return sendJson(res, 400, { error: "Invalid tariffId" })
  if (!email) return sendJson(res, 400, { error: "Email is required" })

  const external_order_id = makeExternalOrderId(tariffId)
  const amountUsd = TARIFFS[tariffId].usd

  // Whitepay create crypto-order (payment page slug)
  const url = `https://api.whitepay.com/private-api/crypto-orders/${encodeURIComponent(WHITEPAY_SLUG)}`

  const payload = {
    amount: String(amountUsd),
    currency: "USD",
    external_order_id,

    description: `D3 Education — ${TARIFFS[tariffId].title} (${amountUsd}$)`,

    // ✅ гарантія що ці дані прийдуть у webhook
    metadata: {
      tariffId,
      email,
      name: name || "",
    },

    // ці лінки потрібні, щоб Whitepay повертав на твій сайт після оплати/помилки
    successful_link: `${SITE_URL}/payment-success?tariff=${encodeURIComponent(tariffId)}&order=${encodeURIComponent(external_order_id)}`,
    failure_link: `${SITE_URL}/payment-failed?tariff=${encodeURIComponent(tariffId)}&order=${encodeURIComponent(external_order_id)}`,
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
  } catch {
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

  return sendJson(res, 200, {
    ok: true,
    tariffId,
    amount_usd: amountUsd,
    external_order_id,
    whitepay_order_id,
    status,
    acquiring_url,
  })
}
