export interface BuyerJwtPayload {
  sub: string;       // BuyerAccount.id
  email: string;
  name: string;      // BuyerAccount.name — included for mobile convenience
  type: "BUYER";     // Discriminator — existing tenant JWTs have no 'type' field
  impersonatedBy?: string; // SA impersonation
}
