// مزود CometAPI — المزود الثاني (بلا مفتاح من المستخدم حاليًا، والأشكال وفق التوثيق الرسمي apidoc.cometapi.com):
//   صور متزامنة:  POST /v1/images/generations (متوافق مع OpenAI) → {data:[{url}|{b64_json}]}
//   صور غير متزامنة: GET /v1/images/generations/{task_id}
//   فيديو غير متزامن: POST /v1/videos ثم GET /v1/videos/{id} (نمط موحد لمعظم عائلات الموديلات)
import { type ProviderAdapter, type CheckResult, fetchJson, httpError } from "./types";

const BASE = process.env.COMETAPI_BASE_URL || "https://api.cometapi.com";

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function cometError(status: number, json: unknown, fallback: string): Error & { status: number } {
  const obj = json as { error?: { message?: string }; message?: string; msg?: string } | null;
  const msg = obj?.error?.message || obj?.message || obj?.msg || fallback;
  return httpError(status, msg);
}

function pickUrlList(d: unknown): string[] {
  // أشكال محتملة: {url} | {b64_json} | data[].url | video_url | output[]
  const obj = d as {
    data?: Array<{ url?: string; b64_json?: string }>;
    url?: string;
    video_url?: string;
    output?: string[];
  } | null;
  const urls: string[] = [];
  if (obj?.data) {
    for (const item of obj.data) {
      if (item.url) urls.push(item.url);
      else if (item.b64_json) urls.push(`data:image/png;base64,${item.b64_json}`);
    }
  }
  if (obj?.video_url) urls.push(obj.video_url);
  if (obj?.url) urls.push(obj.url);
  if (Array.isArray(obj?.output)) urls.push(...obj.output);
  return urls;
}

function normalizeStatus(raw: string | undefined): CheckResult["status"] {
  const s = (raw || "").toLowerCase();
  if (["completed", "complete", "success", "succeeded", "finished", "done", "ready"].includes(s)) return "completed";
  if (["failed", "fail", "error", "cancelled", "canceled"].includes(s)) return "failed";
  return "processing";
}

export const cometapiAdapter: ProviderAdapter = {
  imageMode: "sync",

  async createTask(apiKey, providerModel, input) {
    const { status, json } = await fetchJson(`${BASE}/v1/videos`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ model: providerModel, ...input }),
      timeoutMs: 45_000,
    });
    const obj = json as { task_id?: string; id?: string; requestId?: string; data?: { task_id?: string; id?: string } } | null;
    const id = obj?.task_id || obj?.id || obj?.requestId || obj?.data?.task_id || obj?.data?.id;
    if (status >= 400 || !id) throw cometError(status, json, "فشل إنشاء مهمة الفيديو لدى CometAPI");
    return { providerTaskId: id };
  },

  // صور CometAPI متزامنة: النتيجة تُعاد فورًا
  async createImageSync(apiKey, providerModel, input) {
    const { status, json } = await fetchJson(`${BASE}/v1/images/generations`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ model: providerModel, ...input }),
      timeoutMs: 180_000,
    });
    if (status >= 400) throw cometError(status, json, "فشل توليد الصورة لدى CometAPI");
    const urls = pickUrlList(json);
    if (!urls.length) throw cometError(500, json, "لم يُعَد أي رابط صورة من CometAPI");
    return { urls };
  },

  async checkTask(apiKey, providerTaskId): Promise<CheckResult> {
    const { status, json } = await fetchJson(`${BASE}/v1/videos/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: authHeaders(apiKey),
      timeoutMs: 30_000,
    });
    if (status === 404) throw httpError(404, "المهمة غير موجودة لدى CometAPI");
    if (status >= 400) throw cometError(status, json, "فشل استعلام حالة المهمة لدى CometAPI");
    const obj = json as { status?: string; state?: string; progress?: number; error?: string; data?: Record<string, unknown> } | null;
    const payload = (obj?.data as Record<string, unknown>) ?? obj ?? {};
    const urls = pickUrlList(payload);
    const st = normalizeStatus(obj?.status || obj?.state || (payload.status as string));
    if (st === "completed") return { status: "completed", urls: urls.length ? urls : pickUrlList(obj), progress: 100 };
    if (st === "failed") return { status: "failed", error: obj?.error || "فشل التوليد لدى CometAPI" };
    const p = typeof obj?.progress === "number" ? obj.progress : undefined;
    return { status: "processing", progress: p };
  },
};
