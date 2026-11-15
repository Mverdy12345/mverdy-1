// GET /api/cron — حذف المهام المنتهية (Cron يومي في vercel.json + تنظيف كسول عند كل إنشاء)
import { NextResponse } from "next/server";
import { cleanupExpired } from "@/lib/merger/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const deleted = await cleanupExpired();
  return NextResponse.json({ ok: true, deletedJobs: deleted, at: new Date().toISOString() });
}
