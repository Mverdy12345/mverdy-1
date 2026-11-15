// سجل الموديلات — الموديلان المدمجان مثبّتان كما هما، مع قبول الصيغ البديلة بالنقاط
// والأسماء قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL وغيرها)
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

function envOverride(envName: string, fallback: string): string {
  const v = process.env[envName];
  return v && v.trim() ? v.trim() : fallback;
}

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2-6-flare-text-to-image", "gpt-image-2.6-flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOverride("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image"),
      cometapi: envOverride("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image"),
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview", "grok-imagine-video-1-5", "grok-imagine-video-1.5"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOverride("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
      cometapi: envOverride("COMETAPI_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
    },
  },
];

/** توحيد اسم الموديل عبر canonical + aliases — غير معروف → null (خطأ معطيات) */
export function normalizeModel(name?: string | null): ModelDef | null {
  if (!name) return MODELS[0]; // الافتراضي: موديل الصور
  const norm = (s: string) => s.trim().toLowerCase().replace(/_/g, "-");
  const target = norm(name);
  for (const m of MODELS) {
    if (norm(m.canonical) === target) return m;
    if (m.aliases.some((a) => norm(a) === target)) return m;
  }
  return null;
}

export function modelByType(type: MediaType): ModelDef | undefined {
  return MODELS.find((m) => m.type === type);
}
