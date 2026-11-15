// إدارة المفاتيح — GET القائمة (مقنعة دائمًا) / POST إضافة مع رفض التكرار
import { NextRequest, NextResponse } from "next/server";
import { listKeys, insertKey, findDuplicateKey, maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const keys = await listKeys();
  // إخفاء المفاتيح إلزامي — لا يُعاد المفتاح الكامل في أي استجابة
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      masked: maskKey(k.api_key),
      status: k.status,
      usageCount: k.usage_count,
      successCount: k.success_count,
      failCount: k.fail_count,
      lastUsedAt: k.last_used_at,
      lastError: k.last_error,
      createdAt: k.created_at,
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { provider?: string; api_key?: string; label?: string } | null;
  const provider = body?.provider?.trim();
  const apiKey = body?.api_key?.trim();
  const label = body?.label?.trim() || "";
  if (!provider || !["kie", "cometapi"].includes(provider)) {
    return NextResponse.json({ error: "المزود غير صالح — الاختيارات المتاحة: kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey || apiKey.length < 8) {
    return NextResponse.json({ error: "المفتاح مطلوب (طول غير منطقي)" }, { status: 400 });
  }
  const dup = await findDuplicateKey(provider, apiKey);
  if (dup) {
    return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود — لا يمكن التكرار" }, { status: 409 });
  }
  const row = await insertKey(provider, apiKey, label);
  return NextResponse.json(
    {
      key: {
        id: row.id,
        provider: row.provider,
        label: row.label,
        masked: maskKey(row.api_key),
        status: row.status,
        usageCount: 0,
        successCount: 0,
        failCount: 0,
        createdAt: row.created_at,
      },
    },
    { status: 201 },
  );
}
