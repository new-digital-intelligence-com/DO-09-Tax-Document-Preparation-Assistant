import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DO-09 Tax Document Preparation Assistant",
  description:
    "Collect, sort and reconcile tax documents, pre-fill draft forms, and hand a review-ready package to a person. Nothing here files anything.",
};

/**
 * `children` is typed explicitly rather than with Next's generated
 * `LayoutProps<"/">`: that type only exists once `.next/types` has been
 * written, so a clean checkout fails `tsc --noEmit` before it has ever been
 * built. A type that depends on a build artefact is a type that breaks CI.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
