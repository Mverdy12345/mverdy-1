import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // دليل بناء بديل للتحقق من الإنتاج دون تعطيل خادم التطوير
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // تضمين ثنائيات ffmpeg/ffprobe في دالة الدمج على Vercel (إلزامي لتشغيل الدمج serverless)
  outputFileTracingIncludes: {
    "/api/jobs/[id]/process": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffprobe-static/bin/linux/x64/ffprobe",
      "./node_modules/ffprobe-static/bin/linux/arm64/ffprobe",
    ],
    "/mcp": ["./node_modules/ffmpeg-static/ffmpeg", "./node_modules/ffprobe-static/bin/linux/x64/ffprobe"],
  },
};

export default nextConfig;
