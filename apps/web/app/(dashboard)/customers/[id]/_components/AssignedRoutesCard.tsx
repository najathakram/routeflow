"use client";

import * as React from "react";
import { Plus, Route } from "lucide-react";
import { Button, Card, cn } from "@routeflow/ui/web";

/** The customer's standing-route assignments (a recurring-routes surface: the page hides it, and never
 *  fetches its data, for an account with no fleet module). `canAssign` = the routes add-on is held. */
export function AssignedRoutesCard({
  routes,
  canAssign,
  onAssign,
}: {
  routes: Array<{
    id: string;
    name: string;
    driverName?: string | null;
    isActive?: boolean;
  }>;
  canAssign: boolean;
  onAssign: () => void;
}) {
  return (
    <Card title="Assigned Routes">
      <div className="space-y-3">
        {routes.length === 0 ? (
          <p className="text-sm text-navy/70">Not assigned to any routes yet.</p>
        ) : (
          <ul className="-mx-6 divide-y divide-surface-border">
            {routes.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-6 py-3">
                <Route className="h-4 w-4 shrink-0 text-navy/70" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-navy">{r.name}</p>
                  {r.driverName && <p className="text-xs text-navy/70">Driver: {r.driverName}</p>}
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                    r.isActive ? "bg-success-bg text-success" : "bg-surface-raised text-navy/70",
                  )}
                >
                  {r.isActive ? "Active" : "Inactive"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canAssign && (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={onAssign}
          >
            Assign to Route
          </Button>
        )}
      </div>
    </Card>
  );
}
