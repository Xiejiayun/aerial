// This module is a private IPC child, never a command-line token printer.
if (process.send) {
  process.once("disconnect", () => process.exit(1));
  process.once("message", async ({ profile, tenantId, authenticationRecord, interactive }) => {
    let authWindow;
    let reply;
    const withWindow = (operation) => authWindow ? Promise.race([
      operation,
      authWindow.closed.then(({ reason }) => {
        const code = reason === "user" || reason === "aborted" ? "AUTH_CANCELED" : "AUTH_WINDOW_FAILED";
        throw Object.assign(new Error("The Microsoft sign-in owner closed."), { code });
      })
    ]) : operation;
    try {
      process.send({ type: "progress", stage: "loading-sdk" });
      const { InteractiveBrowserCredential, useIdentityPlugin } = await import("@azure/identity");
      const { nativeBrokerPlugin } = await import("@azure/identity-broker");
      useIdentityPlugin(nativeBrokerPlugin);
      if (interactive) {
        process.send({ type: "progress", stage: "opening-window" });
        const { openAuthWindow } = await import("./auth-window.js");
        authWindow = await openAuthWindow();
      }
      process.send({ type: "progress", stage: "creating-credential" });
      const credential = new InteractiveBrowserCredential({
        clientId: profile.clientId, tenantId, authorityHost: profile.authorityHost,
        authenticationRecord,
        disableAutomaticAuthentication: !interactive,
        brokerOptions: { enabled: true, useDefaultBrokerAccount: !interactive,
          parentWindowHandle: authWindow?.handle || Buffer.alloc(process.arch === "ia32" ? 4 : 8) }
      });
      let record = authenticationRecord;
      if (interactive) {
        process.send({ type: "progress", stage: "authenticating" });
        record = await withWindow(credential.authenticate(profile.scope));
      }
      process.send({ type: "progress", stage: "acquiring-token" });
      const token = await withWindow(credential.getToken(profile.scope));
      reply = { type: "token", bearer: token.token, authenticationRecord: record };
    } catch (error) {
      const detail = /AADSTS\d+/.exec(String(error.message))?.[0];
      const code = error.code === "AUTH_CANCELED" ? "AUTH_CANCELED"
        : error.code === "AUTH_WINDOW_FAILED" ? "AUTH_HELPER_FAILED"
        : error.code === "ERR_MODULE_NOT_FOUND" ? "AUTH_DEPENDENCIES_MISSING"
        : error.name === "AuthenticationRequiredError" ? "AUTH_REQUIRED" : "AUTH_DENIED";
      reply = { type: "error", code, ...(detail ? { detail } : {}) };
    } finally {
      try { await authWindow?.close(); }
      catch { reply = { type: "error", code: "AUTH_HELPER_FAILED" }; }
    }
    process.send(reply);
  });
}
