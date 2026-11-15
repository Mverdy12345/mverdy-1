// GET /api/health — حالة الخدمة (spec §9)
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerHealthy, isExternalMerger } from "@/lib/merger/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await dbHealthy();
  const merger = await mergerHealthy();
  return NextResponse.json({
    ok: db,
    database: db ? "turso-connected" : "turso-error",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: merger.base, healthy: merger.healthy, mode: isExternalMerger() ? "external" : "embedded", error: merger.error },
    authRequired: !!process.env.MCP_ACCESS_TOKEN,
  });
}
