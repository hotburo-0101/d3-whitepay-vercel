import { NextResponse } from "next/server";

type CreateOrderBody = {
  amount: number;
  currency: string;
  email?: string;
  userId?: string;
};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function airtableCreate(fields: Record<string, any>) {
  const apiKey = mustEnv("AIRTABLE_API_KEY");
  const baseId = mustEnv("AIRTABLE_BASE_ID");
  const tableId = mustEnv("AIRTABLE_TABLE_ID");

  const res = await fetch(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Airtable create failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function whitepayCreateOrder(payload: any) {
  const apiBase = mustEnv("WHITEPAY_API_BASE");
  const apiKey = mustEnv("WHITEPAY_API_KEY");

  const res = await fetch(`${apiBase}/create-order`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Whitepay create-order failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateOrderBody;

    if (!body.amount || body.amount <= 0) {
      return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
    }
    if (!body.currency) {
      return NextResponse.json({ error: "currency is required" }, { status: 400 });
    }

    // 1) Create order in Whitepay
    // IMPORTANT: payload shape залежить від Whitepay. Тут — робочий каркас.
    const wpOrder = await whitepayCreateOrder({
      amount: body.amount,
      currency: body.currency,
      email: body.email,
      // successUrl / failUrl / callbackUrl часто потрібні
      // callbackUrl: `${process.env.NEXT_PUBLIC_BASE_URL}/api/whitepay-webhook`,
    });

    // Очікуємо, що Whitepay поверне order id.
    // Підтримуємо кілька типових варіантів.
    const orderId =
      wpOrder?.orderId ||
      wpOrder?.id ||
      wpOrder?.data?.orderId ||
      wpOrder?.data?.id;

    if (!orderId) {
      return NextResponse.json(
        { error: "Whitepay response has no orderId", whitepay: wpOrder },
        { status: 502 }
      );
    }

    // 2) Create Airtable record with PENDING
    const airtableRecord = await airtableCreate({
      orderId: String(orderId),
      status: "PENDING",
      amount: body.amount,
      currency: body.currency,
      email: body.email ?? "",
      userId: body.userId ?? "",
      createdAt: new Date().toISOString(),
      webhookPayload: "",
    });

    return NextResponse.json({
      ok: true,
      orderId: String(orderId),
      airtableRecordId: airtableRecord?.id,
      whitepay: wpOrder,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
