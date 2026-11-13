import { ensureTool } from "./node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js";
const path = await ensureTool("fd", status => console.log(status.type, status.message));
console.log("fd:", path);
