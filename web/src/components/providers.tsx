"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { GlobalNotifications } from "@/components/global-notifications";

export const Providers = ({ children }: { children: React.ReactNode }) => {
  return (
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
  );
};
