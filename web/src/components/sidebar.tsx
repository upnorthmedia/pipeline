"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileText,
  Globe,
  ListChecks,
  Activity,
  Settings,
  PenTool,
  Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { useState } from "react";

const NAV_ITEMS = [
  { href: "/", label: "Posts", icon: FileText },
  { href: "/profiles", label: "Profiles", icon: Globe },
  { href: "/queue", label: "Queue", icon: ListChecks },
  { href: "/monitor", label: "Monitor", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
];

const NavLink = ({
  href,
  label,
  icon: Icon,
  active,
  onClick,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClick?: () => void;
}) => (
  <Link
    href={href}
    onClick={onClick}
    className={cn(
      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
      active
        ? "bg-accent text-accent-foreground"
        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
    )}
  >
    <Icon className="h-4 w-4 shrink-0" />
    {label}
  </Link>
);

const SidebarContent = ({ onNavigate }: { onNavigate?: () => void }) => {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary">
          <PenTool className="h-4 w-4 text-primary-foreground" />
        </div>
        <div>
          <h1 className="text-sm font-semibold tracking-tight">Pipeline</h1>
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Content Engine
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);

          return (
            <NavLink
              key={item.href}
              {...item}
              active={isActive}
              onClick={onNavigate}
            />
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-border px-4 py-3">
        <p className="text-[10px] font-mono text-muted-foreground/60">
          v0.1.0
        </p>
      </div>
    </div>
  );
};

export const Sidebar = () => {
  return (
    <aside className="hidden md:flex md:w-56 md:flex-col md:fixed md:inset-y-0 border-r border-border bg-card">
      <SidebarContent />
    </aside>
  );
};

export const MobileSidebar = () => {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden">
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-56 p-0">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarContent onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
};
