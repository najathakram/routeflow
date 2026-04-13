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
 * Public proxy for address autocomplete.
 *
 * Uses the Mapbox Geocoding API v5 — no API key restrictions, excellent US
 * residential address coverage. Results are restricted to US addresses.
 *
 * The autocomplete response embeds full address parts (street/city/state/zip)
 * so the frontend never needs a separate details round-trip.
 */
@ApiTags("public/places")
@Controller("public/places")
export class PublicPlacesController {
  private readonly logger = new Logger(PublicPlacesController.name);
  private readonly accessToken: string;

  constructor(private readonly config: ConfigService<AppConfig>) {
    this.accessToken = this.config.get<AppConfig["mapbox"]>("mapbox")!.accessToken;
  }

  // ─── Address autocomplete ─────────────────────────────────────────────────

  @Get("autocomplete")
  @ApiOperation({ summary: "Autocomplete a US address via Mapbox Geocoding API" })
  @Throttle({ default: { ttl: 1_000, limit: 10 } })
  async autocomplete(@Query("q") q: string) {
    if (!q || q.trim().length < 3) {
      return { suggestions: [] };
    }
    if (!this.accessToken) {
      throw new InternalServerErrorException("Mapbox access token not configured");
    }

    const url = new URL(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q.trim())}.json`,
    );
    url.searchParams.set("access_token", this.accessToken);
    url.searchParams.set("types", "address");
    url.searchParams.set("country", "us");
    url.searchParams.set("limit", "5");
    url.searchParams.set("autocomplete", "true");
    url.searchParams.set("language", "en");

    const res = await fetch(url.toString());

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      this.logger.error(`Mapbox autocomplete HTTP error: ${res.status} ${err}`);
      throw new InternalServerErrorException(`Mapbox API error: ${res.status}`);
    }

    const data = (await res.json()) as {
      features?: Array<{
        id: string;
        place_name: string;
        text: string;        // street name
        address?: string;    // house number
        context?: Array<{
          id: string;
          text: string;
          short_code?: string;
        }>;
      }>;
    };

    const suggestions = (data.features ?? []).map((f) => {
      // Build street: "4506 Selwyn Rd"
      const street = f.address ? `${f.address} ${f.text}` : f.text;

      // Parse context for city / state / zip
      const postcode = f.context?.find((c) => c.id.startsWith("postcode."))?.text ?? "";
      const city =
        f.context?.find((c) => c.id.startsWith("place."))?.text ??
        f.context?.find((c) => c.id.startsWith("locality."))?.text ??
        "";
      // short_code is e.g. "US-TX" — strip the "US-" prefix
      const rawState = f.context?.find((c) => c.id.startsWith("region."));
      const state = rawState?.short_code?.replace(/^US-/i, "") ?? rawState?.text ?? "";

      const secondaryText = [city, state, postcode].filter(Boolean).join(", ");

      return {
        placeId: f.id,
        display: f.place_name,
        mainText: street,
        secondaryText,
        // Embed full address parts so the frontend never needs a details call
        addressParts: { street, city, state, zip: postcode },
      };
    });

    return { suggestions };
  }

  // ─── Place details (kept for API compatibility) ───────────────────────────

  @Get("details")
  @ApiOperation({ summary: "Get address components for a place ID (Mapbox)" })
  @Throttle({ default: { ttl: 1_000, limit: 10 } })
  async details(@Query("placeId") placeId: string) {
    if (!placeId) throw new BadRequestException("placeId is required");
    if (!this.accessToken) {
      throw new InternalServerErrorException("Mapbox access token not configured");
    }

    // Mapbox feature IDs can be used directly in the geocoding endpoint
    const url = new URL(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(placeId)}.json`,
    );
    url.searchParams.set("access_token", this.accessToken);

    const res = await fetch(url.toString());

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      this.logger.error(`Mapbox details HTTP error: ${res.status} ${err}`);
      throw new InternalServerErrorException(`Mapbox API error: ${res.status}`);
    }

    const data = (await res.json()) as {
      features?: Array<{
        text: string;
        address?: string;
        context?: Array<{ id: string; text: string; short_code?: string }>;
      }>;
    };

    const f = data.features?.[0];
    if (!f) throw new BadRequestException("Place not found");

    const street = f.address ? `${f.address} ${f.text}` : f.text;
    const postcode = f.context?.find((c) => c.id.startsWith("postcode."))?.text ?? "";
    const city =
      f.context?.find((c) => c.id.startsWith("place."))?.text ??
      f.context?.find((c) => c.id.startsWith("locality."))?.text ??
      "";
    const rawState = f.context?.find((c) => c.id.startsWith("region."));
    const state = rawState?.short_code?.replace(/^US-/i, "") ?? rawState?.text ?? "";

    return { street, city, state, zip: postcode };
  }
}
