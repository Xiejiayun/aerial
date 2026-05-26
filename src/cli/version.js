import fs from "node:fs";

const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);

export function readPackageVersion(packageJsonUrl = PACKAGE_JSON_URL) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonUrl, "utf8"));
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    throw new Error("missing version field");
  } catch (error) {
    const reason = error?.message || String(error);
    console.warn(`aerial: cannot read package version (${reason}); reporting "unknown"`);
    return "unknown";
  }
}

export function printVersion(packageJsonUrl = PACKAGE_JSON_URL) {
  console.log(readPackageVersion(packageJsonUrl));
}
