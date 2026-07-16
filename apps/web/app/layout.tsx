import type { Metadata } from "next";
import { Geist_Mono, Noto_Sans_SC } from "next/font/google";
import { colorThemeBootstrapScript } from "@/app/components/theme-preferences";
import "./globals.css";

const notoSansSc = Noto_Sans_SC({
  variable: "--font-noto-sans-sc",
  display: "swap",
  preload: false,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Asuka Agent",
  description: "可追溯、支持 IM Channel 与长期认知审计的持续型聊天 Agent。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: colorThemeBootstrapScript }} />
      </head>
      <body
        className={`${notoSansSc.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
