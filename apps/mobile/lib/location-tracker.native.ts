import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { apiClient } from "./api-client";

const TASK_NAME = "routeflow.driver-location";
let activeRunId: string | null = null;

interface LocationPayload {
  lat: number;
  lng: number;
  heading?: number | null;
  speedKph?: number | null;
  recordedAt: string;
  runId?: string | null;
}

async function postLocation(payload: LocationPayload): Promise<void> {
  try {
    await apiClient.post("/drivers/me/location", payload);
  } catch {
    // Silent — telemetry failures should not surface to the driver. The
    // server is the source of truth; we'll catch up on the next sample.
  }
}

if (!TaskManager.isTaskDefined(TASK_NAME)) {
  TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
    if (error) return;
    const payload = data as { locations?: Location.LocationObject[] };
    const sample = payload?.locations?.[payload.locations.length - 1];
    if (!sample) return;
    await postLocation({
      lat: sample.coords.latitude,
      lng: sample.coords.longitude,
      heading: sample.coords.heading ?? null,
      speedKph: sample.coords.speed != null ? sample.coords.speed * 3.6 : null,
      recordedAt: new Date(sample.timestamp).toISOString(),
      runId: activeRunId,
    });
  });
}

export interface StartTrackingResult {
  ok: boolean;
  reason?: "platform" | "permission";
}

export async function startLocationTracking(runId: string): Promise<StartTrackingResult> {
  activeRunId = runId;

  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return { ok: false, reason: "permission" };

  const bg = await Location.requestBackgroundPermissionsAsync();
  // On Android in particular, background permission may be denied — we still
  // run the foreground updates so the live map gets sparse data while the app
  // is open.

  const already = await Location.hasStartedLocationUpdatesAsync(TASK_NAME);
  if (!already) {
    await Location.startLocationUpdatesAsync(TASK_NAME, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 30_000,
      distanceInterval: 50,
      pausesUpdatesAutomatically: true,
      showsBackgroundLocationIndicator: bg.status === "granted",
      foregroundService: {
        notificationTitle: "RouteFlow",
        notificationBody: "Sharing your location while you deliver.",
      },
    });
  }

  try {
    const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    await postLocation({
      lat: current.coords.latitude,
      lng: current.coords.longitude,
      heading: current.coords.heading ?? null,
      speedKph: current.coords.speed != null ? current.coords.speed * 3.6 : null,
      recordedAt: new Date(current.timestamp).toISOString(),
      runId,
    });
  } catch {
    // best-effort
  }

  return { ok: true };
}

export async function stopLocationTracking(): Promise<void> {
  activeRunId = null;
  try {
    const running = await Location.hasStartedLocationUpdatesAsync(TASK_NAME);
    if (running) await Location.stopLocationUpdatesAsync(TASK_NAME);
  } catch {
    // ignore
  }
}

export async function isTracking(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(TASK_NAME);
  } catch {
    return false;
  }
}
