export interface BuyerJwtPayload {
  sub: string; // BuyerAccount.id
  email: string;
  name: string; // BuyerAccount.name — included for mobile convenience
  type: "BUYER"; // Discriminator — existing tenant JWTs have no 'type' field
  // Whether the account has a usable password (false = Google auto-created).
  // Rendering hint only — GET /buyer/auth/profile is the authoritative read.
  hasPassword?: boolean;
  impersonatedBy?: string; // SA impersonation
}
