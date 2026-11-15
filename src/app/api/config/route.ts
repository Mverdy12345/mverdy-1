// GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية)
import { NextResponse } from "next/server";
import { LIMITS } from "@/lib/merger/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    version: "2.0.0",
    maxSources: LIMITS.maxSources,
    sourceMaxMB: LIMITS.sourceMaxMB,
    outputMaxMB: LIMITS.outputMaxMB,
    maxTotalDurationSec: LIMITS.maxTotalDurationSec,
    uploadChunkBytes: LIMITS.uploadChunkBytes,
    ttlHours: LIMITS.ttlHours,
    output: "MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18 — لا معاملات resolution/fps (الناتج ثابت)",
  });
}
