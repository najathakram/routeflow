import { CARRIERS, carrierLabel, getTrackingUrl, normalizeCarrier } from "./shipping";

describe("shipping helpers", () => {
  describe("normalizeCarrier", () => {
    it("maps known carrier labels (case-insensitive) to ids", () => {
      expect(normalizeCarrier("UPS")).toBe("ups");
      expect(normalizeCarrier("ups")).toBe("ups");
      expect(normalizeCarrier("FedEx")).toBe("fedex");
      expect(normalizeCarrier("fed ex")).toBe("fedex");
      expect(normalizeCarrier("USPS")).toBe("usps");
      expect(normalizeCarrier("DHL")).toBe("dhl");
    });

    it("never resolves USPS to UPS (substring trap)", () => {
      expect(normalizeCarrier("USPS")).toBe("usps");
      expect(normalizeCarrier("usps")).not.toBe("ups");
    });

    it("returns null for unknown / Other / blank", () => {
      expect(normalizeCarrier("Other")).toBeNull();
      expect(normalizeCarrier("Royal Mail")).toBeNull();
      expect(normalizeCarrier("")).toBeNull();
      expect(normalizeCarrier(null)).toBeNull();
      expect(normalizeCarrier(undefined)).toBeNull();
    });
  });

  describe("getTrackingUrl", () => {
    it("builds a carrier tracking URL with the encoded number", () => {
      expect(getTrackingUrl("UPS", "1Z999AA10123456784")).toBe(
        "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784",
      );
      expect(getTrackingUrl("FedEx", "123456789012")).toBe(
        "https://www.fedex.com/fedextrack/?trknbr=123456789012",
      );
      expect(getTrackingUrl("USPS", "9400 1000")).toContain("tLabels=9400%201000");
    });

    it("returns null when carrier is unknown or number is blank", () => {
      expect(getTrackingUrl("Other", "ABC123")).toBeNull();
      expect(getTrackingUrl("UPS", "")).toBeNull();
      expect(getTrackingUrl("UPS", null)).toBeNull();
      expect(getTrackingUrl(null, "ABC123")).toBeNull();
    });
  });

  describe("carrierLabel", () => {
    it("returns the canonical label for known carriers and echoes unknowns", () => {
      expect(carrierLabel("ups")).toBe("UPS");
      expect(carrierLabel("FEDEX")).toBe("FedEx");
      expect(carrierLabel("Royal Mail")).toBe("Royal Mail");
      expect(carrierLabel("")).toBe("");
    });
  });

  it("offers Other plus the four linkable carriers", () => {
    expect(CARRIERS.map((c) => c.id)).toEqual(["ups", "fedex", "usps", "dhl", "other"]);
  });
});
