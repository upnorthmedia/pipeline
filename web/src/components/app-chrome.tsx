"use client";

import { usePathname } from "next/navigation";
import { Sidebar, MobileSidebar } from "@/components/sidebar";

/** The routes a visitor with no session can reach, per `src/proxy.ts`. */
const SIGNED_OUT_ROUTE = "/auth";

const isSignedOutRoute = (pathname: string | null) =>
  pathname === SIGNED_OUT_ROUTE || (pathname?.startsWith(`${SIGNED_OUT_ROUTE}/`) ?? false);

/**
 * The app's navigation frame: the sidebar, the mobile header and the main
 * column every signed-in route renders into.
 *
 * `/auth/*` gets the page on its own. Those routes are the only ones a visitor
 * without a session can be on, and every destination this frame names bounces
 * straight back to them, so drawing it there would put four dead controls on
 * the first screen of the product.
 */
export const AppChrome = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname();

  if (isSignedOutRoute(pathname)) {
    return <>{children}</>;
  }

  return (
    <>
      <Sidebar />
      <div className="md:pl-56">
        {/* Mobile header */}
        <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b border-border bg-background/80 px-4 backdrop-blur-sm md:hidden">
          <MobileSidebar />
          <span className="text-sm font-semibold">Content Crew</span>
        </header>

        <main className="min-h-[calc(100vh-3.5rem)] md:min-h-screen">
          {children}
        </main>
      </div>
    </>
  );
};
