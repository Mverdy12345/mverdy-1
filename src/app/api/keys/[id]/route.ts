// تعطيل/تنشيط يدوي + حذف مفتاح — PATCH /api/keys/{id} و DELETE /api/keys/{id}
import { NextRequest, NextResponse } from "next/server";
import { setKeyStatus, deleteKey, maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { status?: string } | null;
  const status = body?.status;
  if (!status || !["active", "disabled"].includes(status)) {
    return NextResponse.json({ error: "الحالة المطلوبة غير صالحة — الاختيارات: active أو disabled" }, { status: 400 });
  }
  await setKeyStatus(id, status as "active" | "disabled");
  return NextResponse.json({ ok: true, id, status });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await deleteKey(id);
  return NextResponse.json({ ok: true, id });
}

// بلا استخدام حاليًا لكن يُبقي المسار مكتملًا
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json({ id, note: "استخدم GET /api/keys للقائمة الكاملة المقنعة", maskedOnly: true, mask: maskKey("") });
}
