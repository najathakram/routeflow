"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button, Card, Input, useToast } from "@routeflow/ui/web";
import { useRouteSettings, useUpdateRouteSettings } from "@/lib/api/routes";

/**
 * Route defaults: service time, start time, average speed and the depot pin.
 * Validation mirrors the API (service 0-120, speed 1-200, HH:MM, lat/lng in
 * range and set together or not at all). Operators and admins may save.
 */
type Form = { service: string; start: string; speed: string; lat: string; lng: string };
type Errors = Partial<Record<keyof Form, string>>;

const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

function validate(f: Form): Errors {
  const e: Errors = {};
  const svc = numOrNull(f.service);
  if (svc === null || !Number.isInteger(svc) || svc < 0 || svc > 120)
    e.service = "Enter whole minutes between 0 and 120.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.start)) e.start = "Use HH:MM, 24-hour (e.g. 08:00).";
  const spd = numOrNull(f.speed);
  if (spd === null || !Number.isFinite(spd) || spd < 1 || spd > 200)
    e.speed = "Enter a speed between 1 and 200 km/h.";
  const lat = numOrNull(f.lat);
  const lng = numOrNull(f.lng);
  if ((lat === null) !== (lng === null)) {
    const msg = "Set both latitude and longitude, or leave both blank.";
    if (lat === null) e.lat = msg;
    else e.lng = msg;
  }
  if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90))
    e.lat = "Latitude must be between -90 and 90.";
  if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))
    e.lng = "Longitude must be between -180 and 180.";
  return e;
}

function depotContext(data?: {
  depotLat?: number | null;
  depotLng?: number | null;
  depotAddress?: string | null;
}): string {
  // Routing uses the saved coordinates first; GET always fills depotAddress from the business
  // address, so the address is only the honest answer when no depot is saved.
  if (data?.depotLat != null && data?.depotLng != null)
    return `Routes currently start from ${data.depotLat}, ${data.depotLng}.`;
  if (data?.depotAddress) return `Routes currently start from ${data.depotAddress}.`;
  return "No depot is set yet.";
}

export function RouteDefaultsCard() {
  const { toast } = useToast();
  const { data, isLoading, isError, refetch } = useRouteSettings();
  const update = useUpdateRouteSettings();
  const [form, setForm] = React.useState<Form>({
    service: "",
    start: "",
    speed: "",
    lat: "",
    lng: "",
  });
  const [errors, setErrors] = React.useState<Errors>({});

  React.useEffect(() => {
    if (!data) return;
    setForm({
      service: String(data.serviceTimeMinutes),
      start: data.defaultStartTime,
      speed: String(data.averageSpeedKmh),
      // The depot inputs stay blank: GET may return a cached geocode of the business
      // address, which must not look like something the user typed.
      lat: "",
      lng: "",
    });
  }, [data]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function onSave() {
    const errs = validate(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const lat = numOrNull(form.lat);
    const lng = numOrNull(form.lng);
    update.mutate(
      {
        serviceTimeMinutes: Number(form.service),
        defaultStartTime: form.start,
        averageSpeedKmh: Number(form.speed),
        ...(lat !== null && lng !== null ? { depotLat: lat, depotLng: lng } : {}),
      },
      {
        onSuccess: () => toast({ variant: "success", title: "Route defaults saved" }),
        onError: () => toast({ variant: "error", title: "Couldn't save route defaults" }),
      },
    );
  }

  return (
    <Card title="Route defaults">
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-navy/60">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : isError ? (
        <div className="flex items-center justify-between gap-3 text-sm text-navy/70">
          <span>Couldn&apos;t load route defaults.</span>
          <Button variant="secondary" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Service time per stop (min)"
              type="number"
              inputMode="numeric"
              value={form.service}
              onChange={set("service")}
              error={errors.service}
            />
            <Input
              label="Default start time"
              value={form.start}
              onChange={set("start")}
              placeholder="08:00"
              error={errors.start}
            />
            <Input
              label="Average speed (km/h)"
              type="number"
              inputMode="decimal"
              value={form.speed}
              onChange={set("speed")}
              error={errors.speed}
            />
          </div>
          <p className="text-xs text-navy/60">
            {depotContext(data)} Enter both coordinates to change it; leave both blank to keep it as
            is (it can&apos;t be cleared here yet).
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Depot latitude"
              type="number"
              inputMode="decimal"
              value={form.lat}
              onChange={set("lat")}
              placeholder="Not set"
              error={errors.lat}
            />
            <Input
              label="Depot longitude"
              type="number"
              inputMode="decimal"
              value={form.lng}
              onChange={set("lng")}
              placeholder="Not set"
              error={errors.lng}
            />
          </div>
          <Button onClick={onSave} loading={update.isPending}>
            Save route defaults
          </Button>
        </div>
      )}
    </Card>
  );
}
