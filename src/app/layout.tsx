import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cleaning Autopilot",
  description: "Operations automation for a Belgrade cleaning service.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
