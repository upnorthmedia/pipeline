"use client";

import { BarChart3, DollarSign, Cpu, ScrollText } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { OverviewTab } from "./_components/overview-tab";
import { CostsTab } from "./_components/costs-tab";
import { ModelsTab } from "./_components/models-tab";
import { LogsTab } from "./_components/logs-tab";

export default function MonitorPage() {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Observability
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pipeline analytics, costs, model performance, and logs
        </p>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview">
        <TabsList variant="line">
          <TabsTrigger value="overview" className="gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="costs" className="gap-1.5">
            <DollarSign className="h-3.5 w-3.5" />
            Costs
          </TabsTrigger>
          <TabsTrigger value="models" className="gap-1.5">
            <Cpu className="h-3.5 w-3.5" />
            Models
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-1.5">
            <ScrollText className="h-3.5 w-3.5" />
            Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab />
        </TabsContent>

        <TabsContent value="costs" className="mt-6">
          <CostsTab />
        </TabsContent>

        <TabsContent value="models" className="mt-6">
          <ModelsTab />
        </TabsContent>

        <TabsContent value="logs" className="mt-6">
          <LogsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
