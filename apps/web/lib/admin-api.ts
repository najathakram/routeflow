import axios from "axios";

const BASE_URL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_API_URL ??
      `${window.location.protocol}//${window.location.hostname}:3000/api/v1`)
    : "http://localhost:3000/api/v1";

export const superAdminClient = axios.create({ baseURL: BASE_URL });

superAdminClient.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("superAdminToken");
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

superAdminClient.interceptors.response.use(
  (r) => r,
  (error) => {
    if (error.response?.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("superAdminToken");
      window.location.href = "/admin/login";
    }
    return Promise.reject(error);
  },
);
