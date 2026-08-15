import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
//#region src/notify.ts
const name = "Ws_completion-notify";
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const TOAST_SCRIPT = join(PACKAGE_ROOT, "scripts", "notify-toast.ps1");
/** Extract the visible text of the last assistant message. */
function extractAnswerText(agent) {
	try {
		const messages = agent.session.deriveMessages();
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			const text = message.content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
			if (text.trim().length > 0) return text.trim();
		}
	} catch {}
	return "";
}
/** Show the Windows balloon notification with an answer excerpt. */
function showToast(text) {
	const excerpt = text.slice(0, 60);
	const encoded = Buffer.from(excerpt, "utf8").toString("base64");
	execFile("powershell.exe", [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		TOAST_SCRIPT
	], { env: {
		...process.env,
		NOTIFY_TEXT: encoded
	} }, () => {});
}
function apply(ctx) {
	let running = false;
	ctx.on("agent/status", ({ agent, status }) => {
		if (status === "running") running = true;
		else if (status === "idle" && running) {
			running = false;
			showToast(extractAnswerText(agent));
		}
	});
}
//#endregion
export { apply, name };
