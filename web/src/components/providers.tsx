"use client";

import dynamic from "next/dynamic";
import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { GlobalNotifications } from "@/components/global-notifications";

const AuthUIProvider = dynamic(
  () =>
    import("@daveyplate/better-auth-ui").then((mod) => mod.AuthUIProvider),
  { ssr: false }
);

export const Providers = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();

  return (
    <AuthUIProvider
      authClient={authClient}
      navigate={router.push}
      replace={router.replace}
      onSessionChange={() => router.refresh()}
      Link={Link}
    >
      <TooltipProvider delayDuration={300}>
        {children}
        <GlobalNotifications />
        <Toaster
          position="bottom-right"
          toastOptions={{
            className: "font-mono text-xs",
          }}
        />
      </TooltipProvider>
    </AuthUIProvider>
  );
};
