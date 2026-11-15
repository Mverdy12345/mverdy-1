// POST /api/jobs — إنشاء مهمة دمج (روابط مباشرة أو مصادر ملفات ستُرفع بأجزاء)
// GET /api/jobs — قائمة المهام الجارية (اختياري للفحص)
import { NextRequest, NextResponse } from "next/server";
import { createJob, cleanupExpired, LIMITS, type SourceSpec } from "@/lib/merger/service";
import { ensureSchema } from "@/lib/turso";
import { originFromReq } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;


export async function POST(req: NextRequest) {
  await ensureSchema();
  await cleanupExpired().catch(() => {}); // تنظيف كسول عند كل إنشاء
  const body = (await req.json().catch(() => null)) as
    | { videos?: string[]; sources?: Array<{ kind?: string; url?: string; name?: string; size?: number; mime?: string }> }
    | null;
  if (!body) {
    return NextResponse.json({ error: "الجسم غير صالح — أرسل JSON بالشكل {\"videos\":[...]} أو {\"sources\":[...]}" }, { status: 400 });
  }

  let sources: SourceSpec[] = [];
  if (Array.isArray(body.videos) && body.videos.length) {
    sources = body.videos.map((u) => ({ kind: "url" as const, url: String(u) }));
  } else if (Array.isArray(body.sources) && body.sources.length) {
    sources = body.sources.map((s) =>
      s.kind === "file"
        ? { kind: "file" as const, name: s.name, size: s.size, mime: s.mime }
        : { kind: "url" as const, url: String(s.url || s) },
    );
  } else {
    return NextResponse.json({ error: "لا توجد مقاطع — مرّر videos أو sources (مقطعان على الأقل)" }, { status: 400 });
  }

  // تحقق صارم: ≥2، ≤10، كل الروابط http/https مباشرة وعامة
  if (sources.length < 2) {
    return NextResponse.json({ error: "الدمج يحتاج مقطعَين على الأقل" }, { status: 400 });
  }
  if (sources.length > LIMITS.maxSources) {
    return NextResponse.json({ error: `أقصى عدد مقاطع للدمج هو ${LIMITS.maxSources}` }, { status: 400 });
  }
  const badUrl = sources.find((s) => s.kind === "url" && !/^https?:\/\/\S+$/i.test(s.url));
  if (badUrl) {
    return NextResponse.json({ error: "الروابط يجب أن تكون http/https مباشرة وعامة" }, { status: 400 });
  }

  const job = await createJob(sources);
  const origin = originFromReq(req);
  const hasFiles = sources.some((s) => s.kind === "file");
  const uploads = sources
    .map((s, seq) => (s.kind === "file" ? `${origin}/api/upload?job=${job.id}&seq=${seq}` : null))
    .filter(Boolean) as string[];
  return NextResponse.json(
    {
      jobId: job.id,
      status: job.status,
      statusUrl: `${origin}/api/jobs/${job.id}`,
      processUrl: `${origin}/api/jobs/${job.id}/process`,
      expiresAt: job.expires_at,
      ...(hasFiles ? { uploads, uploadChunkBytes: LIMITS.uploadChunkBytes } : {}),
    },
    { status: 201 },
  );
}

export async function GET() {
  return NextResponse.json({ error: "استخدم GET /api/jobs/{id} للاستعلام عن مهمة بعينها" }, { status: 405 });
}
