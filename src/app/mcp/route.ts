// مسار خادم MCP — نقل Streamable HTTP (WebStandard) وفق مواصفات MCP
// وضع عديم الحالة (stateless): خادم وترانسبورت لكل طلب — الأنسب لبيئة Vercel serverless
import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// الفيديو والدمج يحتاجان دقائق — اترك نافذة واسعة (مع Fluid compute على Vercel)
export const maxDuration = 300;

function authOk(req: NextRequest): boolean {
  // إن ضُبط MCP_ACCESS_TOKEN يُطلب Bearer token على /mcp
  const expected = process.env.MCP_ACCESS_TOKEN;
  if (!expected) return true;
  const header = req.headers.get("authorization") || "";
  return header === `Bearer ${expected}`;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    // خادم + ترانسبورت لكل طلب (stateless — لا جلسات تُفقد عند إعادة تدوير الدوال)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createMcpServer();
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "خطأ داخلي في الخادم" }, id: null },
      { status: 500 },
    );
  }
}

// وضع stateless: لا جلسات لإغلاقها
export async function DELETE() {
  return NextResponse.json({ error: "الوضع عديم الحالة — لا جلسات لإغلاقها" }, { status: 405 });
}

// عدم دعم تدفق الاستماع GET (stateless) وفق مواصفات MCP
export async function GET() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405 });
}
