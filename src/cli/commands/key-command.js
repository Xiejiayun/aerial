import { ensureApiKey } from "../../shared/config.js";

export function runKeyCli(subcommand) {
  if (subcommand === "generate") {
    const result = ensureApiKey();
    if (result.apiKey) {
      console.log("Local Aerial key generated and stored privately.");
    } else {
      console.log("Aerial API key already configured.");
    }
    return true;
  }
  if (subcommand === "print") {
    const result = ensureApiKey();
    if (result.apiKey) console.log(result.apiKey);
    else throw new Error("Raw API key is not available. Run: aerial key generate");
    return true;
  }
  return false;
}
