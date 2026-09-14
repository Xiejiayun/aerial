// Run with Windows Script Host, not Node. Hiding PowerShell after it starts
// is too late to prevent Windows Terminal from creating a console window.
var shell = new ActiveXObject("WScript.Shell");
var command = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + WScript.Arguments.Item(0) + '"';
// Keep the task running so its instance identifies the root process for stop.
WScript.Quit(shell.Run(command, 0, true));
