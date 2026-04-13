import {
  Controller,
  Get,
  Query,
  BadRequestException,
  InternalServerErrorException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";

/**
 * Public proxy for the Google Places API (New).
 *
 * Why proxy? The legacy AutocompleteService JS API requires the "Legacy"
 * Places API to be enabled, but many projects now only have "Places API (New)"
 * enabled. This controller proxies requests server-side so we use the REST
 * endpoint (Places API New), keeping the API key secure and avoiding CORS.
 */
@ApiTags("public/places")
@Controller("public/places")
export class PublicPlacesController {
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService<AppConfig>) {
    this.apiKey = this.config.get<AppConfig["googleMaps"]>("googleMaps")!.apiKey;
  }

  // ─── Address autocomplete ─────────────────────────────────────────────────

  @Get("autocomplete")
  @ApiOperation({ summary: "Autocomplete a US address via Google Places API (New)" })
  @Throttle({ default: { ttl: 1_000, limit: 10 } }) // 10 req/sec per IP
  async autocomplete(@Query("q") q: string) {
    if (!q || q.trim().length < 3) {
      return { suggestions: [] };
    }
    if (!this.apiKey) {
      throw new InternalServerErrorException("Google Maps API key not configured");
    }

    const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask":
          "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
      },
      body: JSON.stringify({
        input: q.trim(),
        includedRegionCodes: ["us"],
        includedPrimaryTypes: ["address"],
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new InternalServerErrorException(`Places API error: ${res.status} ${err}`);
    }

    const data = (await res.json()) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId?: string;
          text?: { text?: string };
          structuredFormat?: {
            mainText?: { text?: string };
            secondaryText?: { text?: string };
          };
        };
      }>;
    };

    const suggestions = (data.suggestions ?? [])
      .map((s) => {
        const p = s.placePrediction;
        if (!p?.placeId) return null;
        return {
          placeId: p.placeId,
          display: p.text?.text ?? "",
          mainText: p.structuredFormat?.mainText?.text ?? "",
          secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
        };
      })
      .filter(Boolean);

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

    const res = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": "addressComponents",
        },
      },
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new InternalServerErrorException(`Places API error: ${res.status} ${err}`);
    }

    const data = (await res.json()) as {
      addressComponents?: Array<{
        longText?: string;
        shortText?: string;
        types?: string[];
      }>;
    };

    const get = (type: string): string =>
      data.addressComponents?.find((c) => c.types?.includes(type))?.shortText ?? "";

    const streetNumber = get("street_number");
    const route = get("route");
    const street = streetNumber ? `${streetNumber} ${route}` : route;
    const city = get("locality") || get("sublocality") || get("neighborhood");
    const state = get("administrative_area_level_1");
    const zip = get("postal_code");

    return { street, city, state, zip };
  }
}
