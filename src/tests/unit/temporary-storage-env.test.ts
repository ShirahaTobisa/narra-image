import { parseEnv } from "@/lib/env";

const base = { NODE_ENV: "test", AUTH_SECRET: "unit-test-secret", DATABASE_URL: "postgresql://localhost/test" } as const;
const temporary = { ...base, IMAGE_TEMPORARY_STORAGE_ENABLED: "true", IMAGE_STORAGE_MANAGED_ENABLED: "true",
  IMAGE_STORAGE_BACKEND: "local", IMAGE_STORAGE_VOLUME_ID: "00000000-0000-0000-0000-000000000001", IMAGE_STORAGE_PATH: "/data/images" };

it("allows temporary storage only with managed local storage and Canvas off", () => {
  expect(parseEnv(base).IMAGE_TEMPORARY_STORAGE_ENABLED).toBe(false);
  expect(parseEnv(temporary).IMAGE_TEMPORARY_STORAGE_ENABLED).toBe(true);
  for (const change of [{ IMAGE_STORAGE_BACKEND: "s3" }, { IMAGE_STORAGE_MANAGED_ENABLED: "false" }, { CANVAS_ENABLED: "true" }]) {
    expect(() => parseEnv({ ...temporary, ...change })).toThrow("临时存图");
  }
});
