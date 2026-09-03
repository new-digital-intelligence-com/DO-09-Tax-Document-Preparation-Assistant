import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Hide the floating Next.js dev badge.
   *
   * This console is read side by side with a rendered PDF, and the indicator
   * sits in the corner over that pane. Compile and runtime errors are still
   * surfaced — only the badge goes.
   */
  devIndicators: false,
};

export default nextConfig;
