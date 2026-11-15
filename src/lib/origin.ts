// استخراج الأصل المطلق للطلب من الرؤوس — لبناء روابط النتائج المطلقة على Vercel
import type { NextRequest } from "next/server";

export function originFromReq(req: NextRequest): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || "";
  const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return host ? `${proto}://${host}` : process.env.PUBLIC_APP_URL || "";
}
