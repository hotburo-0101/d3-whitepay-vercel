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

const TARIFFS = {
  base: { title: "База", tgEnv: "TG_LINK_BASE", tplEnv: "RESEND_TEMPLATE_BASE" },
  ground: { title: "Ґрунт", tgEnv: "TG_LINK_GROUND", tplEnv: "RESEND_TEMPLATE_GROUND" },
  foundation: { title: "Фундамент", tgEnv: "TG_LINK_FOUNDATION", tplEnv: "RESEND_TEMPLATE_FOUNDATION" },
}

function pickTariff(tariffId) {
  return TARIFFS[String(tariffId || "").trim()] || null
}

async function resendSendTemplate({ to, from, subject, templateIdOrAlias, variables }) {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error("Missing RESEND_API_KEY")

  const payload = {
    from,
    to,
    subject,
    template: {
      id: templateIdOrAlias,
      variables: variables || {},
    },
  }

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }

  if (!r.ok) {
    const msg = data?.message || data?.error || `Resend error (${r.status})`
    const err = new Error(msg)
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

  let body = req.body
  if (!body || typeof body !== "object") {
    try {
      body = JSON.parse(req.body || "{}")
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body" })
    }
  }

  const email = safeString(body.email, 255)
  const name = safeString(body.name ?? body.customer_name ?? "", 255)
  const tariffId = safeString(body.tariffId ?? body.tariff_id ?? body.tariff ?? "", 32)

  if (!email) return sendJson(res, 400, { error: "email required" })
  const t = pickTariff(tariffId)
  if (!t) return sendJson(res, 400, { error: "Invalid tariffId" })

  const tgLink = process.env[t.tgEnv]
  if (!tgLink) return sendJson(res, 500, { error: `Missing env ${t.tgEnv}` })

  const templateIdOrAlias = process.env[t.tplEnv]
  if (!templateIdOrAlias) return sendJson(res, 500, { error: `Missing env ${t.tplEnv}` })

  const from = process.env.EMAIL_FROM
  if (!from) return sendJson(res, 500, { error: "Missing EMAIL_FROM" })

  const subject = safeString(body.subject || `D3 Education — доступ активовано (${t.title})`, 255)

  try {
    const out = await resendSendTemplate({
      to: email,
      from,
      subject,
      templateIdOrAlias,
      variables: {
        customer_name: name || "",
        tariff_title: t.title,
        tg_link: tgLink,
      },
    })

    return sendJson(res, 200, { ok: true, sent: true, resend: out })
  } catch (e) {
    return sendJson(res, 500, {
      ok: false,
      error: String(e?.message || e),
      details: e?.details || null,
      status: e?.status || null,
    })
  }
}
