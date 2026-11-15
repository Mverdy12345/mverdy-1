// GET /api/jobs/{id} — الحالة + التقدم + الرابط عند الاكتمال
// DELETE /api/jobs/{id} — حذف فوري شامل
import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/merger/service";
import { removeMergeJob } from "@/lib/merger/client";
import { originFromReq } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: "مهمة الدمج غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" }, { status: 404 });
  }
  const origin = originFromReq(req);
  const videoUrl = `${origin}/api/jobs/${id}/video`;
  return NextResponse.json({
    jobId: id,
    status: job.status,
    progress: job.progress,
    videoUrl: job.status === "done" ? videoUrl : undefined,
    downloadUrl: job.status === "done" ? `${videoUrl}?download=1` : undefined,
    size: job.output_size,
    duration: job.output_duration,
    resolution: job.output_resolution,
    error: job.error,
    expiresAt: job.expires_at,
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: "مهمة الدمج غير موجودة" }, { status: 404 });
  }
  await removeMergeJob(id);
  return NextResponse.json({ ok: true, deleted: id });
}
