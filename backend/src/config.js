import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est obligatoire'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET doit contenir au moins 16 caractères'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  WEBHOOK_SECRET: z.string().min(16, 'WEBHOOK_SECRET doit contenir au moins 16 caractères'),
  SIMULATE_OPERATOR_CALLBACK: bool.default('true'),
  OPERATOR_CALLBACK_DELAY_MS: z.coerce.number().int().min(0).default(4000),
  SIMULATED_PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  SCHOOL_TIMEZONE: z.string().default('Africa/Lubumbashi'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  SMS_SENDER_ID: z.string().max(11).default('ECOLE-RDC'),
  LOG_REQUESTS: bool.default('true'),
});

export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
    throw new Error(`Configuration invalide → ${message}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && e.JWT_SECRET.length < 32) {
    throw new Error('En production, JWT_SECRET doit contenir au moins 32 caractères.');
  }
  return Object.freeze({
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    isTest: e.NODE_ENV === 'test',
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    jwtExpiresIn: e.JWT_EXPIRES_IN,
    corsOrigins: e.CORS_ORIGINS.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean),
    webhookSecret: e.WEBHOOK_SECRET,
    simulateOperatorCallback: e.SIMULATE_OPERATOR_CALLBACK,
    operatorCallbackDelayMs: e.OPERATOR_CALLBACK_DELAY_MS,
    simulatedPaymentFailureRate: e.SIMULATED_PAYMENT_FAILURE_RATE,
    timezone: e.SCHOOL_TIMEZONE,
    trustProxy: e.TRUST_PROXY,
    smsSenderId: e.SMS_SENDER_ID,
    logRequests: e.LOG_REQUESTS,
  });
}
