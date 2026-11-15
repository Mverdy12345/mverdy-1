import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";

// خط عربي جيد للواجهة RTL
const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "M-Verdy — مولّد الوسائط بالذكاء الاصطناعي (MCP)",
  description:
    "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — لوحة إدارة عربية، مفاتيح متسلسلة مع تبديل تلقائي، جاهز لـ Vercel.",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" className="dark" suppressHydrationWarning>
      <body className={`${cairo.variable} antialiased bg-[#0b0f1a] text-slate-100 min-h-screen`} style={{ fontFamily: "var(--font-cairo), system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
