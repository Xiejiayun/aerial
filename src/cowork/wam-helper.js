// This module is a private IPC child, never a command-line token printer.
if (process.send) {
  process.once("disconnect", () => process.exit(1));
  process.once("message", async ({ profile, tenantId, authenticationRecord, interactive }) => {
    try {
      const { InteractiveBrowserCredential, useIdentityPlugin } = await import("@azure/identity");
      const { nativeBrokerPlugin } = await import("@azure/identity-broker");
      useIdentityPlugin(nativeBrokerPlugin);
      const credential = new InteractiveBrowserCredential({
        clientId: profile.clientId, tenantId, authorityHost: profile.authorityHost,
        authenticationRecord,
        disableAutomaticAuthentication: !interactive,
        brokerOptions: { enabled: true, useDefaultBrokerAccount: !interactive, parentWindowHandle: Buffer.alloc(process.arch === "ia32" ? 4 : 8) }
      });
      let record = authenticationRecord;
      if (interactive) record = await credential.authenticate(profile.scope);
      const token = await credential.getToken(profile.scope);
      process.send({ type: "token", bearer: token.token, authenticationRecord: record });
    } catch (error) {
      const detail = /AADSTS\d+/.exec(String(error.message))?.[0];
      const code = error.code === "ERR_MODULE_NOT_FOUND" ? "AUTH_DEPENDENCIES_MISSING"
        : error.name === "AuthenticationRequiredError" ? "AUTH_REQUIRED" : "AUTH_DENIED";
      process.send({ type: "error", code, ...(detail ? { detail } : {}) });
    }
  });
}
