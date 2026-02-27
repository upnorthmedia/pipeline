import { render, type RenderOptions } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReactElement } from "react";

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider delayDuration={0}>{children}</TooltipProvider>;
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">
) {
  return render(ui, { wrapper: Wrapper, ...options });
}
