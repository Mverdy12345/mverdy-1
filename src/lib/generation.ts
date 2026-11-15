// منسّق التوليد — قلب المشروع:
// التبديل التسلسلي الصارم للمفاتيح مع استئناف نفس المهمة بنفس task_id
// النموذج الذكي لا يرى أخطاء المفاتيح أو الرصيد أبدًا (التبديل صامت من وجهة نظره)
import { normalizeModel, modelByType, type ModelDef, type MediaType } from "./models";
import { ADAPTERS } from "./providers";
import { asProviderError } from "./providers/types";
import { classifyProviderError, getKeyPool, updateKeyStats, setKeyStatus, type ApiKeyRow, type AttemptRecord, type ErrorClass } from "./keys";
import { insertTask, getTask, updateTask, taskResultUrls, type TaskRow } from "./tasks";
import { createMergeJob, getMergeStatus, ensureProcessRunning, kickProcess } from "./merger/client";
import type { CheckResult } from "./providers/types";

// هدأة ~45 ثانية بين محاولات إعادة الإنشاء — حتى لا نضغط المزودين
const g = globalThis as unknown as { __genCooldown?: Map<string, number>; __mergeKick?: Map<string, number> };
if (!g.__genCooldown) g.__genCooldown = new Map();
if (!g.__mergeKick) g.__mergeKick = new Map();
const cooldowns = g.__genCooldown;
const mergeKicks = g.__mergeKick;

export interface GenOptions {
  origin?: string;
  notify?: (progress: number, total: number, message: string) => Promise<void> | void;
}

export type GenOutcome =
  | { kind: "completed"; task: TaskRow; message: string }
  | { kind: "processing"; task: TaskRow; message: string }
  | { kind: "failed"; task: TaskRow; message: string }
  | { kind: "no_keys"; message: string };

// ─── أدوات مساعدة ──────────────────────────────────────────────────

const KEY_PROBLEM_RE = /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|api key|充值|exhausted/i;

/** إخفاء أي ذكر لمفاتيح/رصيد عن العميل — إلزامي (القاعدة الذهبية 4) */
function sanitizeClientMessage(msg: string | null | undefined): string {
  if (!msg) return "";
  if (KEY_PROBLEM_RE.test(msg)) return "تعذر إكمال التوليد مؤقتًا — سيُعاد المحاولة تلقائيًا عند توفر مورد صالح";
  return msg;
}

function attempt(key: ApiKeyRow, ok: boolean, errorClass?: AttemptRecord["errorClass"], error?: string): AttemptRecord {
  return { provider: key.provider, keyId: key.id, keyLabel: key.label, ok, errorClass, error, at: new Date().toISOString() };
}

/** بناء معطيات الموديل من معطيات الأداة — omit للقيم auto حتى لا تُكسر المعطيات لدى المزود */
function buildImageInput(p: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: p.prompt };
  if (p.aspect_ratio && p.aspect_ratio !== "auto") input.aspect_ratio = p.aspect_ratio;
  if (p.resolution) input.resolution = p.resolution;
  if (p.background && p.background !== "auto") input.background = p.background;
  if (p.output_format) input.output_format = p.output_format;
  return input;
}

function buildVideoInput(p: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: p.prompt };
  if (p.image_url) input.image_url = p.image_url;
  if (p.aspect_ratio && p.aspect_ratio !== "auto") input.aspect_ratio = p.aspect_ratio;
  if (p.resolution) input.resolution = p.resolution;
  if (p.enable_audio !== undefined) input.enable_audio = p.enable_audio;
  if (p.duration) input.duration = p.duration;
  return input;
}

function progressMessage(type: MediaType, pct: number): string {
  if (type === "merge") return `قيد الدمج… ${pct}%`;
  if (type === "video") return `قيد توليد الفيديو… ${pct}%`;
  return `قيد التوليد… ${pct}%`;
}

// ─── إنشاء المهمة على مفتاح بعينه ───────────────────────────────────

type CreateOutcome =
  | { kind: "created"; key: ApiKeyRow; providerTaskId: string }
  | { kind: "sync_completed"; key: ApiKeyRow; urls: string[] }
  | { kind: "key_failed"; key: ApiKeyRow; class: ErrorClass; error: string };

async function tryCreate(
  model: ModelDef,
  type: "image" | "video",
  input: Record<string, unknown>,
  key: ApiKeyRow,
): Promise<CreateOutcome> {
  const adapter = ADAPTERS[key.provider as "kie" | "cometapi"];
  if (!adapter) return { kind: "key_failed", key, class: "disabled" as ErrorClass, error: `مزود غير معروف: ${key.provider}` };
  const providerModel = model.providerModel[key.provider as "kie" | "cometapi"] || model.canonical;
  try {
    // صور CometAPI متزامنة إن كان المزود يدعمها
    if (type === "image" && adapter.imageMode === "sync" && adapter.createImageSync) {
      const { urls } = await adapter.createImageSync(key.api_key, providerModel, input);
      updateKeyStats(key.id, true);
      return { kind: "sync_completed", key, urls };
    }
    const { providerTaskId } = await adapter.createTask(key.api_key, providerModel, input);
    updateKeyStats(key.id, true);
    return { kind: "created", key, providerTaskId };
  } catch (e) {
    const pe = asProviderError(e);
    const cls = classifyProviderError(pe.status, pe.message);
    updateKeyStats(key.id, false, { error: pe.message, errorClass: cls });
    if (cls === "disabled") setKeyStatus(key.id, "disabled", pe.message).catch(() => {});
    if (cls === "exhausted") setKeyStatus(key.id, "exhausted", pe.message).catch(() => {});
    return { kind: "key_failed", key, class: cls, error: pe.message };
  }
}

/** حلقة المرشحين بالترتيب: أول نجاح يربط المهمة بالمزود والمفتاح */
type CreateOnBestResult =
  | { kind: "created"; key: ApiKeyRow; providerTaskId: string }
  | { kind: "sync_completed"; key: ApiKeyRow; urls: string[] }
  | { kind: "all_failed" }
  | { kind: "params_error" };

async function createOnBestKey(
  task: TaskRow,
  model: ModelDef,
  type: "image" | "video",
  input: Record<string, unknown>,
  pool: ApiKeyRow[],
  startIndex = 0,
): Promise<CreateOnBestResult> {
  for (let i = startIndex; i < pool.length; i++) {
    const key = pool[i];
    const outcome = await tryCreate(model, type, input, key);
    if (outcome.kind === "created") {
      await updateTask(task.id, {
        provider: key.provider,
        provider_task_id: outcome.providerTaskId,
        key_id: key.id,
        status: "processing",
        attempt: attempt(key, true),
      });
      return { kind: "created", key, providerTaskId: outcome.providerTaskId };
    }
    if (outcome.kind === "sync_completed") {
      await updateTask(task.id, {
        provider: key.provider,
        key_id: key.id,
        status: "completed",
        result_urls_json: JSON.stringify(outcome.urls),
        progress: 100,
        attempt: attempt(key, true),
      });
      return { kind: "sync_completed", key, urls: outcome.urls };
    }
    // فشل على هذا المفتاح — سجّل المحاولة
    await updateTask(task.id, { attempt: attempt(key, false, outcome.class, outcome.error) });
    if (outcome.class === "params") {
      // خطأ معطيات: تبديل المفاتيح لن يحلّه — توقف فورًا
      await updateTask(task.id, { status: "failed", error_message: outcome.error });
      return { kind: "params_error" };
    }
    // disabled / exhausted / provider / temporary → انتقل للمفتاح التالي بصمت
  }
  return { kind: "all_failed" };
}

// ─── نافذة الانتظار مع بث التقدم ───────────────────────────────────

type WaitOutcome =
  | { kind: "completed" }
  | { kind: "timeout" }
  | { kind: "failed"; error?: string; keyProblem: boolean };

async function waitForCompletion(
  task: TaskRow,
  key: ApiKeyRow,
  waitSeconds: number,
  opts: GenOptions,
): Promise<WaitOutcome> {
  const adapter = ADAPTERS[key.provider as "kie" | "cometapi"];
  if (!adapter) return { kind: "failed", keyProblem: false };
  const deadline = Date.now() + waitSeconds * 1000;
  let lastProgress = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (Date.now() >= deadline) break;
    let check: CheckResult;
    try {
      check = await adapter.checkTask(key.api_key, task.provider_task_id!);
    } catch (e) {
      const pe = asProviderError(e);
      const cls = classifyProviderError(pe.status, pe.message);
      if (cls === "disabled" || cls === "exhausted") {
        updateKeyStats(key.id, false, { error: pe.message, errorClass: cls });
        setKeyStatus(key.id, cls, pe.message).catch(() => {});
        return { kind: "failed", error: pe.message, keyProblem: true }; // استئناف على المفتاح التالي
      }
      continue; // خطأ مؤقت في الاستعلام → استمر بالانتظار
    }
    if (check.status === "completed" && check.urls?.length) {
      await updateTask(task.id, {
        status: "completed",
        result_urls_json: JSON.stringify(check.urls),
        progress: 100,
      });
      return { kind: "completed" };
    }
    if (check.status === "failed") {
      const err = check.error || "";
      updateKeyStats(key.id, false, { error: err || "فشل التوليد لدى المزود", errorClass: isKeyProblem(err) ? "temporary" : "params" });
      return { kind: "failed", error: err, keyProblem: isKeyProblem(err) };
    }
    const pct = typeof check.progress === "number" && check.progress > 0 ? Math.min(99, check.progress) : Math.min(95, lastProgress + 5);
    lastProgress = pct;
    await updateTask(task.id, { progress: pct });
    try {
      await opts.notify?.(pct, 100, progressMessage(task.type as MediaType, pct));
    } catch {
      /* إشعارات التقدم اختيارية */
    }
  }
  return { kind: "timeout" };
}

/** هل رسالة الفشل تطابق مشكلات مفتاح/رصيد؟ (spec 4.3.2) */
function isKeyProblem(message: string): boolean {
  return KEY_PROBLEM_RE.test(message || "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── runGeneration: التدفق الكامل لأداة generate_image / generate_video ──

export async function runGeneration(
  type: "image" | "video",
  params: Record<string, unknown>,
  opts: GenOptions = {},
): Promise<GenOutcome> {
  // 1) توحيد اسم الموديل عبر aliases — غير معروف → خطأ معطيات فوري (بدون model → الافتراضي لنوع المهمة)
  const model = params.model ? normalizeModel(params.model as string) : modelByType(type);
  if (!model || model.type !== type) {
    return {
      kind: "failed",
      task: {} as TaskRow,
      message: `❌ موديل غير معروف: ${String(params.model || "")}. المتاح: ${type === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview"}`,
    };
  }
  if (!params.prompt || !String(params.prompt).trim()) {
    return { kind: "failed", task: {} as TaskRow, message: "❌ المعطى prompt مطلوب — اكتب وصفًا للمحتوى المطلوب توليده." };
  }

  // 2) جلب المفاتيح بالترتيب التسلسلي — فارغ → رد no_keys
  const pool = await getKeyPool(model.providers);
  if (pool.length === 0) {
    return {
      kind: "no_keys",
      message: `❌ لا توجد مفاتيح نشطة لخدمة ${model.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    };
  }

  // 3) سجّل المهمة في Turso قبل أي نداء خارجي (حتى لو انقطع الاتصال تبقى قابلة للتتبع)
  const taskId = crypto.randomUUID();
  const input = type === "image" ? buildImageInput(params) : buildVideoInput(params);
  await insertTask({
    id: taskId,
    model: model.canonical,
    type,
    prompt: String(params.prompt).slice(0, 4000),
    params_json: JSON.stringify({ input, wait_seconds: params.wait_seconds }),
    status: "pending",
  });
  let task = (await getTask(taskId))!;

  // 4) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
  const waitSeconds = clampWait(params.wait_seconds, type === "image" ? 90 : 25);
  const created = await createOnBestKey(task, model, type, input, pool, 0);
  if (created.kind === "params_error") {
    task = (await getTask(taskId))!;
    return { kind: "failed", task, message: `❌ فشلت المهمة: ${sanitizeClientMessage(task.error_message)}` };
  }
  if (created.kind === "all_failed") {
    // كل المفاتيح فشلت → تبقى processing برسالة داخلية، وتُعاد المحاولة تلقائيًا مع كل get_task
    await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
    cooldowns.set(taskId, Date.now());
    task = (await getTask(taskId))!;
    return { kind: "processing", task, message: processingMessage(task) };
  }

  if (created.kind === "sync_completed") {
    // صورة متزامنة اكتملت فورًا
    task = (await getTask(taskId))!;
    return { kind: "completed", task, message: completedMessage(task) };
  }

  // 5) نافذة الانتظار مع بث التقدم
  task = (await getTask(taskId))!;
  let boundKey = created.key;
  for (;;) {
    const result = await waitForCompletion(task, boundKey, waitSeconds, opts);
    if (result.kind === "completed") {
      task = (await getTask(taskId))!;
      return { kind: "completed", task, message: completedMessage(task) };
    }
    if (result.kind === "timeout") {
      task = (await getTask(taskId))!;
      return { kind: "processing", task, message: processingMessage(task) };
    }
    // فشل في منتصف المهمة
    task = (await getTask(taskId))!;
    if (!result.keyProblem) {
      // فشل حقيقي (انتهاك سياسة/معطيات) → فشل نهائي
      const updated = await updateTask(taskId, { status: "failed", error_message: result.error || "فشل التوليد لدى المزود" });
      return { kind: "failed", task: updated!, message: `❌ فشلت المهمة: ${sanitizeClientMessage(result.error || "فشل التوليد لدى المزود")}` };
    }
    // مشكلة مفتاح/رصيد → أعد إنشاء نفس المهمة بنفس task_id على المفتاح التالي
    const nextIdx = pool.findIndex((k) => k.id === boundKey.id) + 1;
    if (nextIdx >= pool.length) {
      await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
      cooldowns.set(taskId, Date.now());
      task = (await getTask(taskId))!;
      return { kind: "processing", task, message: processingMessage(task) };
    }
    const recreated = await createOnBestKey(task, model, type, input, pool, nextIdx);
    if (recreated.kind === "params_error") {
      task = (await getTask(taskId))!;
      return { kind: "failed", task, message: `❌ فشلت المهمة: ${sanitizeClientMessage(task.error_message)}` };
    }
    if (recreated.kind === "all_failed") {
      await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
      cooldowns.set(taskId, Date.now());
      task = (await getTask(taskId))!;
      return { kind: "processing", task, message: processingMessage(task) };
    }
    if (recreated.kind === "sync_completed") {
      task = (await getTask(taskId))!;
      return { kind: "completed", task, message: completedMessage(task) };
    }
    boundKey = recreated.key;
    task = (await getTask(taskId))!;
  }
}

// ─── get_task: تحديث حي من المزود + إعادة المحاولة التلقائية ────────

export async function refreshTask(taskId: string, opts: GenOptions = {}): Promise<GenOutcome> {
  let task = await getTask(taskId);
  if (!task) {
    return { kind: "failed", task: {} as TaskRow, message: `❌ لم يتم العثور على مهمة بالمعرّف: ${taskId}. تحقق من task_id واستدعِ get_task مجددًا.` };
  }
  if (task.status === "completed") {
    return { kind: "completed", task, message: completedMessage(task) };
  }
  if (task.status === "failed") {
    return { kind: "failed", task, message: `❌ فشلت المهمة: ${sanitizeClientMessage(task.error_message) || "سبب غير معروف"}` };
  }

  // مهمة دمج → مسارها الخاص
  if (task.type === "merge" || task.provider === "merger") {
    return refreshMergeTask(task, opts);
  }

  // لم تُنشأ بعد على أي مفتاح → أعد المحاولة بعد الهدأة (~45 ثانية)
  if (!task.provider_task_id) {
    const last = cooldowns.get(taskId) || 0;
    if (Date.now() - last < 45_000) {
      return { kind: "processing", task, message: processingMessage(task) };
    }
    cooldowns.set(taskId, Date.now());
    const model = normalizeModel(task.model);
    if (!model) return { kind: "failed", task, message: "❌ موديل غير معروف في هذه المهمة." };
    const pool = await getKeyPool(model.providers);
    if (!pool.length) return { kind: "processing", task, message: processingMessage(task) };
    let input: Record<string, unknown> = {};
    try {
      input = (JSON.parse(task.params_json)?.input ?? {}) as Record<string, unknown>;
    } catch {
      input = {};
    }
    const type = task.type as "image" | "video";
    const created = await createOnBestKey(task, model, type, input, pool, 0);
    if (created.kind === "sync_completed") {
      task = (await getTask(taskId))!;
      return { kind: "completed", task, message: completedMessage(task) };
    }
    if (created.kind === "all_failed" || created.kind === "params_error") {
      if (created.kind === "all_failed") await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
      task = (await getTask(taskId))!;
      return created.kind === "params_error"
        ? { kind: "failed", task, message: `❌ فشلت المهمة: ${sanitizeClientMessage(task.error_message)}` }
        : { kind: "processing", task, message: processingMessage(task) };
    }
    // نجح الإنشاء — تابع إلى الاستعلام الحي أدناه
    task = (await getTask(taskId))!;
  }

  // استعلام حي من المزود بالمفتاح المرتبط (أو أول مفتاح متاح له)
  const adapter = ADAPTERS[task.provider as "kie" | "cometapi"];
  if (!adapter || !task.provider_task_id) {
    return { kind: "processing", task, message: processingMessage(task) };
  }
  const keysMod = await import("./keys");
  let key = await keysMod.getKeyById(task.key_id || "");
  if (!key || key.status === "disabled") {
    const pool = await getKeyPool([task.provider as "kie" | "cometapi"]);
    if (!pool.length) return { kind: "processing", task, message: processingMessage(task) };
    key = pool[0];
  }

  let check: CheckResult;
  try {
    check = await adapter.checkTask(key.api_key, task.provider_task_id);
  } catch (e) {
    const pe = asProviderError(e);
    const cls = classifyProviderError(pe.status, pe.message);
    if (cls === "disabled" || cls === "exhausted") {
      // المفتاح المرتبط رُفض/استُنزف أثناء المتابعة → أنشئ نفس المهمة على المفتاح التالي
      updateKeyStats(key.id, false, { error: pe.message, errorClass: cls });
      setKeyStatus(key.id, cls, pe.message).catch(() => {});
      return await recreateOnNextKey(task, opts);
    }
    return { kind: "processing", task, message: processingMessage(task) };
  }

  if (check.status === "completed" && check.urls?.length) {
    const updated = await updateTask(taskId, { status: "completed", result_urls_json: JSON.stringify(check.urls), progress: 100 });
    return { kind: "completed", task: updated!, message: completedMessage(updated!) };
  }
  if (check.status === "failed") {
    if (isKeyProblem(check.error || "")) {
      return await recreateOnNextKey(task, opts);
    }
    const updated = await updateTask(taskId, { status: "failed", error_message: check.error || "فشل التوليد لدى المزود" });
    return { kind: "failed", task: updated!, message: `❌ فشلت المهمة: ${sanitizeClientMessage(check.error || "فشل التوليد لدى المزود")}` };
  }
  const pct = typeof check.progress === "number" && check.progress > 0 ? Math.min(99, check.progress) : task.progress;
  const updated = await updateTask(taskId, { progress: pct });
  return { kind: "processing", task: updated!, message: processingMessage(updated!) };
}

/** استئناف نفس المهمة بنفس task_id على المفتاح التالي (التبديل الصامت) */
async function recreateOnNextKey(task: TaskRow, opts: GenOptions): Promise<GenOutcome> {
  const model = normalizeModel(task.model);
  if (!model) return { kind: "failed", task, message: "❌ موديل غير معروف في هذه المهمة." };
  const pool = await getKeyPool(model.providers);
  const idx = pool.findIndex((k) => k.id === task.key_id) + 1;
  if (idx >= pool.length) {
    await updateTask(task.id, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
    cooldowns.set(task.id, Date.now());
    return { kind: "processing", task, message: processingMessage(task) };
  }
  let input: Record<string, unknown> = {};
  try {
    input = (JSON.parse(task.params_json)?.input ?? {}) as Record<string, unknown>;
  } catch {
    input = {};
  }
  const type = task.type as "image" | "video";
  const created = await createOnBestKey(task, model, type, input, pool, idx);
  if (created.kind === "sync_completed") {
    const t = (await getTask(task.id))!;
    return { kind: "completed", task: t, message: completedMessage(t) };
  }
  if (created.kind === "created") {
    const t = (await getTask(task.id))!;
    // مهمة جديدة بنفس task_id — سيتابعها العميل بـ get_task
    return { kind: "processing", task: t, message: processingMessage(t) };
  }
  await updateTask(task.id, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
  cooldowns.set(task.id, Date.now());
  const t = (await getTask(task.id))!;
  return { kind: "processing", task: t, message: processingMessage(t) };
}

// ─── runMerge: تدفق أداة merge_videos (spec §7.3) ───────────────────

export async function runMerge(
  params: { urls?: string[]; task_ids?: string[]; wait_seconds?: number },
  opts: GenOptions = {},
): Promise<GenOutcome> {
  const origin = opts.origin || "";
  const failedIds: string[] = [];
  const urls: string[] = [];

  // روابط task_ids أُولًا (لمهام فيديو مكتملة تُحل روابطها من قاعدة البيانات بالترتيب)
  for (const tid of params.task_ids || []) {
    const t = await getTask(tid);
    if (!t || t.status !== "completed") {
      failedIds.push(`${tid} (${!t ? "غير موجودة" : t.status === "failed" ? "فاشلة" : "غير مكتملة"})`);
      continue;
    }
    const u = taskResultUrls(t);
    if (!u.length) {
      failedIds.push(`${tid} (بلا روابط نتيجة)`);
      continue;
    }
    urls.push(u[0]);
  }
  // ثم الروابط المباشرة بنفس ترتيبها
  for (const u of params.urls || []) urls.push(u);

  // قواعد صارمة: ≥2، ≤10، وكلها http/https مباشرة وعامة
  if (urls.length < 2) {
    let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (failedIds.length) msg += ` تفاصيل المعرفات الفاشلة: ${failedIds.join("؛ ")}`;
    return { kind: "failed", task: {} as TaskRow, message: msg };
  }
  if (urls.length > 10) {
    return {
      kind: "failed",
      task: {} as TaskRow,
      message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
    };
  }
  const bad = urls.filter((u) => !/^https?:\/\/\S+$/i.test(u));
  if (bad.length) {
    return {
      kind: "failed",
      task: {} as TaskRow,
      message: `❌ الروابط يجب أن تكون http/https مباشرة وعامة. روابط غير صالحة: ${bad.join("، ")}`,
    };
  }

  // سجّل مهمة الدمج في Turso أولًا
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${urls.length} مقاطع`,
    params_json: JSON.stringify({ urls }),
    status: "pending",
  });
  let task = (await getTask(taskId))!;

  let jobId: string;
  try {
    const job = await createMergeJob(urls.map((u) => ({ kind: "url" as const, url: u })));
    jobId = job.jobId;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateTask(taskId, { status: "failed", error_message: msg });
    return { kind: "failed", task, message: `❌ فشلت المهمة: ${sanitizeClientMessage(msg)}` };
  }
  await updateTask(taskId, { provider: "merger", provider_task_id: jobId, status: "processing" });
  kickProcess(jobId); // خلفيًا وبمرة واحدة فقط (قفل الذاكرة يمنع التزامن)

  // نافذة الانتظار (افتراضي 60 ثانية): استعلام كل 3 ثوانٍ مع بث تقدم
  const waitSeconds = clampWait(params.wait_seconds, 60);
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const st = await getMergeStatus(jobId, origin);
    await updateTask(taskId, { progress: Math.max(0, Math.min(99, st.progress ?? 0)) });
    try {
      await opts.notify?.(Math.max(0, Math.min(99, st.progress ?? 0)), 100, progressMessage("merge", st.progress ?? 0));
    } catch {
      /* اختياري */
    }
    if (st.status === "done" && st.videoUrl) {
      const updated = await updateTask(taskId, {
        status: "completed",
        result_urls_json: JSON.stringify([st.videoUrl]),
        progress: 100,
      });
      return { kind: "completed", task: updated!, message: completedMessage(updated!) };
    }
    if (st.status === "failed") {
      // أي خطأ HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
      const updated = await updateTask(taskId, { status: "failed", error_message: st.error || "فشل الدمج" });
      return { kind: "failed", task: updated!, message: `❌ فشلت المهمة: ${sanitizeClientMessage(st.error || "فشل الدمج")}` };
    }
  }
  task = (await getTask(taskId))!;
  return { kind: "processing", task, message: processingMessage(task) };
}

/** get_task لمهمة دمج: حدّث من الخدمة؛ إن كانت قيد المعالجة ولم يُنفَّذ process فنفّذه الآن */
export async function refreshMergeTask(task: TaskRow, opts: GenOptions = {}): Promise<GenOutcome> {
  const origin = opts.origin || "";
  const jobId = task.provider_task_id;
  if (!jobId) return { kind: "failed", task, message: "❌ مهمة الدمج بلا معرّف خدمة — أعد إنشاء المهمة." };
  const st = await getMergeStatus(jobId, origin);
  if (st.status === "not_found" || st.status === "failed") {
    const updated = await updateTask(task.id, { status: "failed", error_message: st.error || "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" });
    return { kind: "failed", task: updated!, message: `❌ فشلت المهمة: ${sanitizeClientMessage(st.error) || "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)"}` };
  }
  if (st.status === "done" && st.videoUrl) {
    const updated = await updateTask(task.id, { status: "completed", result_urls_json: JSON.stringify([st.videoUrl]), progress: 100 });
    return { kind: "completed", task: updated!, message: completedMessage(updated!) };
  }
  // قيد المعالجة: أعد إطلاق process عند الحاجة (هدأة 45 ثانية بين المحاولات)
  const lastKick = mergeKicks.get(jobId) || 0;
  if (Date.now() - lastKick > 45_000) {
    mergeKicks.set(jobId, Date.now());
    await ensureProcessRunning(jobId);
  }
  const updated = await updateTask(task.id, { progress: Math.max(0, Math.min(99, st.progress ?? 0)) });
  return { kind: "processing", task: updated!, message: processingMessage(updated!) };
}

// ─── صياغة الردود العربية (spec §8) ────────────────────────────────

function clampWait(v: unknown, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(240, Math.round(n)));
}

export function processingMessage(task: TaskRow): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${task.id}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

export function completedMessage(task: TaskRow): string {
  const urls = taskResultUrls(task);
  const lines: string[] = [];
  if (task.type === "image") lines.push("✅ تم توليد الصورة بنجاح");
  else if (task.type === "merge") lines.push("✅ تم دمج المقاطع بنجاح");
  else lines.push("✅ تم توليد الفيديو بنجاح");
  for (const u of urls) {
    if (task.type === "image") lines.push(`![image](${u})`);
    lines.push(`الرابط المباشر: ${u}`);
  }
  if (task.type === "merge") {
    lines.push("⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.");
  }
  return lines.join("\n");
}
