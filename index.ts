import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createPiCaller } from "./extension.ts";

export default function piCaller(pi: ExtensionAPI) {
	createPiCaller(pi, {
		CustomEditor,
		stripTerminalSequences,
		truncateToWidth,
		Type,
	});
}
