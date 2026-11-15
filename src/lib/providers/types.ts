// واجهة المزودات الموحدة — كل خطأ يُرمى كـ ProviderError ليُصنَّف لاحقًا في classifyProviderError
import type { MediaType } from "../models";

export interface ProviderError {
  status?: number;
  message: string;
}

export function asProviderError(e: unknown): ProviderError {
  if (e instanceof Error) {
    return { status: (e as Error & { status?: number }).status, message: e.message };
  }
  return { message: String(e) };
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو وبعض الصور): تعيد providerTaskId */
  createTask(apiKey: string, providerModel: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا) */
  createImageSync?(apiKey: string, providerModel: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(apiKey: string, providerTaskId: string): Promise<CheckResult>;
  /** نوع الإرجاع للصور — يستخدمه المنسّق ليقرر createImageSync أم createTask */
  imageMode?: "sync" | "async";
}

/** نداء fetch مع مهلة */
export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<{ status: number; body: string; json: unknown }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), init.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return { status: res.status, body, json };
  } finally {
    clearTimeout(t);
  }
}

export function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}
