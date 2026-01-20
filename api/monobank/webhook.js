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
  if (cachedPubKeyPem && (now - cachedAt) < 6 * 60 * 60 * 1000) return cachedPubKeyPem

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

async function airtableFindByExternalOrderId(externalOrderId) {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
    throw new Error("Missing Airtable env vars (AIRTABLE_TOKEN / AIRTABLE_BASE_ID / AIRTABLE_TABLE)")
  }

  const base = `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(AIRTABLE_TABLE)}`
  const filter = `{External Order ID}="${externalOrderId}"`
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

  // В payload має бути reference (ми туди клали External Order ID)
  const reference = payload?.reference
  const status = payload?.status
  const invoiceId = payload?.invoiceId

  if (!reference || typeof reference !== "string") return send(res, 400, "Missing reference")
  if (!status || typeof status !== "string") return send(res, 400, "Missing status")

  // Мапимо в твоє поле status (можеш потім під себе нормалізувати)
  // Напр: success -> PAID
  const normalized =
    status === "success" ? "PAID" :
    status === "failure" ? "FAILED" :
    status === "expired" ? "EXPIRED" :
    status.toUpperCase()

  try {
    const rec = await airtableFindByExternalOrderId(reference)
    if (!rec) {
      // Нема запису — все одно 200, щоб mono не ретраїв нескінченно
      return send(res, 200, "OK (no record)")
    }

    const patch = {
      status: normalized,
    }

    // якщо хочеш, можеш ще раз зафіксувати invoiceId (на випадок якщо create не записав)
    if (invoiceId) patch["Whitepay Order ID"] = String(invoiceId)

    await airtablePatchRecord(rec.id, patch)
    return send(res, 200, "OK")
  } catch (e) {
    // тут краще 500, щоб mono ретраїв і не загубився paid
    return send(res, 500, "Airtable error")
  }
}
