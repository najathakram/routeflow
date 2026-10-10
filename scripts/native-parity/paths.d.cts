export declare const REPO_ROOT: string;
export declare function parityDate(env?: NodeJS.ProcessEnv): string;
export declare function roleDir(role: string, env?: NodeJS.ProcessEnv): string;
export declare function captureFile(
  role: string,
  screen: string,
  state: string,
  surface: "web" | "ios" | "ipad",
  env?: NodeJS.ProcessEnv,
): string;
