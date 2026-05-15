export function logEvent(event, fields = {}) {
  const safeFields = { ...fields };
  delete safeFields.authorization;
  delete safeFields.token;
  delete safeFields.apiKey;
  delete safeFields.body;
  const line = { ts: new Date().toISOString(), event, ...safeFields };
  console.error(JSON.stringify(line));
}
