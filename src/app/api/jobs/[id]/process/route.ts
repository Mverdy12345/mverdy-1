// POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن ~10–15 ثانية) → رابط الفيديو النهائي
import { NextRequest, NextResponse } from "next/server";
import { processJob, getJob } from "@/lib/merger/service";
import { originFromReq } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: "مهمة الدمج غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" }, { status: 404 });
  }
  if (job.status === "uploading") {
    return NextResponse.json({ error: "المصادر لم تكتمل بعد — أكمل رفع الأجزاء أولًا", status: "uploading" }, { status: 409 });
  }
  if (job.status === "processing") {
    return NextResponse.json({ status: "processing", progress: job.progress }, { status: 202 });
  }
  const result = await processJob(id); // حتمي: أخطاء الخدمة المعلنة = فشل نهائي
  if (result.ok && result.status === "done") {
    const origin = originFromReq(req);
    const updated = await getJob(id);
    return NextResponse.json({
      status: "done",
      videoUrl: `${origin}/api/jobs/${id}/video`,
      downloadUrl: `${origin}/api/jobs/${id}/video?download=1`,
      size: updated?.output_size,
      duration: updated?.output_duration,
      resolution: updated?.output_resolution,
      expiresAt: updated?.expires_at,
    });
  }
  if (result.status === "failed") {
    return NextResponse.json({ error: result.error || "فشل الدمج" }, { status: 500 });
  }
  // مؤقت (شبكتنا) أو قيد المعالجة — استمر بالاستعلام
  return NextResponse.json({ status: result.status || "processing", error: result.error }, { status: 202 });
}
