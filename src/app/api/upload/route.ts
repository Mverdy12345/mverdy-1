// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB) مع إعادة محاولة من الواجهة
import { NextRequest, NextResponse } from "next/server";
import { appendUpload, markSourceUploaded, LIMITS } from "@/lib/merger/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const jobId = sp.get("job");
  const seq = Number(sp.get("seq"));
  const chunk = Number(sp.get("chunk"));
  if (!jobId || !Number.isInteger(seq) || !Number.isInteger(chunk) || seq < 0 || chunk < 0) {
    return NextResponse.json({ error: "معطيات الرفع غير صالحة — المطلوب: job و seq و chunk" }, { status: 400 });
  }
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) {
    return NextResponse.json({ error: "الجزء فارغ" }, { status: 400 });
  }
  if (buf.length > LIMITS.uploadChunkBytes + 64 * 1024) {
    return NextResponse.json({ error: `الجزء يتجاوز الحد (${Math.round(LIMITS.uploadChunkBytes / 1024 / 1024)}MB)` }, { status: 413 });
  }
  try {
    await appendUpload(jobId, seq, chunk, buf);
    // الجزء الأخير يعيّنه العميل برأس x-final — يعمل حتى لو كان حجم الملف مضاعفًا دقيقًا للحد
    if (req.headers.get("x-final") === "1") {
      await markSourceUploaded(jobId, seq);
    }
    const finalized = req.headers.get("x-final") === "1";
    return NextResponse.json({ ok: true, job: jobId, seq, chunk, bytes: buf.length, finalized });
  } catch (e) {
    const status = (e as { status?: number }).status || 500;
    const msg = e instanceof Error ? e.message : "فشل رفع الجزء";
    return NextResponse.json({ error: msg }, { status: status === 500 ? 500 : status });
  }
}
