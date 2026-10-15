import { notifyUser, terminalKind, weztermCli, weztermFocus } from "../src/terminals.mjs";

try {
  const terminal = terminalKind();
  console.log(`Platform: ${process.platform}; terminal: ${terminal}; interactive output: ${!!process.stdout.isTTY}`);
  if (process.platform !== "darwin") {
    console.log("Notifications are only enabled on macOS.");
  } else if (process.argv.includes("--notify")) {
    const result = await notifyUser({
      title: "pi-d · notification test",
      body: "Your agent's reply preview will appear here.",
    });
    console.log(`Notification result: ${result.status} (a request is not a delivery guarantee).`);
  } else if (terminal === "wezterm") {
    console.log(`WezTerm CLI: ${weztermCli()}`);
    console.log(`Chat focus: ${(await weztermFocus()).state}`);
    console.log("No notification or sound was sent.");
  } else if (terminal === "ghostty") {
    console.log("Ghostty manages per-surface notification focus and sound natively.");
    console.log("No notification or sound was sent.");
  } else {
    console.log("Unsupported terminal: the extension will skip notifications.");
  }
} catch (error) {
  // No payloads or command lines in diagnostics.
  console.error(`Focus/notification check failed (${error.code ?? error.name}).`);
  process.exitCode = 1;
}
