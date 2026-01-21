const crypto = require("crypto")

function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(data))
}

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Manual-Secret")
  res.setHeader("Access-Control-Max-Age", "86400")
}

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

async function getJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body
  const raw = await readRawBody(req)
  if (!raw || !raw.length) return {}
  try {
    return JSON.parse(raw.toString("utf8"))
  } catch {
    return { __invalid_json: true, __raw: raw.toString("utf8").slice(0, 2000) }
  }
}

function safeString(v, max = 255) {
  const s = String(v ?? "").trim()
  return s.length > max ? s.slice(0, max) : s
}

function timingSafeEq(a, b) {
  const aa = Buffer.from(String(a || ""))
  const bb = Buffer.from(String(b || ""))
  if (aa.length !== bb.length) return false
  return crypto.timingSafeEqual(aa, bb)
}

// ====== Tariffs mapping ======
const TARIFFS = {
  base: { title: "База", tgEnv: "TG_LINK_BASE", tplEnv: "RESEND_TEMPLATE_BASE" },
  ground: { title: "Ґрунт", tgEnv: "TG_LINK_GROUND", tplEnv: "RESEND_TEMPLATE_GROUND" },
  foundation: { title: "Фундамент", tgEnv: "TG_LINK_FOUNDATION", tplEnv: "RESEND_TEMPLATE_FOUNDATION" },
}

function pickTariff(tariffId) {
  return TARIFFS[String(tariffId || "").trim()] || null
}

// ====== Resend ======
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
  try { data = JSON.parse(text) } catch { data = { raw: text } }

  if (!r.ok) {
    const msg = data?.message || data?.error || `Resend error (${r.status})`
    const err = new Error(msg)
    err.details = data
    err.status = r.status
    throw err
  }

  return data
}

// ====== Airtable helpers ======
function airtableBaseUrl() {
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE
  if (!AIRTABLE_BASE_ID || !AIRTABLE_TABLE) throw new Error("Missing Airtable env vars (AIRTABLE_BASE_ID / AIRTABLE_TABLE)")
  return `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(AIRTABLE_TABLE)}`
}

function airtableHeaders() {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
  if (!AIRTABLE_TOKEN) throw new Error("Missing AIRTABLE_TOKEN")
  return {
    Authorization: `Bearer ${AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  }
}

async function airtableFindByRecordId(recordId) {
  const url = `${airtableBaseUrl()}/${encodeURIComponent(recordId)}`
  const r = await fetch(url, { headers: airtableHeaders() })
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!r.ok) throw new Error(`Airtable read failed (${r.status}): ${text}`)
  return data
}

async function airtableFindByExternalOrderId(externalOrderId) {
  const base = airtableBaseUrl()
  const filter = `{External Order ID}="${String(externalOrderId).replace(/"/g, '\\"')}"`
  const url = `${base}?maxRecords=1&filterByFormula=${encodeURIComponent(filter)}`
  const r = await fetch(url, { headers: airtableHeaders() })
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!r.ok) throw new Error(`Airtable find failed (${r.status}): ${text}`)
  const rec = Array.isArray(data.records) && data.records.length ? data.records[0] : null
  return rec
}

async function airtablePatchRecord(recordId, fields) {
  const url = `${airtableBaseUrl()}/${encodeURIComponent(recordId)}`
  const r = await fetch(url, {
    method: "PATCH",
    headers: airtableHeaders(),
    body: JSON.stringify({ fields }),
  })
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!r.ok) throw new Error(`Airtable patch failed (${r.status}): ${text}`)
  return data
}

function normalizeStatus(s) {
  return String(s || "").trim().toUpperCase()
}

module.exports = async (req, res) => {
  setCors(req, res)

  if (req.method === "OPTIONS") {
    res.statusCode = 204
    return res.end()
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" })

  const MANUAL_EMAIL_SECRET = process.env.MANUAL_EMAIL_SECRET
  if (!MANUAL_EMAIL_SECRET) return sendJson(res, 500, { error: "MANUAL_EMAIL_SECRET missing" })

  const body = await getJsonBody(req)
  if (body.__invalid_json) return sendJson(res, 400, { error: "Invalid JSON body", raw: body.__raw })

  // auth: header X-Manual-Secret або body.secret
  const headerSecret = req.headers["x-manual-secret"]
  const provided = String(headerSecret || body.secret || "")
  if (!timingSafeEq(provided, MANUAL_EMAIL_SECRET)) return sendJson(res, 401, { error: "Unauthorized" })

  // input: recordId або externalOrderId
  const recordId = safeString(body.recordId || body.airtable_record_id || "", 128)
  const externalOrderId = safeString(body.externalOrderId || body.external_order_id || "", 255)
  if (!recordId && !externalOrderId) return sendJson(res, 400, { error: "Provide recordId or externalOrderId" })

  // 1) read record
  let rec
  try {
    rec = recordId ? await airtableFindByRecordId(recordId) : await airtableFindByExternalOrderId(externalOrderId)
  } catch (e) {
    return sendJson(res, 502, { error: "Airtable read failed", details: String(e?.message || e) })
  }
  if (!rec) return sendJson(res, 404, { error: "Record not found" })

  const fields = rec.fields || {}
  const status = normalizeStatus(fields.status)

  // 2) send only if PAID
  if (status !== "PAID") {
    return sendJson(res, 409, { error: "Status is not PAID", status })
  }

  // 3) idempotency: do not resend
  const paidSent = normalizeStatus(fields.status) === "PAID_EMAIL_SENT"
  if (paidSent) {
    return sendJson(res, 200, { ok: true, already_sent: true })
  }

  const email = String(fields.email || "").trim()
  const name = String(fields.customer_name || "").trim()
  const tariffId = String(fields["Tariff ID"] || "").trim()

  if (!email) return sendJson(res, 400, { error: "Record missing email" })
  if (!tariffId) return sendJson(res, 400, { error: "Record missing Tariff ID" })

  const t = pickTariff(tariffId)
  if (!t) return sendJson(res, 400, { error: "Unknown tariff", tariffId })

  const tgLink = process.env[t.tgEnv]
  const templateIdOrAlias = process.env[t.tplEnv]
  const from = process.env.EMAIL_FROM

  if (!tgLink) return sendJson(res, 500, { error: `Missing env ${t.tgEnv}` })
  if (!templateIdOrAlias) return sendJson(res, 500, { error: `Missing env ${t.tplEnv}` })
  if (!from) return sendJson(res, 500, { error: "Missing EMAIL_FROM" })

  const subject = safeString(`D3 Education — доступ активовано (${t.title})`, 255)

  // 4) send email
  let resendOut
  try {
    resendOut = await resendSendTemplate({
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
  } catch (e) {
    return sendJson(res, 502, {
      error: "Resend send failed",
      message: String(e?.message || e),
      status: e?.status || null,
      details: e?.details || null,
    })
  }

  // 5) mark as sent (so it won't resend)
  try {
    await airtablePatchRecord(rec.id, { status: "PAID_EMAIL_SENT" })
  } catch (e) {
    // email sent, but status not updated
    return sendJson(res, 200, {
      ok: true,
      sent: true,
      resend: resendOut,
      warn: "Email sent, but Airtable status update failed",
      details: String(e?.message || e),
    })
  }

  return sendJson(res, 200, {
    ok: true,
    sent: true,
    recordId: rec.id,
    to: email,
    tariffId,
    new_status: "PAID_EMAIL_SENT",
    resend: resendOut,
  })
}
