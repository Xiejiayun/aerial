# Socket reset and Windows service recovery

## Evidence and scope

A Node Socket error with no `error` listener terminates the process. The
client WebSocket upgrade rejection in 0.3.3 writes a 501 response without
installing a socket error listener, after Node has handed socket ownership to
the upgrade handler. The incident log alone does not identify which socket
produced its ECONNRESET, so this change fixes the reproducible failure path
without claiming that it proves the source of the historical incident.

Windows currently registers the service using Task Scheduler defaults: no
failure restart, a 72-hour execution limit, and battery restrictions. The
existing hidden launcher propagates Node's exit status to Task Scheduler.

Native isolated-task testing found that a Node exit code of 1 did not restart
the task within the configured one-minute interval, even with the recovery
settings present in exported task XML. Microsoft's [task scheduling protocol,
section 2.5.4.2](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tsch/2ff4aa5a-7bc4-449f-bbb1-27475645867f)
describes RestartOnFailure as retrying unmet start conditions or action-start
failures. Therefore the PowerShell wrapper must also supervise unsuccessful
Node exits; configuring Task Scheduler alone is insufficient evidence of
runtime crash recovery.

## Changes

- Attach an error listener before the upgrade handler writes any response.
  Log the error through the existing redaction path and destroy that socket.
  Keep the listener for the socket lifetime and preserve the normal 501 reply.
- After successful Windows task registration, update only its settings: retry
  task startup failures every minute, up to 999 attempts; set the execution limit to
  `PT0S`; allow starting on battery and continuing when switching to battery.
  Preserve the task's action, principal, logon trigger, and other settings.
- Keep the Windows wrapper alive after an unsuccessful Node exit, wait one
  minute, and restart Node, with at most 999 retries. A normal exit is final.
  The hidden launcher and PowerShell remain part of the scheduled task while
  waiting, so stopping the task's process tree also stops pending recovery.
- Treat recovery configuration as part of installation. Do not start the task
  if that step fails, surface its stderr, and report a failed definition
  refresh when a service is already running. Reinstall followed by restart is
  required to apply the updated task settings and code to existing installs.

## Verification

Run upgrade error injection in a separate Node process, both while writing
the rejection and after it. ECONNRESET and EPIPE must close the connection,
leave the process alive, and allow a subsequent health request to return 200.
Confirm the original code fails these tests.

Test fresh installation and managed/foreground refresh failure paths. Execute
the generated PowerShell with isolated Task Scheduler command doubles to
verify the final settings and preservation of unrelated values. On a Windows
host with task registration permission, inspect the installed settings and
verify failure restart and intentional stop before release. Run the complete
suite, syntax, package, secret, and release gates before merge and publish.
Test explicit stop both while Node is serving requests and while the wrapper
is waiting to retry, then wait longer than the retry interval to confirm no
new process appears. Exercise the real generated PowerShell with isolated
fixtures for failure-to-success, clean exit, and retry exhaustion.
