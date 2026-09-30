/**
 * en/es message catalog (home-grown i18n — no runtime dependency).
 *
 * `en` is the source of truth and defines the key set; `es` must cover the same
 * keys (enforced by the `Messages` type). Keys are dotted namespaces. Interpolate
 * with `{name}` placeholders. Coverage grows as screens are rebuilt per phase;
 * this is the Phase-1 foundation set (shell, command palette, undo, re-auth).
 *
 * Customer-facing copy uses each customer's own locale, independent of the
 * operator's — see messaging spec. This catalog is the operator/app UI only.
 */

export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
};

const en = {
  // Common
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.undo": "Undo",
  "common.restored": "Restored",
  "common.search": "Search",
  "common.delete": "Delete",
  "common.loading": "Loading",

  // Undo / re-auth (unified/ux-standards.html)
  "reauth.title": "You've been signed out",
  "reauth.body":
    "Your session timed out. Your work is safe and exactly where you left it. Enter your password to pick up where you left off.",
  "reauth.passwordFor": "Password for {username}",
  "reauth.switch": "Switch account",
  "reauth.unlock": "Unlock and continue",
  "reauth.badPassword": "That password did not match. Try again.",
  "reauth.or": "or",
  "reauth.continueGoogle": "Continue with Google",
  "reauth.forgot": "Forgot password?",
  "reauth.googleUnavailable": "Google sign-in is unavailable right now. Use your password instead.",

  // Top bar / avatar menu
  "topbar.searchPlaceholder": "Search or jump to…",
  "menu.profile": "Profile & Settings",
  "menu.language": "Language / Idioma",
  "menu.signOut": "Sign out",
  "menu.switchToBuyerPortal": "Switch to buyer portal",
  "menu.buyerPortalSignIn": "Buyer portal sign-in",
  "menu.exitImpersonation": "Exit impersonation",
  "menu.returnToAdmin": "Return to admin",

  // Command palette (unified/overlays.html)
  "palette.placeholder": "Search pages, customers, orders, invoices…",
  "palette.jumpTo": "Jump to",
  "palette.actions": "Actions",
  "palette.results": "Results",
  "palette.noResults": "No results for “{query}”",
  "palette.navigate": "navigate",
  "palette.select": "select",
  "palette.shortcuts": "shortcuts",

  // Navigation
  "nav.dashboard": "Dashboard",
  "nav.orders": "Orders",
  "nav.customers": "Customers",
  "nav.settings": "Settings",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

const es: Messages = {
  "common.save": "Guardar",
  "common.cancel": "Cancelar",
  "common.close": "Cerrar",
  "common.undo": "Deshacer",
  "common.restored": "Restaurado",
  "common.search": "Buscar",
  "common.delete": "Eliminar",
  "common.loading": "Cargando",

  "reauth.title": "Se cerró tu sesión",
  "reauth.body":
    "Tu sesión expiró. Tu trabajo está a salvo y justo donde lo dejaste. Escribe tu contraseña para continuar donde quedaste.",
  "reauth.passwordFor": "Contraseña de {username}",
  "reauth.switch": "Cambiar de cuenta",
  "reauth.unlock": "Desbloquear y continuar",
  "reauth.badPassword": "La contraseña no coincide. Inténtalo de nuevo.",
  "reauth.or": "o",
  "reauth.continueGoogle": "Continuar con Google",
  "reauth.forgot": "¿Olvidaste tu contraseña?",
  "reauth.googleUnavailable":
    "Google no está disponible en este momento. Usa tu contraseña en su lugar.",

  "topbar.searchPlaceholder": "Busca o salta a…",
  "menu.profile": "Perfil y ajustes",
  "menu.language": "Idioma / Language",
  "menu.signOut": "Cerrar sesión",
  "menu.switchToBuyerPortal": "Cambiar al portal de compradores",
  "menu.buyerPortalSignIn": "Acceder al portal de compradores",
  "menu.exitImpersonation": "Salir de la suplantación",
  "menu.returnToAdmin": "Volver al panel de administración",

  "palette.placeholder": "Busca páginas, clientes, pedidos, facturas…",
  "palette.jumpTo": "Ir a",
  "palette.actions": "Acciones",
  "palette.results": "Resultados",
  "palette.noResults": "Sin resultados para “{query}”",
  "palette.navigate": "navegar",
  "palette.select": "seleccionar",
  "palette.shortcuts": "atajos",

  "nav.dashboard": "Panel",
  "nav.orders": "Pedidos",
  "nav.customers": "Clientes",
  "nav.settings": "Ajustes",
};

export const MESSAGES: Record<Locale, Messages> = { en, es };
