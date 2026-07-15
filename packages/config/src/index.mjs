function configuredValue(env, name, serviceName) {
  const value = env[name];
  if (!value || value.includes("CHANGE_ME")) {
    throw new Error(`Set ${name} in .env before starting ${serviceName}.`);
  }
  return value;
}

export function databaseConfig(env, serviceName) {
  return {
    url: configuredValue(env, "DATABASE_URL", serviceName),
    ssl: env.DATABASE_SSL === "true" ? "require" : false,
  };
}

export function napcatConfig(env) {
  return {
    wsUrl: configuredValue(env, "NAPCAT_WS_URL", "the QQ gateway"),
    accessToken: env.NAPCAT_ACCESS_TOKEN || "",
    accountId: env.NAPCAT_ACCOUNT_ID || "",
    groupWhitelist: env.NAPCAT_GROUP_WHITELIST || "",
    privateUserWhitelist: env.NAPCAT_PRIVATE_USER_WHITELIST || "",
  };
}

export function positiveInteger(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
