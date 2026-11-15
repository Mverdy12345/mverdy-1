// GET /api/jobs/{id}/video — بث الناتج من صفوف Turso Blobs مع دعم Range (206 + Content-Range)
// ?download=1 للتحميل المباشر
import { NextRequest, NextResponse } from "next/server";
import { getJob, readOutputRange } from "@/lib/merger/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: "مهمة الدمج غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" }, { status: 404 });
  }
  if (job.status !== "done") {
    return NextResponse.json({ error: "الناتج غير جاهز بعد", status: job.status, progress: job.progress }, { status: 409 });
  }

  const size = job.output_size ?? 0;
  const download = new URL(req.url).searchParams.get("download") === "1";
  const baseHeaders: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    ...(download ? { "Content-Disposition": `attachment; filename="merged-${id}.mp4"` } : {}),
  };

  // تحليل المدى المطلوب — بدونه: 200 كامل
  const rangeHeader = req.headers.get("range");
  const startRes = 0;
  if (!rangeHeader) {
    if (size > 0) baseHeaders["Content-Length"] = String(size);
    const full = await readOutputRange(id, startRes, size > 0 ? size - 1 : 0);
    if (!full) return NextResponse.json({ error: "الناتج مفقود من التخزين" }, { status: 410 });
    return new NextResponse(full.stream, { status: 200, headers: baseHeaders });
  }

  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) {
    return NextResponse.json(
      { error: "رأس Range غير مفهوم" },
      { status: 416, headers: { "Content-Range": `bytes */${size}` } },
    );
  }
  const start = m[1] === "" ? null : Number(m[1]);
  const end = m[2] === "" ? null : Number(m[2]);
  // لاحقة "bytes=-N": آخر N بايتات
  const rangeStart = start === null ? Math.max(0, size - (end ?? 0)) : start;
  const rangeEnd = start === null ? size - 1 : end === null ? size - 1 : Math.min(end, size - 1);
  if (size === 0 || rangeStart > rangeEnd || rangeStart >= size) {
    return NextResponse.json({ error: "المدى خارج حدود الملف" }, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const slice = await readOutputRange(id, rangeStart, rangeEnd);
  if (!slice) return NextResponse.json({ error: "الناتج مفقود من التخزين" }, { status: 410 });
  return new NextResponse(slice.stream, {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Range": `bytes ${rangeStart}-${rangeEnd}/${size}`,
      "Content-Length": String(rangeEnd - rangeStart + 1),
    },
  });
}
