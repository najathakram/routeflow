import {
  Controller,
  Get,
  Query,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";

/**
 * Public proxy for the Google Places API.
 *
 * Uses the legacy Places API REST endpoint (maps.googleapis.com) rather than
 * the newer places.googleapis.com endpoint, because the API key in use has
 * "API restrictions" that allow maps.googleapis.com (already used by Geocoding)
 * but block places.googleapis.com.
 *
 * Legacy docs: https://developers.google.com/maps/documentation/places/web-service/autocomplete
 */
@ApiTags("public/places")
@Controller("public/places")
export class PublicPlacesController {
  private readonly logger = new Logger(PublicPlacesController.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService<AppConfig>) {
    this.apiKey = this.config.get<AppConfig["googleMaps"]>("googleMaps")!.apiKey;
  }

  // ─── Address autocomplete ─────────────────────────────────────────────────

  @Get("autocomplete")
  @ApiOperation({ summary: "Autocomplete a US address via Google Places API" })
  @Throttle({ default: { ttl: 1_000, limit: 10 } }) // 10 req/sec per IP
  async autocomplete(@Query("q") q: string) {
    if (!q || q.trim().length < 3) {
      return { suggestions: [] };
    }
    if (!this.apiKey) {
      throw new InternalServerErrorException("Google Maps API key not configured");
    }

    const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
    url.searchParams.set("input", q.trim());
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("components", "country:us");
    url.searchParams.set("types", "address");
    url.searchParams.set("language", "en");

    const res = await fetch(url.toString());

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      this.logger.error(`Places autocomplete HTTP error: ${res.status} ${err}`);
      throw new InternalServerErrorException(`Places API error: ${res.status}`);
    }

    const data = (await res.json()) as {
      status: string;
      error_message?: string;
      predictions?: Array<{
        place_id: string;
        description: string;
        structured_formatting?: {
          main_text?: string;
          secondary_text?: string;
        };
      }>;
    };

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      this.logger.error(`Places autocomplete API error: ${data.status} — ${data.error_message ?? ""}`);
      throw new InternalServerErrorException(
        `Places API error: ${data.status}${data.error_message ? " — " + data.error_message : ""}`,
      );
    }

    const suggestions = (data.predictions ?? []).slice(0, 5).map((p) => ({
      placeId: p.place_id,
      display: p.description,
      mainText: p.structured_formatting?.main_text ?? p.description,
      secondaryText: p.structured_formatting?.secondary_text ?? "",
    }));

    return { suggestions };
  }

  // ─── Place details (address components) ──────────────────────────────────

  @Get("details")
  @ApiOperation({ summary: "Get address components for a place ID" })
  @Throttle({ default: { ttl: 1_000, limit: 10 } })
  async details(@Query("placeId") placeId: string) {
    if (!placeId) throw new BadRequestException("placeId is required");
    if (!this.apiKey) {
      throw new InternalServerErrorException("Google Maps API key not configured");
    }

    const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
    url.searchParams.set("place_id", placeId);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("fields", "address_component");

    const res = await fetch(url.toString());

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      this.logger.error(`Places details HTTP error: ${res.status} ${err}`);
      throw new InternalServerErrorException(`Places API error: ${res.status}`);
    }

    const data = (await res.json()) as {
      status: string;
      error_message?: string;
      result?: {
        address_components?: Array<{
          long_name: string;
          short_name: string;
          types: string[];
        }>;
      };
    };

    if (data.status !== "OK") {
      this.logger.error(`Places details API error: ${data.status} — ${data.error_message ?? ""}`);
      throw new InternalServerErrorException(
        `Places API error: ${data.status}${data.error_message ? " — " + data.error_message : ""}`,
      );
    }

    const get = (type: string): string =>
      data.result?.address_components?.find((c) => c.types.includes(type))?.short_name ?? "";

    const streetNumber = get("street_number");
    const route = get("route");
    const street = streetNumber ? `${streetNumber} ${route}` : route;
    const city = get("locality") || get("sublocality") || get("neighborhood");
    const state = get("administrative_area_level_1");
    const zip = get("postal_code");

    return { street, city, state, zip };
  }
}
