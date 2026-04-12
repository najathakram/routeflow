// /admin/login → redirect to the canonical admin login page at /admin-login
import { redirect } from "next/navigation";

export default function AdminLoginRedirectPage() {
  redirect("/admin-login");
}
