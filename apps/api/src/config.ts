export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://kuberaxis:kuberaxis@localhost:5432/kuberaxis",
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "127.0.0.1",
  maxUploadBytes: 25 * 1024 * 1024,
  /** Exposes DELETE /api/data, which wipes all imported data. Development only. */
  allowPurge: process.env.NODE_ENV !== "production",
};
