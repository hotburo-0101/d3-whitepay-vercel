const crypto = require("crypto")

function send(res, status, text) {
  res.statusCode = status
  res.setHeader("Content-Type", "text/plain; charset=utf-8")
  res.end(text)
}

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

let cachedPubKeyPem = null
let cachedAt = 0

async function getMonoPubKeyPem(MONO_TOKEN) {
  const now = Date.now()
  if (cachedPubKeyPem && now - cachedAt < 6 * 60 * 60 * 1000) return cachedPubKeyPem

  const r = await fetch("https://api.monobank.ua/api/merchant/pubkey", {
    headers: { "X-Token": MONO_TOKEN },
  })

  const base64 = await r.text()
  if (!r.ok) throw new Error(`pubkey fetch failed: ${r.status} ${base64}`)

  const pem = Buffer.from(base64, "base64").toString("utf8")
  cachedPubKeyPem = pem
  cachedAt = now
  return pem
}

function verifyXSign(pubKeyPem, xSignBase64, bodyBuffer) {
  const signature = Buffer.from(String(xSignBase64), "base64")
  const verify = crypto.createVerify("SHA256")
  verify.update(bodyBuffer)
  verify.end()
  return verify.verify(pubKeyPem, signature)
}

function mapMonoStatusToCrm(status) {
  const s = String(status || "").toLowerCase()
  if (s === "success") return "PAID"
  if (s === "failure") return "FAILED"
  if (s === "expired") return "FAILED"
  if (s === "reversed") return "FAILED"
  return "PENDING"
}

// ====== Resend templates + TG links (по tariffId) ======
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
      id: templateIdOrAlias, // може бути id або alias
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

// ====== Airtable ======
async function airtableFindByExternalOrderId(externalOrderId) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
    throw new Error("Missing Airtable env vars (AIRTABLE_TOKEN / AIRTABLE_BASE_ID / AIRTABLE_TABLE)")
  }

  const base = `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(AIRTABLE_TABLE)}`
  const filter = `{External Order ID}="${String(externalOrderId).replace(/"/g, '\\"')}"`
  const url = `${base}?maxRecords=1&filterByFormula=${encodeURIComponent(filter)}`

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  })

  const data = await r.json()
  if (!r.ok) throw new Error(`Airtable find failed (${r.status}): ${JSON.stringify(data)}`)

  const rec = Array.isArray(data.records) && data.records.length ? data.records[0] : null
  return rec
}

async function airtablePatchRecord(recordId, fields) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE

  const url = `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`

  const r = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  })

  const data = await r.json()
  if (!r.ok) throw new Error(`Airtable patch failed (${r.status}): ${JSON.stringify(data)}`)
  return data
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, "Method Not Allowed")

  const MONO_TOKEN = process.env.MONO_TOKEN
  if (!MONO_TOKEN) return send(res, 500, "MONO_TOKEN missing")

  const EMAIL_FROM = process.env.EMAIL_FROM
  if (!EMAIL_FROM) return send(res, 500, "EMAIL_FROM missing")

  const xSign = req.headers["x-sign"]
  if (!xSign) return send(res, 400, "Missing X-Sign")

  let bodyBuf
  try {
    bodyBuf = await readRawBody(req)
  } catch (e) {
    return send(res, 400, "Failed to read body")
  }

  let pubKeyPem
  try {
    pubKeyPem = await getMonoPubKeyPem(MONO_TOKEN)
  } catch (e) {
    // якщо не можемо взяти ключ — краще 500 (mono зробить retry)
    return send(res, 500, "Pubkey fetch error")
  }

  const ok = verifyXSign(pubKeyPem, xSign, bodyBuf)
  if (!ok) return send(res, 401, "Invalid signature")

  let payload
  try {
    payload = JSON.parse(bodyBuf.toString("utf8"))
  } catch (e) {
    return send(res, 400, "Invalid JSON")
  }

  const reference = payload?.reference // External Order ID
  const status = payload?.status
  const invoiceId = payload?.invoiceId

  if (!reference || typeof reference !== "string") return send(res, 400, "Missing reference")
  if (!status || typeof status !== "string") return send(res, 400, "Missing status")

  const crmStatus = mapMonoStatusToCrm(status)

  try {
    const rec = await airtableFindByExternalOrderId(reference)
    if (!rec) {
      // нема запису — 200, щоб mono не ретраїв нескінченно
      return send(res, 200, "OK (no record)")
    }

    const prevStatus = String(rec.fields?.status || "")
    const email = String(rec.fields?.email || "").trim()
    const name = String(rec.fields?.customer_name || "").trim()
    const tariffId = String(rec.fields?.["Tariff ID"] || "").trim()

    // 1) PATCH в Airtable (тільки поля що треба)
    const patch = {
      status: crmStatus,
      provider: "monobank",
      currency: "UAH",
    }

    // якщо хочеш зберігати invoiceId — ти вже писав в Whitepay Order ID, лишаю як є
    if (invoiceId) patch["Whitepay Order ID"] = String(invoiceId)

    await airtablePatchRecord(rec.id, patch)

    // 2) Якщо PAID — шлемо лист ОДИН раз
    if (crmStatus === "PAID") {
      if (prevStatus === "PAID_EMAIL_SENT") {
        return send(res, 200, "OK (already emailed)")
      }

      if (!email || !tariffId) {
        // не валимо webhook, але й не ставимо PAID_EMAIL_SENT
        return send(res, 200, "OK (missing email/tariff)")
      }

      const t = pickTariff(tariffId)
      if (!t) return send(res, 200, "OK (unknown tariff)")

      const tgLink = process.env[t.tgEnv]
      const templateIdOrAlias = process.env[t.tplEnv]
      if (!tgLink || !templateIdOrAlias) return send(res, 500, "Missing email env (tg/template)")

      await resendSendTemplate({
        to: email,
        from: EMAIL_FROM,
        subject: `D3 Education — доступ активовано (${t.title})`,
        templateIdOrAlias,
        variables: {
          customer_name: name || "",
          tariff_title: t.title,
          tg_link: tgLink,
        },
      })

      // 3) Фіксуємо що лист відправлений
      await airtablePatchRecord(rec.id, { status: "PAID_EMAIL_SENT" })
    }

    return send(res, 200, "OK")
  } catch (e) {
    // краще 500, щоб mono ретраїв і не загубився paid
    return send(res, 500, "Airtable/Email error")
  }
}
