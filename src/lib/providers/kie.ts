// مزود kie.ai — Jobs API الموحد (الأشكال حقيقية مقاسة فعليًا بـ curl:
//   POST /api/v1/jobs/createTask  → {"code":200,"msg":"success","data":{"taskId":"...","recordId":"..."}}
//   GET  /api/v1/jobs/recordInfo  → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//          "resultJson":"{\"resultUrls\":[\"https://...\"]}",  // نص JSON داخل JSON يحتاج JSON.parse ثانيًا
//          "failMsg":...}}
import { type ProviderAdapter, type CheckResult, fetchJson, httpError } from "./types";

const BASE = "https://api.kie.ai";

interface KieRecord {
  taskId?: string;
  state?: string;
  resultJson?: string;
  failMsg?: string | null;
  failCode?: string | number | null;
  progress?: number;
}

function extractUrls(record: KieRecord): string[] {
  if (!record.resultJson) return [];
  try {
    // resultJson نص JSON داخل JSON → parse ثانٍ إلزامي
    const inner = JSON.parse(record.resultJson) as { resultUrls?: string[]; resultUrl?: string };
    if (Array.isArray(inner.resultUrls) && inner.resultUrls.length) return inner.resultUrls.filter(Boolean);
    if (inner.resultUrl) return [inner.resultUrl];
    return [];
  } catch {
    // احتياط: إن كان النص رابطًا مباشرًا
    if (/^https?:\/\//.test(record.resultJson)) return [record.resultJson];
    return [];
  }
}

function kieApiError(status: number, json: unknown, fallbackMsg: string): Error & { status: number } {
  const obj = json as { code?: number; msg?: string; message?: string } | null;
  const msg = obj?.msg || obj?.message || fallbackMsg;
  // kie يعيد الحالة داخل الجسم (code) — نمرر الأعلى بينه وبين حالة HTTP للتصنيف
  return httpError(Math.max(status, Number(obj?.code ?? 0) || 0) || status, msg);
}

export const kieAdapter: ProviderAdapter = {
  imageMode: "async",

  async createTask(apiKey, providerModel, input) {
    const { status, json } = await fetchJson(`${BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: providerModel, input }),
      timeoutMs: 45_000,
    });
    const obj = json as { code?: number; msg?: string; data?: { taskId?: string } } | null;
    const taskId = obj?.data?.taskId;
    if (status >= 400 || !taskId || (obj?.code && obj.code >= 400)) {
      throw kieApiError(status, json, "فشل إنشاء المهمة لدى kie.ai");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(apiKey, providerTaskId): Promise<CheckResult> {
    const { status, json } = await fetchJson(
      `${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: 30_000,
      },
    );
    const obj = json as { code?: number; msg?: string; data?: KieRecord } | null;
    if (status >= 400 || (obj?.code && obj.code >= 400)) {
      throw kieApiError(status, json, "فشل استعلام حالة المهمة لدى kie.ai");
    }
    const rec = obj?.data ?? {};
    const state = rec.state ?? "";
    const urls = extractUrls(rec);
    if (state === "success" && urls.length) {
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      const msg = rec.failMsg || "فشل التوليد لدى المزود";
      // نفاد الرصيد أثناء المهمة يعود كفشل — يُصنَّف لاحقًا ويُستأنف على المفتاح التالي
      return { status: "failed", error: msg };
    }
    const kieProgress = typeof rec.progress === "number" ? rec.progress : undefined;
    return { status: "processing", progress: kieProgress };
  },
};
