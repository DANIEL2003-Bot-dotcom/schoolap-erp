import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runSeed } from '../prisma/seed.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://schoolap:schoolap@localhost:5432/schoolap_test';

export const PASSWORDS = { director: 'Directeur@Test1', teacher: 'Enseignant@Test1' };

export function testConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
    CORS_ORIGINS: 'http://localhost:5173,https://ecole.github.io',
    SIMULATE_OPERATOR_CALLBACK: 'false',
    OPERATOR_CALLBACK_DELAY_MS: '0',
    SIMULATED_PAYMENT_FAILURE_RATE: '0',
    LOG_REQUESTS: 'false',
    ...overrides,
  });
}

export function createPrisma() {
  return new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
}

export async function resetDatabase(prisma) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE sms_logs, transactions, school_fees, grades, attendance, subjects, students, classes, users, schools RESTART IDENTITY CASCADE',
  );
  return runSeed(prisma, {
    log: () => {},
    directorPassword: PASSWORDS.director,
    teacherPassword: PASSWORDS.teacher,
  });
}

/** Application de test : les SMS sont capturés au lieu d'être affichés. */
export function buildApp(prisma, { config = testConfig(), dispatchWebhook } = {}) {
  const printed = [];
  const { app, services } = createApp({
    prisma,
    config,
    overrides: { smsPrint: (text) => printed.push(text), dispatchWebhook },
  });
  return { app, services, config, printed };
}
