// GET /api/tasks — لوحة المهام (إحصائيات + أحدث المهام) للتحديث التلقائي كل ~5 ثوانٍ
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats, taskResultUrls } from "@/lib/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(searchParams.get("limit") || 20)));
  const type = searchParams.get("type") || undefined;
  const status = searchParams.get("status") || undefined;
  const [tasks, stats] = await Promise.all([listRecentTasks(limit, { type, status }), taskStats()]);
  return NextResponse.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id,
      type: t.type,
      model: t.model,
      status: t.status,
      progress: t.progress,
      prompt: t.prompt?.slice(0, 200) || "",
      urls: taskResultUrls(t),
      error: t.error_message,
      attempts: (() => {
        try {
          return JSON.parse(t.attempts_json || "[]").length;
        } catch {
          return 0;
        }
      })(),
      provider: t.provider,
      createdAt: t.created_at,
      completedAt: t.completed_at,
    })),
  });
}
