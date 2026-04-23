import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Zinventory",
  description: "Zinventory frontend",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}