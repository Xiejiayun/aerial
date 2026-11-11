import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const psLiteral = value => `'${String(value).replace(/'/g, "''")}'`;

// Node's mode: 0o600 does not restrict Windows ACLs. Protect and verify the
// directory before any credential or temporary session settings are written.
export function ensurePrivateDirectory(directory, { platform = process.platform, run = spawnSync } = {}) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Cowork private directory must be a real directory, not a link.");
  if (platform !== "win32") {
    fs.chmodSync(resolved, 0o700);
    if ((fs.statSync(resolved).mode & 0o777) !== 0o700) throw new Error("Cannot verify Cowork private directory permissions.");
    return resolved;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$coworkDirectory = ${psLiteral(resolved)}`,
    "$coworkSid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$coworkAcl = New-Object Security.AccessControl.DirectorySecurity",
    "$coworkAcl.SetOwner($coworkSid)",
    "$coworkAcl.SetAccessRuleProtection($true, $false)",
    "$coworkRule = New-Object Security.AccessControl.FileSystemAccessRule($coworkSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
    "$coworkAcl.AddAccessRule($coworkRule)",
    "[IO.Directory]::SetAccessControl($coworkDirectory, $coworkAcl)",
    "$coworkActual = [IO.Directory]::GetAccessControl($coworkDirectory)",
    "if (-not $coworkActual.AreAccessRulesProtected -or $coworkActual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $coworkSid.Value) { throw 'Private directory ownership check failed' }",
    "$coworkRules = @($coworkActual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
    "if ($coworkRules.Count -ne 1) { throw 'Unexpected private directory ACL entries' }",
    "$coworkEntry = $coworkRules[0]",
    "if ($coworkEntry.IdentityReference.Value -ne $coworkSid.Value -or $coworkEntry.AccessControlType -ne 'Allow' -or $coworkEntry.IsInherited -or ($coworkEntry.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl -or ($coworkEntry.InheritanceFlags -band 3) -ne 3) { throw 'Private directory ACL verification failed' }"
  ].join("\r\n");
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 15000
  });
  if (result.error || result.status !== 0) throw new Error("Cannot establish and verify a current-user-only Windows ACL for Cowork files.");
  return resolved;
}

export function writePrivateJson(file, value) {
  const resolved = path.resolve(file);
  ensurePrivateDirectory(path.dirname(resolved));
  const existing = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Refusing to replace a linked or non-file Cowork private file.");
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, resolved);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return resolved;
}

export function createPrivateSessionDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cowork-session-"));
  try {
    return ensurePrivateDirectory(directory);
  } catch (error) {
    // At this point the newly created directory is still empty.
    fs.rmdirSync(directory);
    throw error;
  }
}
