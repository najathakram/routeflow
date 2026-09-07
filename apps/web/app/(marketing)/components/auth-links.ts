// The four auth entry points the marketing chrome links to (header sign-in
// menu, mobile sheet, footer "Your workspace" column — spec.md R2). No
// modal — routes straight to the existing dedicated auth pages. Replaces the
// old side-derived getAuthHref/use-side.ts theming (R15: dropped with the
// port).
export const authLinks = {
  distributorSignIn: "/login",
  distributorSignUp: "/signup",
  retailerSignIn: "/buyer/login",
  retailerSignUp: "/buyer/register",
} as const;
